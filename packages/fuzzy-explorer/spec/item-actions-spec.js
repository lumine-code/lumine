describe("fuzzy-explorer item actions", () => {
  let main;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    // The package activates on its commands, so dispatch one to trigger it;
    // activation also loads the package keymap the actions list reads.
    const activation = atom.packages.activatePackage("fuzzy-explorer");
    atom.commands.dispatch(atom.views.getView(atom.workspace), "fuzzy-explorer:toggle");
    main = (await activation).mainModule;
    main.selectList.hide();
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("fuzzy-explorer");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    const actions = main.selectList.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const openExternal = byCommand.get("fuzzy-explorer:open-external");
    expect(openExternal.name).toBe("Open External");
    expect(openExternal.description).toBe("Open the file in the default external program");
    expect(openExternal.keystrokes).toEqual(["alt-enter"]);

    const insertRelative = byCommand.get("fuzzy-explorer:insert-relative-path");
    expect([...insertRelative.keystrokes].sort()).toEqual(["alt-v", "alt-v alt-r"]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }
    expect(byCommand.get("fuzzy-explorer:copy-absolute-path").description).toBe(
      "Copy the full path from the filesystem root to the clipboard",
    );

    // Chrome and global commands stay out.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("fuzzy-explorer:toggle")).toBe(false);
  });

  it("shows the actions as a flow step and runs one against the master list", async () => {
    main.selectList.show();

    await main.selectList.showItemActions();

    expect(main.selectList.itemActionsList.isVisible()).toBeTruthy();
    expect(atom.workspace.getModalTrail()).toEqual(["Explorer", "Actions"]);
    // The actions list wears the package class, so the package keymap
    // resolves action keystrokes inside it too.
    expect(main.selectList.itemActionsList.element.classList.contains("fuzzy-explorer")).toBe(true);

    const spy = spyOn(main, "update");
    const index = main.selectList.itemActionsList.items.findIndex(
      (item) => item.command === "fuzzy-explorer:refresh-index",
    );
    main.selectList.itemActionsList.selectIndex(index);
    main.selectList.itemActionsList.confirmSelection();

    expect(spy).toHaveBeenCalled();
    expect(main.selectList.isVisible()).toBeTruthy();
    expect(main.selectList.itemActionsList.isVisible()).toBeFalsy();
  });
});
