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

  it("returns a detached pane to a flat row beside an empty pane", async () => {
    const editor = await workspace.open();
    const first = workspace.paneForItem(editor);
    const empty = first.splitRight();
    const returned = empty.splitRight({ items: [editor.copy()] });
    const view = returned.getElement();
    const itemView = returned.getActiveItem().getElement();
    jasmine.attachToDOM(source.getElement());

    await transferPaneLayout(workspace, source, target, [returned]);
    await transferPaneLayout(workspace, target, source, [returned]);

    expect(source.getRoot().getChildren()).toEqual([first, empty, returned]);
    expect(empty.getElement().nextElementSibling.localName).toBe("lumine-pane-resize-handle");
    expect(empty.getElement().nextElementSibling.nextElementSibling).toBe(view);
    expect(returned.getActiveItem().getElement()).toBe(itemView);
    expect(source.getActivePane()).toBe(returned);

    await transferPaneLayout(workspace, source, target, [returned]);
    await transferPaneLayout(workspace, target, source, [returned]);
    expect(source.getRoot().getChildren()).toEqual([first, empty, returned]);
  });

  it("preserves each window's width and internal ratios when joining horizontal rows", async () => {
    const editor = await workspace.open();
    const first = workspace.paneForItem(editor);
    const second = first.splitRight();
    const third = second.splitRight({ items: [editor.copy()] });
    const fourth = third.splitRight();
    first.setFlexScale(3);
    second.setFlexScale(1);
    third.setFlexScale(2);
    fourth.setFlexScale(6);
    await transferPaneLayout(workspace, source, target, [third, fourth]);
    source.getRoot().setFlexScale(2);
    target.getRoot().setFlexScale(3);

    await transferPaneLayout(workspace, target, source, [third, fourth]);

    expect(source.getRoot().getChildren()).toEqual([first, second, third, fourth]);
    expect(source.getPanes().map((pane) => pane.getFlexScale())).toEqual([1.5, 0.5, 0.75, 2.25]);
  });

  it("keeps vertical layouts and collapsed pane widths when joining windows", async () => {
    const editor = await workspace.open();
    const first = workspace.paneForItem(editor);
    const second = first.splitRight();
    const third = second.splitRight({ items: [editor.copy()] });
    const fourth = third.splitDown();
    await transferPaneLayout(workspace, source, target, [third, fourth]);
    first.setFlexScale(0);
    second.setFlexScale(2);
    third.setFlexScale(3);
    fourth.setFlexScale(1);

    await transferPaneLayout(workspace, target, source, [third, fourth]);

    const children = source.getRoot().getChildren();
    expect(children.slice(0, 2)).toEqual([first, second]);
    expect(children[2].getOrientation()).toBe("vertical");
    expect(children[2].getChildren()).toEqual([third, fourth]);
    expect(first.getFlexScale()).toBe(0);
    expect(second.getFlexScale()).toBe(1);
    expect([third.getFlexScale(), fourth.getFlexScale()]).toEqual([3, 1]);
  });

  it("restores both layouts and their original widths after a failed return", async () => {
    const editor = await workspace.open();
    const first = workspace.paneForItem(editor);
    const second = first.splitRight();
    const returnedItem = editor.copy();
    const returned = second.splitRight({ items: [returnedItem] });
    await transferPaneLayout(workspace, source, target, [returned]);
    first.setFlexScale(3);
    second.setFlexScale(1);
    returned.setFlexScale(2);
    returnedItem.didChangeWindow = ({ rollback }) => {
      if (!rollback) throw new Error("mount failed");
    };

    await expectAsync(
      transferPaneLayout(workspace, target, source, [returned]),
    ).toBeRejectedWithError("mount failed");

    expect(source.getRoot().getChildren()).toEqual([first, second]);
    expect(target.getRoot()).toBe(returned);
    expect([first.getFlexScale(), second.getFlexScale(), returned.getFlexScale()]).toEqual([
      3, 1, 2,
    ]);
    expect(returned.getContainer()).toBe(target);
    expect(target.itemRegistry.hasItem(returnedItem)).toBeTrue();
    expect(source.itemRegistry.hasItem(returnedItem)).toBeFalse();
  });

  it("retains pane resizing performed while a return is being prepared", async () => {
    const editor = await workspace.open();
    const first = workspace.paneForItem(editor);
    const second = first.splitRight();
    const returnedItem = editor.copy();
    const returned = second.splitRight({ items: [returnedItem] });
    await transferPaneLayout(workspace, source, target, [returned]);
    let complete;
    returnedItem.prepareWindowChange = () =>
      new Promise((resolve) => {
        complete = resolve;
      });

    const operation = transferPaneLayout(workspace, target, source, [returned]);
    source.getRoot().setFlexScale(2);
    first.setFlexScale(3);
    second.setFlexScale(1);
    returned.setFlexScale(4);
    complete();
    await operation;

    expect(source.getRoot().getChildren()).toEqual([first, second, returned]);
    expect(source.getPanes().map((pane) => pane.getFlexScale())).toEqual([1.5, 0.5, 4]);
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

  it("attempts every rollback and preparation disposal after a failed presentation", async () => {
    const first = await workspace.open();
    const second = await workspace.open(undefined, { forceNew: true });
    const pane = workspace.paneForItem(first);
    const firstDispose = jasmine.createSpy("firstDispose");
    const secondDispose = jasmine.createSpy("secondDispose");
    first.prepareWindowChange = () => ({ dispose: firstDispose });
    second.prepareWindowChange = () => ({ dispose: secondDispose });
    first.didChangeWindow = ({ rollback }) => {
      throw new Error(rollback ? "rollback failed" : "mount failed");
    };
    const rolledBack = jasmine.createSpy("rolledBack");
    second.didChangeWindow = ({ rollback }) => {
      if (rollback) rolledBack();
    };
    let failure;
    try {
      await transferPaneLayout(workspace, source, target, [pane]);
    } catch (error) {
      failure = error;
    }
    expect(failure.errors.map((error) => error.message)).toEqual([
      "mount failed",
      "rollback failed",
    ]);
    expect(rolledBack).toHaveBeenCalledTimes(1);
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
    expect(pane.getItems()).toEqual([first, second]);
    expect(pane.getContainer()).toBe(source);
  });
});
