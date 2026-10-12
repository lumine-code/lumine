const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("Auxiliary editor windows", () => {
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
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

  it("restores unavailable native windows' unsaved tabs into main before deserializing views", async () => {
    const workspace = lumine.workspace;
    const editor = await workspace.open();
    editor.setText("preserve a failed host's document");
    const extra = await workspace.detachPane(workspace.paneForItem(editor));
    const state = lumine.serialize({ isUnloading: true });
    spyOn(workspace, "openEditorWindow").and.rejectWith(new Error("native host unavailable"));
    const warning = spyOn(lumine.notifications, "addWarning");
    await lumine.deserialize(state);
    expect(extra.isDestroyed()).toBeTrue();
    expect(workspace.getWindows()).toEqual([workspace.getMainWindow()]);
    expect(workspace.getTextEditors()).toHaveSize(1);
    expect(workspace.getActiveTextEditor().getText()).toBe("preserve a failed host's document");
    expect(warning).toHaveBeenCalledTimes(1);
  });

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
});
