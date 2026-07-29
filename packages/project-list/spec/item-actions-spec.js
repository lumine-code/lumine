describe("project-list item actions", () => {
  let main, list;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    // No activation commands here, so a plain activation resolves; it also
    // loads the package keymap the actions list reads.
    main = (await atom.packages.activatePackage("project-list")).mainModule;
    list = main.projectList;
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("project-list");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    const actions = list.selectList.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const swap = byCommand.get("project-list:swap");
    expect(swap.name).toBe("Swap");
    expect(swap.description).toBe("Open the project in a new window and close the current one");
    expect(swap.keystrokes).toEqual(["alt-enter"]);

    expect(byCommand.get("project-list:append").keystrokes).toEqual(["shift-enter"]);
    expect(byCommand.get("project-list:refresh").keystrokes).toEqual(["f5"]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and global commands stay out — including the workspace-level
    // update, which is why the in-list rebuild is named refresh.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("project-list:toggle")).toBe(false);
    expect(byCommand.has("project-list:update")).toBe(false);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    list.selectList.show();

    await list.selectList.showItemActions();

    expect(list.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(atom.workspace.getModalTrail()).toEqual(["Projects", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(list.selectList.itemActionsList.element.classList.contains("project-list")).toBe(true);

    const spy = spyOn(list, "performAction");
    const index = list.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "project-list:append",
    );
    list.selectList.itemActionsList.selectIndex(index);
    list.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalledWith("append");
    expect(list.selectList.isVisible()).toBeTruthy();
    expect(list.selectList.itemActionsList.isVisible()).toBeFalsy();
  });
});
