describe("ide-client session menu", () => {
  let main, menu;

  const stubSession = (state, id = "stub", rootPath = "/project") => ({
    adapter: { id, displayName: `${id} Server` },
    rootPath,
    state,
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
