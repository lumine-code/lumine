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
});
