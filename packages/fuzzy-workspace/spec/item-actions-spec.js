describe("fuzzy-workspace item actions", () => {
  let main;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    // The package activates on its commands, so dispatch one to trigger it;
    // activation also loads the package keymap the actions list reads.
    const activation = atom.packages.activatePackage("fuzzy-workspace");
    atom.commands.dispatch(atom.views.getView(atom.workspace), "fuzzy-workspace:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("fuzzy-workspace");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    const actions = main.selectList.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const closeItem = byCommand.get("fuzzy-workspace:close-selected-item");
    expect(closeItem.name).toBe("Close Selected Item");
    expect(closeItem.description).toBe("Close the item in its pane, keeping the list open");
    expect(closeItem.keystrokes).toEqual(["alt-delete"]);

    expect(byCommand.get("fuzzy-workspace:copy-selected-path").keystrokes).toEqual(["alt-c"]);
    // Confirming is chrome (core:confirm), so the focus action carries no
    // package binding of its own.
    expect(byCommand.get("fuzzy-workspace:focus-selected-item").keystrokes).toEqual([]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("fuzzy-workspace:toggle")).toBe(false);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    main.selectList.show();

    await main.selectList.showItemActions();

    expect(main.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(atom.workspace.getModalTrail()).toEqual(["Workspace", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(main.selectList.itemActionsList.element.classList.contains("fuzzy-workspace")).toBe(
      true,
    );

    const spy = spyOn(main, "performAction");
    const index = main.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "fuzzy-workspace:close-selected-item",
    );
    main.selectList.itemActionsList.selectIndex(index);
    main.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalledWith("close");
    expect(main.selectList.isVisible()).toBeTruthy();
    expect(main.selectList.itemActionsList.isVisible()).toBeFalsy();
  });
});
