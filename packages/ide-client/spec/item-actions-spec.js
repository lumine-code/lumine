describe("ide-client item actions", () => {
  let main, list;

  beforeEach(async () => {
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    // No activation commands here, so a plain activation resolves; it also
    // loads the package keymap the actions list reads.
    main = (await atom.packages.activatePackage("ide-client")).mainModule;
    list = main.sessionMenu.serverList;
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("ide-client");
  });

  it("derives its actions from the command registrations and the keymap", () => {
    const actions = list.itemActions();
    const byCommand = new Map(actions.map((action) => [action.command, action]));

    const restart = byCommand.get("ide-client:restart-server");
    expect(restart.name).toBe("Restart Server");
    expect(restart.description).toBe("Restart the selected server without leaving the list");
    expect(restart.keystrokes).toEqual(["alt-r"]);

    expect(byCommand.get("ide-client:stop-server").keystrokes).toEqual(["alt-delete"]);
    expect(byCommand.get("ide-client:show-server-log").keystrokes).toEqual(["alt-l"]);
    expect(byCommand.get("ide-client:show-problems").keystrokes).toEqual(["alt-p"]);
    // The Enter action is listed for what it does, not for a key it does not
    // need: confirming the row is already how it runs.
    expect(byCommand.get("ide-client:show-details").keystrokes).toEqual([]);

    // Every action explains itself with more than a restated title.
    for (const action of actions) {
      expect(action.description).toBeTruthy();
    }

    // Chrome and the window-wide commands stay out — the latter is why the
    // in-list names are not `restart`, `show-log` and `toggle-problems`.
    expect(byCommand.has("core:confirm")).toBe(false);
    expect(byCommand.has("select-list:actions")).toBe(false);
    expect(byCommand.has("ide-client:servers")).toBe(false);
    expect(byCommand.has("ide-client:restart")).toBe(false);
    expect(byCommand.has("ide-client:show-log")).toBe(false);
    expect(byCommand.has("ide-client:toggle-problems")).toBe(false);
  });

  it("shows the actions as a flow step and runs one against the server list", async () => {
    const session = {
      adapter: { id: "pyright", displayName: "pyright Server" },
      rootPath: "/project",
      state: "running",
      folders: new Set(["/project"]),
    };
    main.manager.sessions.set("pyright:/project", session);
    spyOn(atom.project, "getPaths").and.returnValue(["/project"]);
    spyOn(main.manager, "restart").and.returnValue(Promise.resolve(session));

    await main.sessionMenu.toggle();
    await list.showItemActions();

    expect(list.itemActionsList.isVisible()).toBeTruthy();
    expect(atom.workspace.getModalTrail()).toEqual(["Servers", "Actions"]);
    // The actions list wears the package class, so the package keymap resolves
    // action keystrokes inside it too.
    expect(list.itemActionsList.element.classList.contains("ide-client-session-menu")).toBe(true);

    const index = list.itemActionsList.items.findIndex(
      (item) => item.command === "ide-client:restart-server",
    );
    await list.itemActionsList.selectIndex(index);
    list.itemActionsList.confirmSelection();

    // Running an action returns to the server list first, so the handler finds
    // the server row it was chosen for still selected.
    expect(main.manager.restart).toHaveBeenCalledWith(session);
    expect(list.isVisible()).toBeTruthy();
    expect(list.itemActionsList.isVisible()).toBeFalsy();
  });
});
