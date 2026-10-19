const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("Auxiliary editor windows", () => {
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("creates an empty additional window from the application menu command", async () => {
    const workspace = lumine.workspace;
    const paths = lumine.project.getPaths();
    const openIndependentWindow = spyOn(lumine.application, "openWindow");
    jasmine.attachToDOM(workspace.getElement());
    lumine.commands.dispatch(workspace.getElement(), "window:new-detached-window");
    await conditionPromise(() => workspace.getWindows().length === 2);
    const extra = workspace.getWindows().find((window) => !window.isMain());
    expect(extra.getEditorContainer().getPaneItems()).toEqual([]);
    expect(extra.getElement().getModel()).toBe(workspace);
    expect(extra.getDOMWindow().lumine).toBe(lumine);
    expect(lumine.project.getPaths()).toEqual(paths);
    expect(openIndependentWindow).not.toHaveBeenCalled();
    lumine.commands.dispatch(extra.getElement(), "window:new-detached-window");
    await conditionPromise(() => workspace.getWindows().length === 3);
    expect(openIndependentWindow).not.toHaveBeenCalled();
  });

  it("reports a failed new-window request without an unhandled rejection", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    spyOn(lumine.workspace, "openEditorWindow").and.rejectWith(
      new Error("Native host unavailable"),
    );
    const error = spyOn(lumine.notifications, "addError");
    lumine.commands.dispatch(lumine.workspace.getElement(), "window:new-detached-window");
    await conditionPromise(() => error.calls.count() === 1);
    expect(error).toHaveBeenCalledWith("Unable to open a detached window.", {
      detail: "Native host unavailable",
      dismissable: true,
    });
  });

  it("uses standards-mode geometry for icon-only lines and inline controls", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const mainDocument = workspace.getMainWindow().getDocument();
    const extraDocument = extra.getDocument();
    expect(extraDocument.compatMode).toBe("CSS1Compat");
    expect(extraDocument.compatMode).toBe(mainDocument.compatMode);
    expect(extraDocument.doctype.name).toBe("html");
    expect(extraDocument.body.tabIndex).toBe(-1);
    const samples = [];
    for (const document of [mainDocument, extraDocument]) {
      const sample = document.createElement("div");
      sample.style.cssText =
        "position:absolute;top:100px;left:20px;width:80px;font:16px/32px Arial;";
      const icon = document.createElement("span");
      icon.style.cssText =
        "display:inline-block;width:14px;height:14px;vertical-align:text-bottom;";
      const control = document.createElement("button");
      control.textContent = "Control";
      const iconLine = document.createElement("div");
      iconLine.append(icon);
      const controlLine = document.createElement("div");
      controlLine.append(control);
      sample.append(iconLine, controlLine);
      document.body.append(sample);
      samples.push({ sample, icon, control });
    }
    try {
      const geometry = ({ sample, icon, control }) => {
        const root = sample.getBoundingClientRect();
        const relative = (element) => {
          const bounds = element.getBoundingClientRect();
          return [bounds.x - root.x, bounds.y - root.y, bounds.width, bounds.height];
        };
        return [root.height, relative(icon), relative(control)];
      };
      expect(geometry(samples[1])).toEqual(geometry(samples[0]));
    } finally {
      for (const { sample } of samples) sample.remove();
    }
  });

  it("aligns matching status-bar icons and text across presentation documents", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    const service = (
      await lumine.packages.activatePackage("status-bar")
    ).mainModule.provideStatusBar();
    const extra = await workspace.openEditorWindow({ show: false });
    const samples = [];
    const tiles = [];
    try {
      for (const window of [workspace.getMainWindow(), extra]) {
        const document = window.getDocument();
        const bar = service.forWindow(window);
        const icon = document.createElement("status-bar-tile");
        icon.className = "icon icon-light-bulb is-icon-only";
        const text = document.createElement("status-bar-tile");
        text.textContent = "Status";
        tiles.push(bar.addRightTile({ item: icon }), bar.addRightTile({ item: text }));
        samples.push({ document, bar, icon, text });
      }
      for (const { icon } of samples) icon.getBoundingClientRect();
      await Promise.all(samples.map(({ document }) => document.fonts.ready));
      const geometry = ({ bar, icon, text }) => {
        const root = bar.element.getBoundingClientRect();
        return [icon, text].map((item) => {
          const bounds = item.getBoundingClientRect();
          return [bounds.top - root.top, bounds.height];
        });
      };
      expect(geometry(samples[1])).toEqual(geometry(samples[0]));
    } finally {
      for (const tile of tiles) tile.destroy();
    }
  });

  it("presents live panes and reattaches a split layout without duplicating models", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("unsaved shared document");
    const pane = workspace.paneForItem(editor);
    const element = editor.getElement();
    const window = await workspace.detachPane(pane);
    expect(window.isMain()).toBeFalse();
    expect(pane.getContainer()).toBe(window.getEditorContainer());
    expect(element.ownerDocument).toBe(window.getDocument());
    expect(window.getDocument().defaultView.opener).toBe(globalThis.window);
    expect(workspace.getTextEditors()).toEqual([editor]);
    const second = pane.splitDown({ activate: false });
    const copy = editor.copy();
    second.activateItem(copy, { activatePane: true });
    copy.setText("edited in additional window");
    expect(editor.getText()).toBe("edited in additional window");
    copy.undo();
    expect(editor.getText()).toBe("unsaved shared document");
    await workspace.attachWindow(window);
    expect(workspace.getWindows()).toEqual([workspace.getMainWindow()]);
    expect(workspace.getMainWindow().getEditorContainer().getPanes()).toEqual([pane, second]);
    expect(editor.getElement()).toBe(element);
    expect(copy.getBuffer()).toBe(editor.getBuffer());
    expect(element.ownerDocument).toBe(document);
    if (require("../src/get-window-load-settings")().offscreen) {
      expect(await lumine.window.isVisible()).toBe(false);
    }
  });

  it("honors logo clicks while the visible detached pane is finishing its window operation", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    await lumine.packages.activatePackage("title-bar");
    const editor = await workspace.open();
    editor.setText("Attach from the first click");
    const pane = workspace.paneForItem(editor);
    const element = editor.getElement();
    let releaseFocus, visible;
    const focusGate = new Promise((resolve) => (releaseFocus = resolve));
    const visibleWindow = new Promise((resolve) => (visible = resolve));
    const open = workspace.openEditorWindow.bind(workspace);
    spyOn(workspace, "openEditorWindow").and.callFake(async (...args) => {
      const extra = await open(...args);
      const focus = extra.focus.bind(extra);
      spyOn(extra, "focus").and.callFake(async () => {
        visible(extra);
        await focusGate;
        return focus();
      });
      return extra;
    });
    const detach = workspace.detachPane(pane);
    try {
      const extra = await visibleWindow;
      expect(workspace.windowOperations.has(workspace.getMainWindow())).toBeTrue();
      expect(pane.getContainer()).toBe(extra.getEditorContainer());
      const attach = spyOn(workspace, "attachWindow").and.callThrough();
      const release = spyOn(workspace, "releaseEditorWindow").and.callThrough();
      const logo = extra.getElement().querySelector(".app-icon");
      const bounds = logo.getBoundingClientRect();
      const target = extra
        .getDocument()
        .elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
      target.click();
      target.click();
      const requests = attach.calls
        .all()
        .map(({ returnValue }) => returnValue.catch((error) => error));
      expect(requests.length).toBe(2);
      expect(pane.getContainer()).toBe(extra.getEditorContainer());
      releaseFocus();
      await detach;
      expect(await Promise.all(requests)).toEqual([
        workspace.getMainWindow(),
        workspace.getMainWindow(),
      ]);
      expect(release).toHaveBeenCalledOnceWith(extra);
      expect(workspace.getMainWindow().getEditorContainer().getPanes()).toContain(pane);
      expect(editor.getElement()).toBe(element);
      expect(element.ownerDocument).toBe(document);
      expect(editor.getText()).toBe("Attach from the first click");
    } finally {
      releaseFocus();
      await detach;
    }
  });

  it("keeps an attach request after an earlier main-window operation fails", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    const editor = await workspace.open();
    editor.setText("Keep the queued document");
    const extra = await workspace.detachItem(editor);
    let finish;
    const gate = new Promise((resolve) => (finish = resolve));
    const error = new Error("Earlier operation failed");
    const preceding = workspace
      .runWindowOperation([workspace.getMainWindow()], async () => {
        await gate;
        throw error;
      })
      .catch((error) => error);
    const attach = workspace.attachWindow(extra);
    finish();
    expect(await preceding).toBe(error);
    expect(await attach).toBe(workspace.getMainWindow());
    expect(workspace.getMainWindow().getEditorContainer().getPaneItems()).toContain(editor);
    expect(editor.getText()).toBe("Keep the queued document");
  });

  it("restores unsaved models and the split layout after an unexpected native close", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("recover unsaved content");
    const pane = workspace.paneForItem(editor);
    const root = editor.getElement();
    const extra = await workspace.detachPane(pane);
    const sibling = pane.splitRight({ items: [editor.copy()] });
    const copy = sibling.getActiveItem();
    copy.setCursorBufferPosition([0, 0]);
    copy.insertText("still shared ");
    await extra.windowService.close();
    await conditionPromise(() => extra.isDestroyed());
    expect(workspace.getWindows()).toEqual([workspace.getMainWindow()]);
    expect(workspace.getMainWindow().getEditorContainer().getPanes()).toEqual([pane, sibling]);
    expect(editor.getElement()).toBe(root);
    expect(root.ownerDocument).toBe(document);
    expect(copy.getBuffer()).toBe(editor.getBuffer());
    expect(editor.getText()).toBe("still shared recover unsaved content");
    copy.undo();
    expect(editor.getText()).toBe("recover unsaved content");
  });

  for (const cleanup of ["discard", "reset", "discard after focus rejects"]) {
    it(`drains recovery before ${cleanup} even after its lost source window has been released`, async () => {
      const workspace = lumine.workspace;
      const editor = await workspace.open();
      const extra = await workspace.detachItem(editor);
      const main = workspace.getMainWindow();
      let enterFocus, releaseFocus;
      const entered = new Promise((resolve) => (enterFocus = resolve));
      const gate = new Promise((resolve, reject) => {
        releaseFocus =
          cleanup === "discard after focus rejects"
            ? () => reject(new Error("The native focus request failed"))
            : resolve;
      });
      spyOn(main, "focus").and.callFake(() => {
        enterFocus();
        return gate;
      });
      await extra.windowService.close();
      await entered;
      const recovery = workspace.windowOperations.get(main);
      let settled = false;
      const discard = (
        cleanup === "reset" ? lumine.reset() : workspace.discardEditorWindows()
      ).then(() => (settled = true));
      try {
        await flushMicrotasks();
        expect(extra.isDestroyed()).toBe(true);
        expect(workspace.getWindows()).toEqual([main]);
        expect(workspace.windowOperations.has(main)).toBe(true);
        expect(settled).toBe(false);
        await expectAsync(workspace.runWindowOperation([main], () => {})).toBeRejectedWithError(
          "The workspace windows are preparing to unload.",
        );
        await expectAsync(workspace.openEditorWindow()).toBeRejectedWithError(
          "The workspace windows are preparing to unload.",
        );
      } finally {
        releaseFocus();
        await recovery.catch(() => {});
        await discard;
      }
      expect(workspace.windowOperations.size).toBe(0);
      expect(workspace.windowLifecycleChanging).toBe(false);
      expect(workspace.getMainWindow().getDocument()).toBe(document);
    });
  }

  it("keeps documents accessible when a lost host prevents a presentation checkpoint", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("authoritative unsaved content");
    const extra = await workspace.detachItem(editor);
    const warning = spyOn(lumine.notifications, "addWarning").and.callThrough();
    editor.prepareWindowChange = () => {
      throw new Error("the old frame is unavailable");
    };
    await extra.windowService.close();
    await conditionPromise(() => extra.isDestroyed());
    await workspace.whenWindowOperationsIdle({ prepareToUnload: false });
    expect(workspace.getMainWindow().getEditorContainer().getPaneItems()).toContain(editor);
    expect(editor.getText()).toBe("authoritative unsaved content");
    expect(editor.getElement().ownerDocument).toBe(document);
    expect(warning.calls.mostRecent().args[1].detail).toContain("the old frame is unavailable");
    delete editor.prepareWindowChange;
  });

  it("retires late native presentation updates while refusing a dialog on a closed host", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    const extra = await workspace.detachItem(editor);
    const service = extra.windowService;
    await service.close();
    await conditionPromise(() => extra.isDestroyed());
    await expectAsync(service.invoke("setTitle", "late title")).toBeResolved();
    await expectAsync(service.invoke("setRepresentedFilename", "late path")).toBeResolved();
    await expectAsync(service.invoke("showSaveDialog", {})).toBeRejectedWithError(/has closed/);
    expect((await service.getState()).visible).toBe(false);
  });

  it("captures local save and close targets even when another window is globally active", async () => {
    const workspace = lumine.workspace;
    const main = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const other = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(other, { activatePane: true });
    const save = spyOn(main, "save").and.resolveTo();
    const otherSave = spyOn(other, "save").and.resolveTo();
    spyOn(main, "getURI").and.returnValue("main-document");
    spyOn(other, "getURI").and.returnValue("other-document");
    lumine.commands.dispatch(workspace.getMainWindow().getElement(), "core:save");
    expect(save).toHaveBeenCalledTimes(1);
    expect(otherSave).not.toHaveBeenCalled();
    lumine.commands.dispatch(workspace.getMainWindow().getElement(), "core:close");
    await conditionPromise(() => main.isDestroyed());
    expect(other.isDestroyed()).toBeFalse();
    expect(workspace.getCenter().getActivePaneItem()).toBe(other);
  });

  it("restores several physical layouts with one shared unsaved buffer and separate view state", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("one\ntwo\nthree");
    editor.setCursorBufferPosition([1, 1]);
    const extra = await workspace.openEditorWindow({ show: false });
    const copy = editor.copy();
    copy.setCursorBufferPosition([2, 2]);
    extra.getEditorContainer().getActivePane().activateItem(copy, { activatePane: true });
    const state = lumine.serialize({ isUnloading: true });
    expect(state.project.buffers).toHaveSize(1);
    expect(state.workspace.paneContainers.center.windows).toHaveSize(1);
    const id = extra.persistentId;
    await lumine.deserialize(state);
    const windows = workspace.getWindows();
    expect(windows).toHaveSize(2);
    const mainEditor = workspace.getMainWindow().getEditorContainer().getActivePaneItem();
    const extraWindow = windows.find((window) => !window.isMain());
    const extraEditor = extraWindow.getEditorContainer().getActivePaneItem();
    expect(extraWindow.persistentId).toBe(id);
    expect(extraEditor.getBuffer()).toBe(mainEditor.getBuffer());
    expect(extraEditor.getText()).toBe("one\ntwo\nthree");
    expect(mainEditor.getCursorBufferPosition().toArray()).toEqual([1, 1]);
    expect(extraEditor.getCursorBufferPosition().toArray()).toEqual([2, 2]);
    expect(extraEditor.getElement().ownerDocument).toBe(extraWindow.getDocument());
    expect(workspace.getActiveTextEditor()).toBe(extraEditor);
  });

  it("dispatches a keyboard command once through its own document root", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const received = [];
    const binding = lumine.keymaps.add("detached-test", {
      "lumine-workspace": { f16: "detached:test-command" },
    });
    const command = lumine.commands.add("lumine-workspace", "detached:test-command", (event) =>
      received.push(event.context),
    );
    try {
      const domWindow = extra.getDOMWindow();
      const event = new domWindow.KeyboardEvent("keydown", {
        key: "F16",
        code: "F16",
        bubbles: true,
        cancelable: true,
      });
      extra.getDocument().body.dispatchEvent(event);
      expect(received).toHaveSize(1);
      expect(received[0].window).toBe(extra);
      expect(event.defaultPrevented).toBeTrue();
    } finally {
      command.dispose();
      binding.dispose();
    }
  });

  it("detaches one exact tab and preserves the other tabs' order", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    const second = await workspace.open(undefined, { forceNew: true });
    const third = await workspace.open(undefined, { forceNew: true });
    const pane = workspace.paneForItem(first);
    const element = second.getElement();
    const attached = [];
    second.didAttachToWindow = ({ document }) => attached.push(document);
    const extra = await workspace.detachItem(second);
    expect(pane.getItems()).toEqual([first, third]);
    expect(extra.getEditorContainer().getPaneItems()).toEqual([second]);
    expect(second.getElement()).toBe(element);
    expect(element.ownerDocument).toBe(extra.getDocument());
    expect(attached).toEqual([extra.getDocument()]);
    await workspace.movePaneItem(second, { targetPane: pane, index: 1 });
    expect(pane.getItems()).toEqual([first, second, third]);
    expect(attached).toEqual([extra.getDocument(), document]);
  });

  it("restores the exact tab and its view after a destination presentation failure", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    const pane = workspace.paneForItem(editor);
    const extra = await workspace.openEditorWindow({ show: false });
    editor.prepareWindowChange = () => ({ scroll: 23 });
    editor.didChangeWindow = ({ state, rollback }) => {
      expect(state).toEqual({ scroll: 23 });
      if (!rollback) throw new Error("unable to mount");
    };
    await expectAsync(
      workspace.movePaneItem(editor, { targetPane: extra.getEditorContainer().getActivePane() }),
    ).toBeRejectedWithError("unable to mount");
    expect(editor.isDestroyed()).toBeFalse();
    expect(pane.getItems()).toEqual([editor]);
    expect(editor.getElement().ownerDocument).toBe(document);
    expect(extra.getEditorContainer().getPaneItems()).toEqual([]);
  });

  it("waits for a dragged tab's presentation preparation before inserting and releasing its session", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("Retain the exact dragged document");
    const remaining = await workspace.open(undefined, { forceNew: true });
    const sourcePane = workspace.paneForItem(editor);
    sourcePane.activateItem(editor, { activatePane: true });
    const element = editor.getElement();
    const extra = await workspace.openEditorWindow({ show: false });
    const targetPane = extra.getEditorContainer().getActivePane();
    const first = workspace.buildTextEditor();
    const last = workspace.buildTextEditor();
    targetPane.addItem(first, { index: 0 });
    targetPane.addItem(last, { index: 1 });
    targetPane.activateItem(last);
    const scope = lumine.paneItemTransfers.createScope();
    const descriptor = scope.createTransfer(sourcePane, editor);
    const record = lumine.workspaceDrops.getSession(descriptor.token);
    let enterPrepare, releasePrepare;
    const entered = new Promise((resolve) => (enterPrepare = resolve));
    const gate = new Promise((resolve) => (releasePrepare = resolve));
    editor.prepareWindowChange = () => {
      enterPrepare();
      return gate;
    };
    let settled = false;
    const operation = scope.performDrop(
      { pane: targetPane, surface: "tab-bar", index: 1, resolvePane: () => targetPane },
      scope.prepareDrop(descriptor, targetPane),
    );
    const completion = operation.then(
      (result) => {
        settled = true;
        return { result };
      },
      (error) => {
        settled = true;
        return { error };
      },
    );
    try {
      await entered;
      expect(settled).toBeFalse();
      expect(workspace.paneForItem(editor)).toBe(sourcePane);
      expect(sourcePane.getItems()).toEqual([editor, remaining]);
      expect(targetPane.getItems()).toEqual([first, last]);
      expect(element.ownerDocument).toBe(document);
      expect(lumine.workspaceDrops.getSession(descriptor.token)).toBe(record);
      expect(workspace.windowOperations.has(workspace.getMainWindow())).toBeTrue();
      expect(workspace.windowOperations.has(extra)).toBeTrue();
      releasePrepare();
      expect(await completion).toEqual({ result: { pane: targetPane, item: editor } });
      expect(sourcePane.getItems()).toEqual([remaining]);
      expect(targetPane.getItems()).toEqual([first, editor, last]);
      expect(targetPane.getActiveItem()).toBe(editor);
      expect(workspace.getActivePane()).toBe(targetPane);
      expect(editor.getElement()).toBe(element);
      expect(element.ownerDocument).toBe(extra.getDocument());
      expect(editor.getText()).toBe("Retain the exact dragged document");
      expect(lumine.workspaceDrops.getSession(descriptor.token)).toBeUndefined();
      expect(workspace.windowOperations.size).toBe(0);
    } finally {
      releasePrepare();
      await completion;
      await workspace.whenWindowOperationsIdle({ prepareToUnload: false });
      delete editor.prepareWindowChange;
      scope.dispose();
    }
  });

  it("rejects a dragged tab's failed presentation and settles its session after restoring the source", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("Keep the source after a failed drop");
    const sourcePane = workspace.paneForItem(editor);
    const element = editor.getElement();
    const extra = await workspace.openEditorWindow({ show: false });
    const targetPane = extra.getEditorContainer().getActivePane();
    const targetEditor = workspace.buildTextEditor();
    targetPane.activateItem(targetEditor);
    const scope = lumine.paneItemTransfers.createScope();
    const descriptor = scope.createTransfer(sourcePane, editor);
    const record = lumine.workspaceDrops.getSession(descriptor.token);
    const failure = new Error("The dragged view could not attach");
    editor.prepareWindowChange = () => ({ scroll: 23 });
    editor.didChangeWindow = jasmine.createSpy("didChangeWindow").and.callFake(({ rollback }) => {
      if (!rollback) throw failure;
    });
    try {
      await expectAsync(
        scope.performDrop(
          { pane: targetPane, surface: "tab-bar", index: 0, resolvePane: () => targetPane },
          scope.prepareDrop(descriptor, targetPane),
        ),
      ).toBeRejectedWith(failure);
      expect(await record.completion).toBeFalse();
      expect(editor.isDestroyed()).toBeFalse();
      expect(workspace.paneForItem(editor)).toBe(sourcePane);
      expect(sourcePane.getItems()).toEqual([editor]);
      expect(sourcePane.getActiveItem()).toBe(editor);
      expect(targetPane.getItems()).toEqual([targetEditor]);
      expect(targetPane.getActiveItem()).toBe(targetEditor);
      expect(editor.getElement()).toBe(element);
      expect(element.ownerDocument).toBe(document);
      expect(editor.getText()).toBe("Keep the source after a failed drop");
      expect(editor.didChangeWindow).toHaveBeenCalledTimes(2);
      expect(editor.didChangeWindow.calls.mostRecent().args[0]).toEqual(
        jasmine.objectContaining({ rollback: true, state: { scroll: 23 } }),
      );
      expect(lumine.workspaceDrops.getSession(descriptor.token)).toBeUndefined();
      expect(scope.sessions.has(descriptor.token)).toBeFalse();
      expect(workspace.windowOperations.size).toBe(0);
    } finally {
      delete editor.prepareWindowChange;
      delete editor.didChangeWindow;
      scope.dispose();
    }
  });

  it("asks once for a document when every one of its views is closing", async () => {
    lumine.config.set("core.promptOnCloseDirtyBuffer", true);
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("unsaved document");
    editor.shouldPromptToSave.and.callThrough();
    const extra = await workspace.openEditorWindow({ show: false });
    extra.getEditorContainer().getActivePane().activateItem(editor.copy());
    const mainConfirm = spyOn(workspace.getMainWindow(), "confirm").and.resolveTo(2);
    const extraConfirm = spyOn(extra, "confirm").and.resolveTo(2);
    expect(editor.getFileState()).not.toBe("unmodified");
    expect(
      editor.shouldPromptToSave({
        lastView: true,
        windowCloseRequested: true,
        projectHasPaths: false,
      }),
    ).toBeTrue();
    expect(workspace.paneForItem(editor).getContainer().getWindow()).toBe(
      workspace.getMainWindow(),
    );
    expect(
      await workspace.confirmClose({ windowCloseRequested: true, projectHasPaths: false }),
    ).toBeTrue();
    expect(mainConfirm).toHaveBeenCalledTimes(1);
    expect(extraConfirm).not.toHaveBeenCalled();
  });

  it("closes an additional view silently while its dirty document stays open elsewhere", async () => {
    lumine.config.set("core.promptOnCloseDirtyBuffer", true);
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("keep these edits");
    editor.shouldPromptToSave.and.callThrough();
    const extra = await workspace.openEditorWindow({ show: false });
    const copy = editor.copy();
    extra.getEditorContainer().getActivePane().activateItem(copy);
    const confirm = spyOn(extra, "confirm").and.resolveTo(1);
    expect(await extra.close()).toBeTrue();
    expect(confirm).not.toHaveBeenCalled();
    expect(copy.isDestroyed()).toBeTrue();
    expect(editor.getText()).toBe("keep these edits");
    expect(editor.isDestroyed()).toBeFalse();
  });

  for (const backgroundWarning of [false, true]) {
    it(`restores unavailable native windows' unsaved tabs into main before deserializing views${backgroundWarning ? " while another service notifies" : ""}`, async () => {
      const workspace = lumine.workspace;
      const editor = await workspace.open();
      editor.setText("preserve a failed host's document");
      const extra = await workspace.detachPane(workspace.paneForItem(editor));
      const state = lumine.serialize({ isUnloading: true });
      const notifications = workspace.notificationManager;
      const windowNotifications = jasmine.createSpyObj("window notifications", ["addWarning"]);
      const globalWarning = spyOn(lumine.notifications, "addWarning");
      const publishBackgroundWarning = jasmine.createSpy("background service").and.callFake(() =>
        lumine.notifications.addWarning("Background service changed", {
          detail: "independent of window restoration",
        }),
      );
      spyOn(workspace, "openEditorWindow").and.callFake(async () => {
        if (backgroundWarning) publishBackgroundWarning();
        throw new Error("native host unavailable");
      });
      // Observe the window owner's dependency, so a project watcher or another
      // service cannot alter the recovery-warning count while deserialize awaits I/O.
      workspace.notificationManager = windowNotifications;
      try {
        await lumine.deserialize(state);
        expect(extra.isDestroyed()).toBeTrue();
        expect(workspace.getWindows()).toEqual([workspace.getMainWindow()]);
        expect(workspace.getTextEditors()).toHaveSize(1);
        expect(workspace.getActiveTextEditor().getText()).toBe("preserve a failed host's document");
        expect(windowNotifications.addWarning).toHaveBeenCalledTimes(1);
        expect(windowNotifications.addWarning).toHaveBeenCalledWith(
          "An editor window could not be restored. Its tabs were restored in the main window.",
          { detail: "native host unavailable" },
        );
        if (backgroundWarning) {
          expect(publishBackgroundWarning).toHaveBeenCalledTimes(1);
          expect(globalWarning).toHaveBeenCalledWith("Background service changed", {
            detail: "independent of window restoration",
          });
        } else {
          expect(publishBackgroundWarning).not.toHaveBeenCalled();
        }
      } finally {
        workspace.notificationManager = notifications;
      }
    });
  }

  it("holds the source layout while an asynchronous presentation is prepared", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    const pane = workspace.paneForItem(editor);
    let complete;
    editor.prepareWindowChange = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const transfer = workspace.detachPane(pane);
    await conditionPromise(() => complete);
    expect(() => pane.splitRight()).toThrowError(/completing a pane operation/);
    expect(() => pane.destroy()).toThrowError(/completing a pane operation/);
    expect(editor.isDestroyed()).toBeFalse();
    complete();
    const extra = await transfer;
    expect(workspace.paneForItem(editor).getContainer()).toBe(extra.getEditorContainer());
  });

  it("hosts modal input and independent breadcrumb trails in the requested windows", async () => {
    const workspace = lumine.workspace;
    const extra = await workspace.openEditorWindow({ show: false });
    const main = workspace.getMainWindow();
    const mainHost = workspace.addInputDialog({ prompt: "Main" }, { window: main });
    const extraHost = workspace.addInputDialog({ prompt: "Extra" }, { window: extra });
    try {
      await mainHost.show({ query: "main query" });
      await extraHost.show({ query: "extra query" });
      expect(mainHost.getPanel().getElement().ownerDocument).toBe(document);
      expect(extraHost.getPanel().getElement().ownerDocument).toBe(extra.getDocument());
      expect(extraHost.getModel().getQueryEditor().getElement().ownerDocument).toBe(
        extra.getDocument(),
      );
      expect(mainHost.isVisible()).toBeTrue();
      expect(extraHost.isVisible()).toBeTrue();
      expect(mainHost.getModel().getQuery()).toBe("main query");
      expect(extraHost.getModel().getQuery()).toBe("extra query");
      expect(extra.getModalFlow()).not.toBe(main.getModalFlow());
    } finally {
      await mainHost.destroy();
      await extraHost.destroy();
    }
  });

  it("shows and cancels tooltips in their anchor's physical document", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const button = extra.getDocument().createElement("button");
    button.textContent = "Tooltip anchor";
    extra.getElement().append(button);
    const registration = lumine.tooltips.add(button, { title: "Local tooltip", delay: 0 });
    try {
      const tooltip = lumine.tooltips.findTooltips(button)[0];
      tooltip.show();
      expect(tooltip.getTooltipElement().ownerDocument).toBe(extra.getDocument());
      expect(extra.getDocument().body.querySelector(".tooltip")).toBe(tooltip.getTooltipElement());
      const domWindow = extra.getDOMWindow();
      extra.getDocument().body.dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true }));
      expect(tooltip.getTooltipElement().classList.contains("in")).toBeFalse();
    } finally {
      registration.dispose();
    }
  });
  it("uses an independent setting for closing an empty detached window", async () => {
    const workspace = lumine.workspace;
    const main = workspace.getMainWindow();
    const extra = await workspace.openEditorWindow({ show: false });
    const mainClose = spyOn(main, "close").and.resolveTo(true);
    const extraClose = spyOn(extra, "close").and.resolveTo(true);
    lumine.config.set("core.closeEmptyWindows", true);
    lumine.config.set("core.closeEmptyDetachedWindows", false);
    lumine.commands.dispatch(extra.getElement(), "core:close");
    expect(extraClose).not.toHaveBeenCalled();
    lumine.commands.dispatch(main.getElement(), "core:close");
    expect(mainClose).toHaveBeenCalledTimes(1);
    lumine.config.set("core.closeEmptyWindows", false);
    lumine.config.set("core.closeEmptyDetachedWindows", true);
    lumine.commands.dispatch(extra.getElement(), "core:close");
    expect(extraClose).toHaveBeenCalledTimes(1);
    lumine.commands.dispatch(main.getElement(), "core:close");
    expect(mainClose).toHaveBeenCalledTimes(1);
  });

  it("toggles developer tools on the dispatch window", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    expect(extra.getDOMWindow().lumine).toBe(lumine);
    expect(extra.getDOMWindow().editorWindow).toBe(extra);
    expect(extra.getDOMWindow().require).toBe(window.require);
    expect(extra.getDOMWindow().process).toBe(window.process);
    const toggle = spyOn(extra.windowService, "toggleDevTools").and.resolveTo();
    const mainToggle = spyOn(lumine.window, "toggleDevTools").and.resolveTo();
    lumine.commands.dispatch(extra.getElement(), "window:toggle-dev-tools");
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(mainToggle).not.toHaveBeenCalled();
  });
  it("binds late presentation participants once and removes their transfer participation", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    const root = document.createElement("div");
    const item = {
      canCopy: () => false,
      getTitle: () => "Component owner",
      getElement: () => root,
    };
    await workspace.open(item);
    const component = document.createElement("div");
    root.append(component);
    const bound = [];
    const changed = [];
    const disposed = jasmine.createSpy("prepared state disposal");
    const registration = lumine.views.addWindowParticipant(component, {
      didAttachToWindow: (context) => bound.push(context.window),
      prepareWindowChange: () => ({ value: "checkpoint", dispose: disposed }),
      didChangeWindow: (context) => changed.push(context),
    });
    expect(bound).toEqual([workspace.getMainWindow()]);
    const extra = await workspace.detachPane(workspace.paneForItem(item));
    expect(bound).toEqual([workspace.getMainWindow(), extra]);
    expect(changed).toHaveSize(1);
    expect(changed[0].state.value).toBe("checkpoint");
    expect(component.ownerDocument).toBe(extra.getDocument());
    expect(disposed).toHaveBeenCalledTimes(1);
    registration.dispose();
    await workspace.attachWindow(extra);
    expect(changed).toHaveSize(1);
    expect(disposed).toHaveBeenCalledTimes(1);
  });
  it("keeps dock commands on the global editing item while bar and root commands remain local", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    const mainEditor = await workspace.open();
    const extra = await workspace.openEditorWindow({ show: false });
    const extraEditor = workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(extraEditor, { activatePane: true });
    const root = document.createElement("div");
    const panel = {
      element: root,
      getTitle: () => "Global navigation",
      getAllowedLocations: () => ["left"],
    };
    const dockPane = workspace.getLeftDock().getPanes()[0];
    dockPane.activateItem(panel, { activatePane: true });
    const context = workspace.resolveCommandContext(root);
    expect(context.window).toBe(workspace.getMainWindow());
    expect(context.pane).toBe(dockPane);
    expect(context.documentPane).toBe(extra.getEditorContainer().getActivePane());
    expect(context.fileEditor).toBe(extraEditor);
    expect(workspace.resolveCommandContext(workspace.getMainWindow().getElement()).fileEditor).toBe(
      mainEditor,
    );
    spyOn(extraEditor, "getURI").and.returnValue("extra-document");
    const saved = spyOn(extraEditor, "save").and.resolveTo();
    const mainSave = spyOn(mainEditor, "save").and.resolveTo();
    lumine.commands.dispatch(root, "core:save");
    expect(saved).toHaveBeenCalledTimes(1);
    expect(mainSave).not.toHaveBeenCalled();
  });
  it("rebinds text editor observers and releases the cursor timer from its original window", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    const editor = await workspace.open();
    const component = editor.getElement().getComponent();
    component.startCursorBlinking();
    const originalHandle = component.cursorBlinkIntervalHandle;
    const originalWindow = component.cursorBlinkWindow;
    const cancel = spyOn(originalWindow, "clearInterval").and.callThrough();
    const extra = await workspace.detachPane(workspace.paneForItem(editor));
    expect(cancel).toHaveBeenCalledWith(originalHandle);
    expect(component.blockDecorationWindow).toBe(extra.getDOMWindow());
    expect(component.resizeObserver instanceof extra.getDOMWindow().ResizeObserver).toBeTrue();
    component.startCursorBlinking();
    expect(component.cursorBlinkWindow).toBe(extra.getDOMWindow());
    component.stopCursorBlinking();
    await workspace.attachWindow(extra);
    expect(component.blockDecorationWindow).toBe(window);
  });

  it("defers outside-dialog clicks on the dialog's own window frame", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const host = lumine.workspace.addInputDialog({ prompt: "Local frame" }, { window: extra });
    await host.show();
    const frames = [];
    spyOn(extra.getDOMWindow(), "requestAnimationFrame").and.callFake((callback) =>
      frames.push(callback),
    );
    const mainFrame = spyOn(window, "requestAnimationFrame").and.callThrough();
    const cancel = spyOn(host, "cancel").and.callThrough();
    host.didPointerDown({ target: extra.getDocument().body });
    expect(frames.length).toBe(1);
    expect(mainFrame).not.toHaveBeenCalled();
    frames[0]();
    expect(cancel).toHaveBeenCalledOnceWith("click-outside");
    await host.destroy();
  });

  it("opens a tree file in main after its empty pane takes focus following tab-menu detachment", async () => {
    const workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    await lumine.packages.activatePackage("tabs");
    const treePackage = await lumine.packages.activatePackage("tree-view");
    lumine.project.setPaths([__dirname]);
    const editor = await workspace.open(__filename);
    const pane = workspace.paneForItem(editor);
    const tab = pane.getElement().querySelector(".tab.active");
    const popup = lumine.contextMenu.show(tab, lumine.contextMenu.templateForElement(tab));
    const menuItem = popup.rootList.items.find((item) => item.template.command === "pane:detach");
    expect(menuItem).toBeDefined();
    const detach = spyOn(workspace, "detachPane").and.callThrough();
    menuItem.activate();
    await conditionPromise(() => detach.calls.count() === 1);
    const extra = await detach.calls.mostRecent().returnValue;
    const main = workspace.getMainWindow().getEditorContainer();
    expect(main.getPaneItems()).toEqual([]);
    expect(workspace.getCenter().getActivePane().getContainer()).toBe(extra.getEditorContainer());
    if (process.env.CI) {
      // A click in the main window first transfers native focus. DOM focus
      // alone leaves the detached window's asynchronous focus request pending.
      await workspace.getMainWindow().focus();
      await require("../src/focus-test-window")();
    }
    const emptyPane = main.getActivePane();
    emptyPane.getElement().focus();
    expect(workspace.getCenter().getActivePane()).toBe(emptyPane);
    const target = require("node:path").join(__dirname, "scroll-mode-spec.js");
    const tree = treePackage.mainModule.getTreeViewInstance();
    await tree.revealPath(target, { show: true, focus: false });
    const entry = tree.entryForPath(target);
    expect(tree.treeEntryForElement(entry).kind).toBe("file");
    await tree.fileViewEntryClicked({ target: entry, detail: 1 });
    expect(main.getPaneItems().map((item) => item.getPath())).toContain(target);
    expect(extra.getEditorContainer().getPaneItems()).toEqual([editor]);
  });
});
