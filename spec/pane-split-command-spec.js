describe("pane split command availability", () => {
  const directions = ["up", "down", "left", "right"];
  let workspace, pane, menuRegistration, contextRegistration, popup;

  beforeEach(() => {
    jasmine.useRealClock();
    workspace = lumine.workspace;
    jasmine.attachToDOM(workspace.getElement());
    pane = workspace.getCenter().getActivePane();
  });

  afterEach(async () => {
    popup?.close();
    menuRegistration?.dispose();
    contextRegistration?.dispose();
    await workspace.discardEditorWindows();
  });

  for (const direction of directions) {
    for (const action of ["copy", "move"]) {
      it(`splits an empty pane ${direction} through the split-and-${action} command`, async () => {
        const command = `pane:split-${direction}-and-${action}-active-item`;
        const transfer = spyOn(workspace, `${action}PaneItem`).and.callThrough();
        expect(lumine.commands.canDispatch(pane.getElement(), command)).toBeTrue();
        await lumine.commands.dispatch(pane.getElement(), command);
        const destination = workspace.getCenter().getActivePane();
        expect(workspace.getCenter().getPanes().length).toBe(2);
        expect(destination).not.toBe(pane);
        expect(destination.getItems()).toEqual([]);
        expect(pane.getItems()).toEqual([]);
        expect(pane.parent.orientation).toBe(
          ["left", "right"].includes(direction) ? "horizontal" : "vertical",
        );
        expect(pane.parent.children).toEqual(
          ["up", "left"].includes(direction) ? [destination, pane] : [pane, destination],
        );
        expect(transfer).not.toHaveBeenCalled();
      });
    }

    it(`still copies the active document when splitting ${direction}`, async () => {
      const editor = await workspace.open();
      editor.setText("source document");
      const command = `pane:split-${direction}-and-copy-active-item`;
      expect(lumine.commands.canDispatch(editor.getElement(), command)).toBeTrue();
      await lumine.commands.dispatch(editor.getElement(), command);
      const copy = workspace.getCenter().getActivePaneItem();
      expect(copy).not.toBe(editor);
      expect(copy.getBuffer()).toBe(editor.getBuffer());
      expect(pane.getItems()).toEqual([editor]);
    });
  }

  it("keeps item-only move and copy unavailable in an empty pane", () => {
    for (const direction of directions)
      for (const action of ["copy", "move"])
        expect(
          lumine.commands.canDispatch(pane.getElement(), `pane:${action}-active-item-${direction}`),
        ).toBeFalse();
  });

  it("does not split to copy an item that does not support copying", () => {
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Singleton",
      copy: jasmine.createSpy("copy singleton"),
      canCopy: () => false,
    };
    pane.addItem(item);
    for (const direction of directions) {
      const command = `pane:split-${direction}-and-copy-active-item`;
      expect(lumine.commands.canDispatch(pane.getElement(), command)).toBeFalse();
      expect(lumine.commands.dispatch(pane.getElement(), command)).toBeNull();
    }
    expect(workspace.getMainWindow().getEditorContainer().getPanes()).toEqual([pane]);
    expect(item.copy).not.toHaveBeenCalled();
  });

  it("splits the clicked empty pane while another pane holds the active editor", async () => {
    const editor = await workspace.open();
    const empty = pane.splitDown({ activate: false });
    const copy = spyOn(workspace, "copyPaneItem").and.callThrough();
    await lumine.commands.dispatch(empty.getElement(), "pane:split-right-and-copy-active-item");
    expect(workspace.getCenter().getPanes().length).toBe(3);
    expect(workspace.getCenter().getActivePane().parent.children[0]).toBe(empty);
    expect(pane.getItems()).toEqual([editor]);
    expect(copy).not.toHaveBeenCalled();
  });

  it("splits the invoking empty window without using the main window's document", async () => {
    const editor = await workspace.open();
    const secondary = await workspace.openEditorWindow({ show: false });
    await lumine.commands.dispatch(secondary.getElement(), "pane:split-right-and-copy-active-item");
    expect(secondary.getEditorContainer().getPanes().length).toBe(2);
    expect(secondary.getEditorContainer().getPaneItems()).toEqual([]);
    expect(workspace.getMainWindow().getEditorContainer().getPanes()).toEqual([pane]);
    expect(pane.getItems()).toEqual([editor]);
  });

  it("enables the four application and context menu rows for an empty pane", () => {
    menuRegistration = lumine.menu.loadPlatformItems();
    contextRegistration = lumine.contextMenu.loadPlatformItems();
    const template = lumine.menu.prepareNativeTemplate(pane.getElement());
    const { normalizeLabel } = require("../src/menu-helpers");
    const panes = template
      .find((row) => normalizeLabel(row.label) === "View")
      .submenu.find((row) => normalizeLabel(row.label) === "Panes");
    const surface = pane.getElement().querySelector(".item-views");
    popup = lumine.menu.showPopup({
      target: surface,
      anchor: surface,
      template: lumine.contextMenu.templateForElement(surface),
    });
    for (const direction of directions) {
      const command = `pane:split-${direction}-and-copy-active-item`;
      expect(panes.submenu.find((row) => row.command === command)?.enabled).toBeTrue();
      expect(
        popup.rootList.items.find((row) => row.template.command === command)?.enabled,
      ).toBeTrue();
    }
  });
});
