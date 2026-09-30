const { buildKeydownEvent } = require("./keymap-spec-helpers/helpers");

describe("closing the active center document", () => {
  let centerItem;

  beforeEach(async () => {
    await lumine.reset();
    jasmine.attachToDOM(lumine.workspace.getElement());
    centerItem = await lumine.workspace.open();
    spyOn(lumine.window, "close");
  });

  function createItem(location, { mini = false } = {}) {
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

  for (const location of ["left", "right", "bottom"]) {
    it(`closes the center document from the ${location} dock's native input`, async () => {
      const firstItem = createItem(location);
      const item = createItem(location);
      await lumine.workspace.open(firstItem);
      await lumine.workspace.open(item);
      const pane = lumine.workspace.paneForItem(item);

      pressClose(item.input);

      expect(centerItem.isDestroyed()).toBe(true);
      expect(pane.getItems()).toEqual([firstItem, item]);
      expect(pane.getActiveItem()).toBe(item);
      expect(lumine.workspace.paneContainerForItem(item).isVisible()).toBe(true);
      expect(lumine.window.close).not.toHaveBeenCalled();
    });
  }

  it("keeps the host dock tab open when its mini editor has focus", async () => {
    const item = createItem("left", { mini: true });
    await lumine.workspace.open(item);

    pressClose(lumine.views.getView(item.editor));

    expect(centerItem.isDestroyed()).toBe(true);
    expect(item.editor.isDestroyed()).toBe(false);
    expect(lumine.workspace.getLeftDock().getPaneItems()).toEqual([item]);
    expect(lumine.workspace.getLeftDock().isVisible()).toBe(true);
  });

  it("preserves the center close cancellation without closing a dock instead", async () => {
    const item = createItem("right");
    await lumine.workspace.open(item);
    const subscription = lumine.workspace.onWillDestroyPaneItem(
      ({ item: closingItem, prevent }) => {
        if (closingItem === centerItem) prevent();
      },
    );
    try {
      await lumine.commands.dispatch(item.input, "core:close");
      expect(centerItem.isDestroyed()).toBe(false);
      expect(lumine.workspace.getRightDock().getPaneItems()).toEqual([item]);
      expect(lumine.window.close).not.toHaveBeenCalled();
    } finally {
      subscription.dispose();
    }
  });

  it("closes the center document while an empty dock has focus", async () => {
    const dock = lumine.workspace.getLeftDock();
    dock.activate();

    await lumine.commands.dispatch(dock.getElement(), "core:close");

    expect(centerItem.isDestroyed()).toBe(true);
    expect(dock.isVisible()).toBe(true);
    expect(lumine.window.close).not.toHaveBeenCalled();
  });

  it("keeps an empty dock split when closing the center document", async () => {
    const item = createItem("bottom");
    await lumine.workspace.open(item);
    const pane = lumine.workspace.paneForItem(item);
    const emptyPane = pane.splitRight();

    await lumine.commands.dispatch(emptyPane.getElement(), "core:close");

    expect(centerItem.isDestroyed()).toBe(true);
    expect(emptyPane.isDestroyed()).toBe(false);
    expect(lumine.workspace.getBottomDock().getPanes()).toEqual([pane, emptyPane]);
  });

  it("closes the center document from fixed footer controls", () => {
    const button = document.createElement("button");
    const panel = lumine.workspace.addFooterPanel({ item: button });
    try {
      pressClose(button);
      expect(centerItem.isDestroyed()).toBe(true);
      expect(panel.isVisible()).toBe(true);
      expect(lumine.window.close).not.toHaveBeenCalled();
    } finally {
      panel.destroy();
    }
  });

  it("keeps modal cancellation separate from closing the center document", () => {
    const input = document.createElement("input");
    input.classList.add("native-key-bindings");
    const panel = lumine.workspace.addModalPanel({ item: input });
    const cancel = jasmine.createSpy("cancel").and.callFake(() => panel.destroy());
    const subscription = lumine.commands.add(input, "core:cancel", cancel);
    try {
      pressClose(input);
      expect(centerItem.isDestroyed()).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
      expect(panel.isVisible()).toBe(true);
      lumine.commands.dispatch(input, "core:cancel");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(lumine.workspace.getModalPanels()).not.toContain(panel);
    } finally {
      subscription.dispose();
      panel.destroy();
    }
  });
});
