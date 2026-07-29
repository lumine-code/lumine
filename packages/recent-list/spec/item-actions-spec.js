describe("recent-list item actions", () => {
  let main, list;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    // No activation commands here, so a plain activation resolves; it also
    // loads the package keymap the actions list reads.
    main = (await atom.packages.activatePackage("recent-list")).mainModule;
    list = main.recentList;
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("recent-list");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    const actions = list.selectList.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const swap = byCommand.get("recent-list:swap");
    expect(swap.name).toBe("Swap");
    expect(swap.description).toBe("Open the project in a new window and close the current one");
    expect(swap.keystrokes).toEqual(["alt-enter"]);

    expect(byCommand.get("recent-list:append").keystrokes).toEqual(["shift-enter"]);
    expect(byCommand.get("recent-list:delete").keystrokes).toEqual(["alt-delete"]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("recent-list:toggle")).toBe(false);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    list.selectList.show();

    await list.selectList.showItemActions();

    expect(list.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(atom.workspace.getModalTrail()).toEqual(["Recent", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(list.selectList.itemActionsList.element.classList.contains("recent-list")).toBe(true);

    const spy = spyOn(list, "performAction");
    const index = list.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "recent-list:append",
    );
    list.selectList.itemActionsList.selectIndex(index);
    list.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalledWith("append");
    expect(list.selectList.isVisible()).toBeTruthy();
    expect(list.selectList.itemActionsList.isVisible()).toBeFalsy();
  });
});
