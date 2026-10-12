const PaneContainer = require("../src/pane-container");
const transferPaneLayout = require("../src/pane-window-transfer");

describe("Pane window transfer", () => {
  let workspace, center, source, target;

  beforeEach(() => {
    workspace = lumine.workspace;
    center = workspace.getCenter();
    source = center.paneContainer;
    target = new PaneContainer(center.params);
    center.addPaneContainer(target);
  });

  afterEach(() => {
    target.destroy();
    center.removePaneContainer(target);
  });

  it("moves exact panes and documents without publishing another document instance", async () => {
    const editor = await workspace.open();
    editor.setText("shared document");
    const pane = workspace.paneForItem(editor);
    const observed = [];
    const observation = workspace.observeTextEditors((item) => observed.push(item));
    const destroyed = jasmine.createSpy("destroyed");
    editor.onDidDestroy(destroyed);
    const root = editor.getElement();
    await transferPaneLayout(workspace, source, target, [pane]);

    expect(target.getActivePane()).toBe(pane);
    expect(pane.getActiveItem()).toBe(editor);
    expect(editor.getElement()).toBe(root);
    expect(workspace.paneForItem(editor)).toBe(pane);
    expect(observed.filter((item) => item === editor)).toEqual([editor]);
    expect(destroyed).not.toHaveBeenCalled();
    expect(source.getPanes().length).toBe(1);
    expect(source.getPaneItems()).toEqual([]);
    observation.dispose();
  });

  it("reattaches a complete layout with independent views of the shared buffer", async () => {
    const editor = await workspace.open();
    const first = workspace.paneForItem(editor);
    const second = first.splitDown({ activate: false });
    const copy = editor.copy();
    second.activateItem(copy, { activatePane: true });
    await transferPaneLayout(workspace, source, target, [first, second]);
    expect(target.getRoot().getOrientation()).toBe("vertical");
    expect(center.getActivePane()).toBe(second);
    await transferPaneLayout(workspace, target, source, [first, second]);
    expect(source.getPanes()).toEqual([first, second]);
    expect(source.getRoot().getOrientation()).toBe("vertical");
    expect(copy.getBuffer()).toBe(editor.getBuffer());
  });

  it("restores source ownership and document state after a presentation failure", async () => {
    const editor = await workspace.open();
    editor.setText("unsaved contents");
    const pane = workspace.paneForItem(editor);
    editor.prepareWindowChange = () => ({ test: "captured" });
    editor.didChangeWindow = ({ rollback, state }) => {
      expect(state).toEqual({ test: "captured" });
      if (!rollback) throw new Error("mount failed");
    };
    await expectAsync(transferPaneLayout(workspace, source, target, [pane])).toBeRejectedWithError(
      "mount failed",
    );
    expect(pane.getContainer()).toBe(source);
    expect(source.getPanes()).toContain(pane);
    expect(source.itemRegistry.hasItem(editor)).toBeTrue();
    expect(target.itemRegistry.hasItem(editor)).toBeFalse();
    expect(editor.getText()).toBe("unsaved contents");
    expect(editor.isDestroyed()).toBeFalse();
  });

  it("rejects a changed source layout before committing an asynchronous preparation", async () => {
    const editor = await workspace.open();
    const pane = workspace.paneForItem(editor);
    let complete;
    editor.prepareWindowChange = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const operation = transferPaneLayout(workspace, source, target, [pane]);
    pane.splitRight({ activate: false });
    complete();
    await expectAsync(operation).toBeRejectedWithError(/changed while/);
    expect(pane.getContainer()).toBe(source);
    expect(target.getPaneItems()).toEqual([]);
    expect(editor.isDestroyed()).toBeFalse();
  });
});
