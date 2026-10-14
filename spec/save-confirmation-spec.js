const fs = require("fs");
const path = require("path");
const EditorWindow = require("../src/editor-window");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const { SaveCancelledError } = require("../src/pane");

describe("Save confirmation", () => {
  const confirmation = {
    message: "Save changes to this example?",
    detail: "Saving replaces the original example. Use Save As to keep a separate copy.",
  };
  const originalText = "print('original example')\n";
  const changedText = "print('changed example')\n";
  let directory, filePath, editor, buffer;
  let editors, buffers, windows, subscriptions, operations;

  beforeEach(async () => {
    jasmine.useRealClock();
    editors = [];
    buffers = [];
    windows = [];
    subscriptions = [];
    operations = [];
    directory = fs.mkdtempSync(path.join(__dirname, "fixtures", "save-confirmation-"));
    filePath = path.join(directory, "example.py");
    fs.writeFileSync(filePath, originalText);
    editor = await lumine.workspace.open(filePath);
    editors.push(editor);
    buffer = editor.getBuffer();
    await buffer.getFileWatchStartPromise();
    editor.setSaveConfirmation(confirmation);
    editor.setText(changedText);
  });

  afterEach(async () => {
    lumine.notifications.clear();
    for (const window of windows) window.destroy();
    for (const subscription of subscriptions) subscription.dispose();
    for (const ownedEditor of editors) ownedEditor.destroy();
    for (const ownedBuffer of buffers) ownedBuffer.destroy();
    await Promise.allSettled(operations);
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  function startSave(action) {
    const notification = new Promise((resolve) => {
      const subscription = lumine.notifications.onDidAddNotification((added) => {
        if (added.getMessage() !== confirmation.message) return;
        subscription.dispose();
        resolve(added);
      });
      subscriptions.push(subscription);
    });
    const operation = Promise.resolve().then(action);
    // Some lifecycle events cancel before the spec gets to its rejection assertion.
    operation.catch(() => {});
    operations.push(operation);
    return { operation, notification };
  }

  function click(notification, text) {
    const button = notification.getOptions().buttons.find((entry) => entry.text === text);
    expect(button).toBeDefined();
    button.onDidClick();
  }

  function makeWindow() {
    const presentation = new EditorWindow({
      workspace: lumine.workspace,
      editorContainer: { editorWindow: null },
      windowService: { getId: () => 123 },
    });
    windows.push(presentation);
    return presentation;
  }

  function expectOriginalFile() {
    expect(fs.readFileSync(filePath, "utf8")).toBe(originalText);
  }

  it("shares a copied confirmation configuration between the editor and its buffer", () => {
    const configuration = { ...confirmation };
    editor.setSaveConfirmation(configuration);
    configuration.message = "Changed externally";
    expect(editor.getSaveConfirmation()).toEqual(confirmation);
    expect(buffer.getSaveConfirmation()).toEqual(confirmation);

    editor.getSaveConfirmation().detail = "Changed externally";
    buffer.getSaveConfirmation().message = "Changed externally";
    expect(editor.getSaveConfirmation()).toEqual(confirmation);

    buffer.setSaveConfirmation({ message: "Confirm this save" });
    expect(editor.getSaveConfirmation()).toEqual({ message: "Confirm this save" });
    editor.setSaveConfirmation(null);
    expect(buffer.getSaveConfirmation()).toBeNull();
  });

  it("waits for Save before writing and asks again on a later save", async () => {
    const first = startSave(() => editor.save());
    const notification = await first.notification;
    expect(notification.getType()).toBe("warning");
    expect(notification.getDetail()).toBe(confirmation.detail);
    expect(notification.isDismissable()).toBeTrue();
    expect(notification.getOptions().buttons.map((button) => button.text)).toEqual([
      "Save",
      "Cancel",
    ]);
    expectOriginalFile();

    click(notification, "Save");
    await first.operation;
    expect(notification.isDismissed()).toBeTrue();
    expect(fs.readFileSync(filePath, "utf8")).toBe(changedText);
    expect(editor.getFileState()).toBe("unmodified");
    expect(editor.getSaveConfirmation()).toEqual(confirmation);

    editor.setText("print('another change')\n");
    const second = startSave(() => editor.save());
    const secondNotification = await second.notification;
    expect(secondNotification).not.toBe(notification);
    click(secondNotification, "Cancel");
    await expectAsync(second.operation).toBeRejectedWithError(SaveCancelledError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(changedText);
  });

  it("keeps the original file and dirty contents when Cancel is selected", async () => {
    const saving = startSave(() => editor.save());
    const notification = await saving.notification;
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expectOriginalFile();
    expect(editor.getText()).toBe(changedText);
    expect(editor.getFileState()).toBe("modified");
    expect(notification.isDismissed()).toBeTrue();
  });

  for (const dismissal of ["dismiss", "clear"]) {
    it(`cancels a pending save when notifications ${dismissal}`, async () => {
      const saving = startSave(() => editor.save());
      const notification = await saving.notification;
      if (dismissal === "dismiss") notification.dismiss();
      else lumine.notifications.clear();
      await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
      expectOriginalFile();
      expect(editor.getFileState()).toBe("modified");
    });
  }

  it("allows ordinary saving after the confirmation is cleared", async () => {
    editor.setSaveConfirmation(null);
    const added = jasmine.createSpy("added");
    subscriptions.push(lumine.notifications.onDidAddNotification(added));
    await editor.save();
    expect(fs.readFileSync(filePath, "utf8")).toBe(changedText);
    expect(added).not.toHaveBeenCalled();
  });

  it("protects direct buffer saves and falls back to the main window without focus", async () => {
    spyOn(lumine.workspace, "getFocusedWindow").and.returnValue(null);
    const saving = startSave(() => buffer.save());
    const notification = await saving.notification;
    expect(notification.getOptions().window).toBe(lumine.workspace.getMainWindow());
    expectOriginalFile();
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
  });

  it("routes direct buffer confirmation to the focused window", async () => {
    const focused = makeWindow();
    spyOn(lumine.workspace, "getFocusedWindow").and.returnValue(focused);
    const saving = startSave(() => buffer.save());
    const notification = await saving.notification;
    expect(notification.getOptions().window).toBe(focused);
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expectOriginalFile();
  });

  it("routes editor confirmation to its owning window even when another is focused", async () => {
    const owner = makeWindow();
    spyOn(lumine.workspace.paneForItem(editor).getContainer(), "getWindow").and.returnValue(owner);
    spyOn(lumine.workspace, "getFocusedWindow").and.returnValue(lumine.workspace.getMainWindow());
    const saving = startSave(() => editor.save());
    const notification = await saving.notification;
    expect(notification.getOptions().window).toBe(owner);
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expectOriginalFile();
  });

  it("keeps confirmation when saving through a second editor sharing the buffer", async () => {
    const copy = editor.copy();
    editors.push(copy);
    lumine.workspace.getActivePane().splitRight({ items: [copy] });
    expect(copy.getBuffer()).toBe(buffer);
    expect(copy.getSaveConfirmation()).toEqual(confirmation);
    const saving = startSave(() => copy.save());
    const notification = await saving.notification;
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expectOriginalFile();
    expect(editor.getFileState()).toBe("modified");
  });

  it("coalesces concurrent editor and buffer saves into one confirmation and one write", async () => {
    const copy = editor.copy();
    editors.push(copy);
    const added = jasmine.createSpy("added");
    const saved = jasmine.createSpy("saved");
    subscriptions.push(lumine.notifications.onDidAddNotification(added), buffer.onDidSave(saved));

    const first = startSave(() => editor.save());
    const notification = await first.notification;
    const second = copy.save();
    const third = buffer.save();
    second.catch(() => {});
    third.catch(() => {});
    operations.push(second, third);
    await Promise.resolve();
    expect(added).toHaveBeenCalledTimes(1);
    expectOriginalFile();
    click(notification, "Save");
    await Promise.all([first.operation, second, third]);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(filePath, "utf8")).toBe(changedText);
  });

  it("preserves protection after serializing and restoring the buffer and editor", async () => {
    const bufferState = JSON.parse(JSON.stringify(buffer.serialize()));
    const editorState = JSON.parse(JSON.stringify(editor.serialize()));
    const restoredBuffer = await TextBuffer.deserialize(bufferState);
    buffers.push(restoredBuffer);
    const restoredEditor = TextEditor.deserialize(editorState, {
      assert: lumine.assert,
      project: { bufferForIdSync: () => restoredBuffer },
    });
    editors.push(restoredEditor);
    expect(restoredEditor.getSaveConfirmation()).toEqual(confirmation);
    const saving = startSave(() => restoredEditor.save());
    const notification = await saving.notification;
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expectOriginalFile();
  });

  it("also requires confirmation when Save As targets the original path", async () => {
    const saving = startSave(() => editor.saveAs(filePath));
    const notification = await saving.notification;
    expectOriginalFile();
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expectOriginalFile();
    expect(editor.getPath()).toBe(filePath);
    expect(editor.getFileState()).toBe("modified");
  });

  it("saves a separate copy without confirmation and clears protection after success", async () => {
    const copyPath = path.join(directory, "my-example.py");
    const added = jasmine.createSpy("added");
    subscriptions.push(lumine.notifications.onDidAddNotification(added));
    await editor.saveAs(copyPath);
    expectOriginalFile();
    expect(fs.readFileSync(copyPath, "utf8")).toBe(changedText);
    expect(editor.getPath()).toBe(copyPath);
    expect(editor.getSaveConfirmation()).toBeNull();
    expect(added).not.toHaveBeenCalled();

    editor.setText("print('my own changes')\n");
    await editor.save();
    expect(fs.readFileSync(copyPath, "utf8")).toBe("print('my own changes')\n");
    expect(added).not.toHaveBeenCalled();
  });

  it("retains protection if saving a separate copy fails", async () => {
    const invalidPath = path.join(directory, "a-directory");
    fs.mkdirSync(invalidPath);
    await expectAsync(editor.saveAs(invalidPath)).toBeRejected();
    expectOriginalFile();
    expect(editor.getPath()).toBe(filePath);
    expect(editor.getSaveConfirmation()).toEqual(confirmation);
    expect(editor.getFileState()).toBe("modified");
  });

  it("cancels a pending save when the backing path changes", async () => {
    const saving = startSave(() => editor.save());
    const notification = await saving.notification;
    const newPath = path.join(directory, "renamed.py");
    buffer.setPath(newPath);
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expect(notification.isDismissed()).toBeTrue();
    click(notification, "Save");
    expectOriginalFile();
    expect(fs.existsSync(newPath)).toBeFalse();
  });

  it("does not let an earlier confirmation overwrite a newly changed backing file", async () => {
    const saving = startSave(() => editor.save());
    const notification = await saving.notification;
    const whenConflicted = new Promise((resolve) => {
      const subscription = buffer.onDidChangeFileState((state) => {
        if (state !== "conflicted") return;
        subscription.dispose();
        resolve();
      });
      subscriptions.push(subscription);
    });
    const externalText = "print('changed by another process')\n";
    fs.writeFileSync(filePath, externalText);
    await whenConflicted;

    click(notification, "Save");
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(externalText);
    expect(editor.getText()).toBe(changedText);
    expect(editor.getFileState()).toBe("conflicted");
    expect(editor.getSaveConfirmation()).toEqual(confirmation);
  });

  it("cancels a pending save when its buffer is destroyed", async () => {
    const saving = startSave(() => buffer.save());
    const notification = await saving.notification;
    buffer.destroy();
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expect(notification.isDismissed()).toBeTrue();
    click(notification, "Save");
    expectOriginalFile();
  });

  it("cancels a pending save when the notification's window is destroyed", async () => {
    const owner = makeWindow();
    spyOn(lumine.workspace.paneForItem(editor).getContainer(), "getWindow").and.returnValue(owner);
    const saving = startSave(() => editor.save());
    const notification = await saving.notification;
    owner.destroy();
    await expectAsync(saving.operation).toBeRejectedWithError(SaveCancelledError);
    expect(notification.isDismissed()).toBeTrue();
    click(notification, "Save");
    expectOriginalFile();
    expect(editor.getFileState()).toBe("modified");
  });

  for (const command of ["core:save", "window:save-all"]) {
    it(`quietly cancels ${command} while keeping the dirty item open`, async () => {
      const pane = lumine.workspace.paneForItem(editor);
      spyOn(pane, "handleSaveError");
      const saving = startSave(() =>
        lumine.commands.dispatch(lumine.workspace.getElement(), command),
      );
      const notification = await saving.notification;
      click(notification, "Cancel");
      await expectAsync(saving.operation).toBeResolved();
      expect(pane.handleSaveError).not.toHaveBeenCalled();
      expectOriginalFile();
      expect(pane.getItems()).toContain(editor);
      expect(editor.getFileState()).toBe("modified");
    });
  }

  it("saves ordinary files through Save All while a protected file is awaiting confirmation", async () => {
    const ordinaryPath = path.join(directory, "ordinary.py");
    fs.writeFileSync(ordinaryPath, "ordinary original\n");
    const ordinary = await lumine.workspace.open(ordinaryPath);
    editors.push(ordinary);
    ordinary.setText("ordinary changed\n");
    const saving = startSave(() => lumine.workspace.saveAll());
    const notification = await saving.notification;
    expectOriginalFile();
    click(notification, "Save");
    await saving.operation;
    expect(fs.readFileSync(filePath, "utf8")).toBe(changedText);
    expect(fs.readFileSync(ordinaryPath, "utf8")).toBe("ordinary changed\n");
    expect(editor.getFileState()).toBe("unmodified");
    expect(ordinary.getFileState()).toBe("unmodified");
  });

  it("cancels Pane Save As without reporting a write error", async () => {
    const pane = lumine.workspace.paneForItem(editor);
    const owner = pane.getContainer().getWindow();
    spyOn(owner, "showSaveDialog").and.returnValue(Promise.resolve({ canceled: false, filePath }));
    spyOn(pane, "handleSaveError");
    const saving = startSave(() => pane.saveItemAs(editor));
    const notification = await saving.notification;
    click(notification, "Cancel");
    await expectAsync(saving.operation).toBeResolved();
    expect(pane.handleSaveError).not.toHaveBeenCalled();
    expectOriginalFile();
    expect(pane.getItems()).toContain(editor);
    expect(editor.getFileState()).toBe("modified");
  });

  it("keeps a dirty item open when its save during close is cancelled", async () => {
    const pane = lumine.workspace.paneForItem(editor);
    const owner = pane.getContainer().getWindow();
    jasmine.unspy(TextEditor.prototype, "shouldPromptToSave");
    spyOn(owner, "confirm").and.returnValue(Promise.resolve(0));
    spyOn(pane, "handleSaveError");
    const closing = startSave(() => pane.destroyItem(editor));
    const notification = await closing.notification;
    click(notification, "Cancel");
    expect(await closing.operation).toBeFalse();
    expect(owner.confirm).toHaveBeenCalledTimes(1);
    expect(pane.handleSaveError).not.toHaveBeenCalled();
    expect(pane.getItems()).toContain(editor);
    expect(editor.isDestroyed()).toBeFalse();
    expect(editor.getFileState()).toBe("modified");
    expectOriginalFile();
  });

  it("writes confirmed changes before closing a dirty item", async () => {
    const pane = lumine.workspace.paneForItem(editor);
    const owner = pane.getContainer().getWindow();
    jasmine.unspy(TextEditor.prototype, "shouldPromptToSave");
    spyOn(owner, "confirm").and.returnValue(Promise.resolve(0));
    const closing = startSave(() => pane.destroyItem(editor));
    const notification = await closing.notification;
    expectOriginalFile();
    click(notification, "Save");
    expect(await closing.operation).toBeTrue();
    expect(pane.getItems()).not.toContain(editor);
    expect(editor.isDestroyed()).toBeTrue();
    expect(fs.readFileSync(filePath, "utf8")).toBe(changedText);
  });
});
