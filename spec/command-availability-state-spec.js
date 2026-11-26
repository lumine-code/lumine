describe("command availability follows model state", () => {
  let registrations;
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    registrations = [];
  });
  afterEach(() => registrations.forEach((entry) => entry.dispose()));

  it("keeps Save and Save As disabled without a saveable center item", async () => {
    const workspace = lumine.workspace.getElement();
    expect(lumine.commands.canDispatch(workspace, "core:save")).toBe(false);
    expect(lumine.commands.canDispatch(workspace, "core:save-as")).toBe(false);
    const editor = await lumine.workspace.open();
    editor.setReadOnly(true);
    expect(lumine.commands.canDispatch(editor.getElement(), "core:paste")).toBe(false);
    expect(lumine.commands.canDispatch(workspace, "core:save")).toBe(true);
    expect(lumine.commands.canDispatch(workspace, "core:save-as")).toBe(true);
  });

  it("checks the file conflict when a deferred core:save is ready to write", async () => {
    lumine.config.set("core.promptOnSaveConflictedFile", true);
    const pane = lumine.workspace.getActivePane();
    const confirm = spyOn(pane.getContainer().getWindow(), "confirm").and.resolveTo(0);
    const pendingEdit = Promise.withResolvers();
    let fileState = "unmodified";
    const write = jasmine.createSpy("write");
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Queued document",
      getURI: () => "custom://pending",
      getFileState: () => fileState,
      save: jasmine.createSpy("ordinary save"),
      saveWithPreflight: jasmine.createSpy("deferred save").and.callFake(async (beforeSave) => {
        await pendingEdit.promise;
        await beforeSave();
        write();
      }),
    };
    pane.addItem(item);

    const saving = lumine.commands.dispatch(lumine.workspace.element, "core:save");
    expect(item.saveWithPreflight).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    fileState = "conflicted";
    pendingEdit.resolve();
    await expectAsync(saving).toBeResolved();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(item.save).not.toHaveBeenCalled();
  });

  it("requires a path for copying and a known repository for Checkout HEAD", async () => {
    const editor = await lumine.workspace.open();
    expect(lumine.commands.canDispatch(editor.getElement(), "editor:copy-path")).toBe(false);
    expect(lumine.commands.canDispatch(editor.getElement(), "editor:checkout-head-revision")).toBe(
      false,
    );
    editor
      .getBuffer()
      .setPath(
        require("path").join(lumine.project.getPaths()[0] || process.cwd(), "availability.txt"),
      );
    expect(lumine.commands.canDispatch(editor.getElement(), "editor:copy-path")).toBe(true);
  });

  it("publishes path, grammar, readonly and selection state without reading text", async () => {
    const editor = await lumine.workspace.open();
    await globalThis.flushMicrotasks();
    const changes = jasmine.createSpy("availability changes");
    registrations.push(lumine.commands.onDidChange(changes));
    const text = spyOn(editor, "getText").and.callThrough();
    editor.setReadOnly(true);
    await globalThis.flushMicrotasks();
    expect(changes).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    changes.calls.reset();
    editor.getBuffer().setPath(require("path").join(process.cwd(), "different-path.txt"));
    await globalThis.flushMicrotasks();
    expect(changes).toHaveBeenCalled();
  });

  it("keeps local changes targeted and leaves registration changes global", () => {
    const changes = jasmine.createSpy("availability changes");
    registrations.push(lumine.commands.onDidChange(changes));
    const target = document.createElement("div");
    lumine.commands.invalidateAvailability({ target });
    expect(changes).toHaveBeenCalledWith({ target });
    changes.calls.reset();
    lumine.commands.invalidateAvailability();
    expect(changes).toHaveBeenCalledWith(undefined);
  });

  it("invalidates Save All when a non-active custom pane item is added", async () => {
    const pane = lumine.workspace.getActivePane();
    await lumine.workspace.open();
    await globalThis.flushMicrotasks();
    const changes = jasmine.createSpy("custom pane item added");
    registrations.push(lumine.commands.onDidChange(changes));
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Custom modified document",
      getURI: () => "custom://modified",
      getFileState: () => "modified",
      save() {},
    };
    pane.addItem(item, { activateItem: false });
    await globalThis.flushMicrotasks();
    expect(changes).toHaveBeenCalled();
    expect(lumine.commands.canDispatch(lumine.workspace.element, "window:save-all")).toBeTrue();
  });

  for (const command of ["window:save-all", "pane:save-items"]) {
    it(`honors delayed file conflict checks for pending changes through ${command}`, async () => {
      lumine.config.set("core.promptOnSaveConflictedFile", true);
      const pane = lumine.workspace.getActivePane();
      const target = command === "pane:save-items" ? pane.getElement() : lumine.workspace.element;
      const overwrite = command === "pane:save-items";
      const confirm = spyOn(pane.getContainer().getWindow(), "confirm").and.resolveTo(
        overwrite ? 0 : 1,
      );
      const reportError = spyOn(pane, "handleSaveError");
      const pendingEdit = Promise.withResolvers();
      let fileState = "unmodified";
      let pending = true;
      const write = jasmine.createSpy("write");
      const item = {
        element: document.createElement("div"),
        getTitle: () => "Queued document",
        getURI: () => "custom://pending",
        getFileState: () => fileState,
        hasPendingChanges: () => pending,
        save: jasmine.createSpy("ordinary save"),
        savePendingChanges: jasmine.createSpy("queued save").and.callFake(async (beforeSave) => {
          await pendingEdit.promise;
          await beforeSave();
          write();
          fileState = "unmodified";
        }),
      };
      pane.addItem(item, { activateItem: false });

      expect(lumine.commands.canDispatch(target, command)).toBeTrue();
      const saving = lumine.commands.dispatch(target, command);
      expect(item.savePendingChanges).toHaveBeenCalledTimes(1);
      expect(confirm).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      fileState = "conflicted";
      pending = false;
      pendingEdit.resolve();
      await expectAsync(saving).toBeResolved();
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(overwrite ? 1 : 0);
      expect(item.save).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    });
  }

  it("selects pending items only when their save route is available", async () => {
    const pane = lumine.workspace.getActivePane();
    const owner = pane.getContainer().getWindow();
    const showSaveDialog = spyOn(owner, "showSaveDialog").and.resolveTo({ filePath: "chosen.txt" });
    const pendingItem = {
      getFileState: () => "unmodified",
      hasPendingChanges: () => true,
      savePendingChanges: jasmine.createSpy("queued save"),
    };
    const saveAs = jasmine.createSpy("save as");
    const save = jasmine.createSpy("save");
    pane.addItem({
      ...pendingItem,
      element: document.createElement("div"),
      getURI: () => "custom://save-as-only",
      saveAs,
    });
    pane.addItem({
      ...pendingItem,
      element: document.createElement("div"),
      getURI: () => null,
      save,
    });
    expect(lumine.commands.canDispatch(pane.getElement(), "pane:save-items")).toBeFalse();
    expect(lumine.commands.canDispatch(lumine.workspace.element, "window:save-all")).toBeFalse();
    await expectAsync(pane.saveItems()).toBeResolvedTo([]);
    expect(save).not.toHaveBeenCalled();
    expect(saveAs).not.toHaveBeenCalled();

    pane.addItem({
      ...pendingItem,
      element: document.createElement("div"),
      getURI: () => null,
      getPath: () => null,
      saveAs,
    });
    expect(lumine.commands.canDispatch(pane.getElement(), "pane:save-items")).toBeTrue();
    expect(lumine.commands.canDispatch(lumine.workspace.element, "window:save-all")).toBeTrue();
    await pane.saveItems();
    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(saveAs).toHaveBeenCalledOnceWith("chosen.txt");
    expect(pendingItem.savePendingChanges).not.toHaveBeenCalled();
  });

  it("tolerates custom pane items whose optional subscription methods return nothing", () => {
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Custom pane item",
      onDidChangeFileState() {},
      onDidChangeURI() {},
      onDidDestroy() {},
    };
    expect(() => lumine.workspace.commandAvailabilityObserver.observeItem(item)).not.toThrow();
  });

  it("matches the new grammar scope before the next view render", async () => {
    const editor = await lumine.workspace.open();
    const target = editor.getElement();
    registrations.push(
      lumine.commands.add("lumine-text-editor[data-grammar~='availability']", {
        "state-spec:grammar": () => {},
      }),
    );
    expect(lumine.commands.canDispatch(target, "state-spec:grammar")).toBe(false);
    const NullLanguageMode = require("../src/null-language-mode");
    editor.getBuffer().setLanguageMode(
      new NullLanguageMode({
        buffer: editor.getBuffer(),
        grammar: { ...require("../src/null-grammar"), scopeName: "source.availability" },
      }),
    );
    expect(lumine.commands.canDispatch(target, "state-spec:grammar")).toBe(true);
  });
});
