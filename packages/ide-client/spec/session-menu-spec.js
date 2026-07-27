describe("ide-client session menu", () => {
  let main, menu;

  const stubSession = (state, id = "stub", rootPath = "/project", folders = [rootPath]) => ({
    adapter: { id, displayName: `${id} Server` },
    rootPath,
    state,
    folders: new Set(folders),
    stop() {},
  });

  const render = (item) => menu.elementForItem(item);

  beforeEach(async () => {
    await atom.packages.activatePackage("ide-client");
    main = atom.packages.getActivePackage("ide-client").mainModule;
    menu = main.sessionMenu;
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("ide-client");
  });

  it("puts the state in the trailing block of the primary line", () => {
    const element = render({ label: "stub Server", detail: "/project", state: "running" });
    const trailing = element.querySelector(".primary-line > .trailing-block");
    expect(trailing).not.toBe(null);

    const badge = trailing.querySelector(".ide-client-session-state");
    expect(badge.textContent).toBe("running");
    expect(badge.classList.contains("status-running")).toBe(true);
    // The name stays in the primary text, so the ellipsis truncates it and not
    // the state.
    expect(element.querySelector(".primary-text").textContent).toBe("stub Server");
  });

  it("renders the root path as a second line the theme dims", () => {
    const element = render({ label: "stub Server", detail: "/project", state: "running" });
    expect(element.classList.contains("two-lines")).toBe(true);
    expect(element.querySelector(".secondary-line").textContent).toBe("/project");
  });

  it("leaves out the trailing block for the action items, which have no state", () => {
    const element = render({ label: "Restart", detail: "Restart stub Server" });
    expect(element.querySelector(".trailing-block")).toBe(null);
    expect(element.querySelector(".primary-text").textContent).toBe("Restart");
  });

  it("hosts the list in the view's own panel, so a click outside cancels it", async () => {
    // The base view cancels on focusout only for a list it knows is visible,
    // which means the panel has to be the one it built itself.
    // Truthiness, not `false`: isVisible() is `this.panel && …`, so it answers
    // undefined until the panel exists.
    expect(menu.selectList.isVisible()).toBeFalsy();
    await menu.toggle();
    expect(menu.selectList.isVisible()).toBeTruthy();
    expect(menu.selectList.getPanel().getItem()).toBe(menu.selectList);

    menu.selectList.cancel();
    expect(menu.selectList.isVisible()).toBeFalsy();
  });

  it("clears the previous query when it reopens", async () => {
    await menu.toggle();
    menu.selectList.refs.queryEditor.setText("pyright");
    await menu.toggle();
    await menu.toggle();
    expect(menu.selectList.getQuery()).toBe("");
  });

  it("names every folder a server answers for, not the one that started it", () => {
    const shared = stubSession("running", "pyright", "/project", ["/project", "/work/tools"]);
    main.manager.sessions.set("pyright:/project", shared);
    main.manager.sessions.set("pyright:/work/tools", shared);

    const [item, ...rest] = menu.serverItems();
    // One entry for one server, however many folders it took on.
    expect(rest).toEqual([]);
    expect(item.detail).toBe("2 folders: project, tools");
  });

  it("shows the whole project for a workspace-scoped server", () => {
    const session = stubSession("running", "wide", "/project");
    session.adapter.sessionScope = "workspace";
    main.manager.sessions.set("wide:", session);
    spyOn(atom.project, "getPaths").and.returnValue(["/one", "/two"]);

    // Its own rootPath is just whichever folder came first.
    expect(menu.serverItems()[0].detail).toBe("2 folders: one, two");
  });

  it("keeps the plain path when a server serves a single folder", () => {
    main.manager.sessions.set("stub:/project", stubSession("running"));
    expect(menu.serverItems()[0].detail).toBe("/project");
  });

  it("lists the servers of the active editor first", () => {
    const other = stubSession("running", "zeta");
    const serving = stubSession("running", "alpha");
    main.manager.sessions.set("zeta:/project", other);
    main.manager.sessions.set("alpha:/project", serving);
    spyOn(main.manager, "sessionsForEditor").and.returnValue([other]);
    spyOn(atom.workspace, "getActiveTextEditor").and.returnValue({});

    expect(menu.serverItems().map((item) => item.label)).toEqual(["zeta Server", "alpha Server"]);
  });
});
