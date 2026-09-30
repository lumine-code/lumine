const { buildKeydownEvent } = require("./keymap-spec-helpers/helpers");

describe("closing the focused surface", () => {
  let centerItem;

  beforeEach(async () => {
    await lumine.reset();
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.keymaps.loadBundledKeymaps();
    centerItem = await lumine.workspace.open();
    spyOn(lumine.window, "close");
  });

  function createItem(location, { permanent = false, mini = false } = {}) {
    const element = document.createElement("div");
    element.tabIndex = -1;
    const input = document.createElement("input");
    input.classList.add("native-key-bindings");
    element.appendChild(input);
    const editor = mini ? lumine.workspace.buildTextEditor({ mini: true }) : null;
    if (editor) element.appendChild(lumine.views.getView(editor));
    return {
      element,
      input,
      editor,
      getTitle: () => "Dock item",
      getDefaultLocation: () => location,
      isPermanentDockItem: () => permanent,
      destroy() {
        editor?.destroy();
      },
    };
  }

  function pressClose(target) {
    lumine.keymaps.handleKeyboardEvent(
      buildKeydownEvent({
        key: "w",
        target,
        ctrlKey: process.platform !== "darwin",
        metaKey: process.platform === "darwin",
      }),
    );
  }

  function expectCenterPreserved() {
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(centerItem);
    expect(centerItem.isDestroyed()).toBe(false);
    expect(lumine.window.close).not.toHaveBeenCalled();
  }

  for (const location of ["left", "right", "bottom"]) {
    it(`closes only the active ${location} dock tab from its nested input`, async () => {
      const previousItem = createItem(location);
      const item = createItem(location);
      await lumine.workspace.open(previousItem);
      await lumine.workspace.open(item);
      const pane = lumine.workspace.paneForItem(item);

      pressClose(item.input);

      expect(pane.getItems()).toEqual([previousItem]);
      expect(pane.getActiveItem()).toBe(previousItem);
      expect(lumine.workspace.paneContainerForItem(previousItem).isVisible()).toBe(true);
      expectCenterPreserved();
    });
  }

  it("closes the host dock tab from a mini editor and hides the emptied dock", async () => {
    const item = createItem("left", { mini: true });
    await lumine.workspace.open(item);

    pressClose(lumine.views.getView(item.editor));

    expect(lumine.workspace.getLeftDock().getPaneItems()).toEqual([]);
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(false);
    expectCenterPreserved();
  });

  it("uses the dispatch pane even when another dock pane is active", async () => {
    const item = createItem("left");
    const otherItem = createItem("left");
    await lumine.workspace.open(item);
    const pane = lumine.workspace.paneForItem(item);
    const otherPane = pane.splitRight({ items: [otherItem] });
    otherPane.activate();

    await lumine.commands.dispatch(item.input, "core:close");

    expect(pane.isDestroyed()).toBe(true);
    expect(otherPane.getItems()).toEqual([otherItem]);
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(true);
    expectCenterPreserved();
  });

  it("respects cancellation of a dock tab close", async () => {
    const item = createItem("right");
    await lumine.workspace.open(item);
    const subscription = lumine.workspace.onWillDestroyPaneItem(({ prevent }) => prevent());
    try {
      await lumine.commands.dispatch(item.input, "core:close");
      expect(lumine.workspace.getRightDock().getPaneItems()).toEqual([item]);
      expectCenterPreserved();
    } finally {
      subscription.dispose();
    }
  });

  it("respects a permanent dock item without closing the center instead", async () => {
    const item = createItem("right", { permanent: true });
    await lumine.workspace.open(item);

    await lumine.commands.dispatch(item.input, "core:close");

    expect(lumine.workspace.getRightDock().getPaneItems()).toEqual([item]);
    expectCenterPreserved();
  });

  it("closes an empty dock split while leaving its other pane visible", async () => {
    const item = createItem("bottom");
    await lumine.workspace.open(item);
    const pane = lumine.workspace.paneForItem(item);
    const emptyPane = pane.splitRight();

    await lumine.commands.dispatch(emptyPane.getElement(), "core:close");

    expect(emptyPane.isDestroyed()).toBe(true);
    expect(lumine.workspace.getBottomDock().getPanes()).toEqual([pane]);
    expect(lumine.workspace.getBottomDock().isVisible()).toBe(true);
    expectCenterPreserved();
  });

  it("hides an empty dock without closing the center", async () => {
    const dock = lumine.workspace.getLeftDock();
    dock.activate();

    await lumine.commands.dispatch(dock.getElement(), "core:close");

    expect(dock.isVisible()).toBe(false);
    expectCenterPreserved();
  });

  it("still closes the center document when dispatched from the center", async () => {
    const item = createItem("right");
    await lumine.workspace.open(item);

    await lumine.commands.dispatch(centerItem.getElement(), "core:close");

    expect(centerItem.isDestroyed()).toBe(true);
    expect(lumine.workspace.getRightDock().getPaneItems()).toEqual([item]);
    expect(lumine.window.close).not.toHaveBeenCalled();
  });

  it("does not close the center from fixed panel controls", async () => {
    const element = document.createElement("div");
    const button = document.createElement("button");
    element.appendChild(button);
    const panel = lumine.workspace.addFooterPanel({ item: element });
    try {
      pressClose(button);
      expect(panel.isVisible()).toBe(true);
      expectCenterPreserved();
    } finally {
      panel.destroy();
    }
  });

  it("cancels a hosted dialog from its native input without closing the center", () => {
    const element = document.createElement("div");
    const input = document.createElement("input");
    input.classList.add("native-key-bindings");
    element.appendChild(input);
    const panel = lumine.workspace.addModalPanel({ item: element });
    const cancel = jasmine.createSpy("cancel").and.callFake(() => panel.destroy());
    const subscription = lumine.commands.add(element, "core:cancel", cancel);
    try {
      pressClose(input);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(lumine.workspace.getModalPanels()).not.toContain(panel);
      expectCenterPreserved();
    } finally {
      subscription.dispose();
      panel.destroy();
    }
  });

  it("consumes close in a modal that deliberately cannot be cancelled", () => {
    const element = document.createElement("div");
    const input = document.createElement("input");
    element.appendChild(input);
    const panel = lumine.workspace.addModalPanel({ item: element });
    try {
      pressClose(input);
      expect(panel.isVisible()).toBe(true);
      expectCenterPreserved();
    } finally {
      panel.destroy();
    }
  });
});
