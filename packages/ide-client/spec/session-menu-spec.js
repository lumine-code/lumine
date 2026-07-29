describe("ide-client session menu", () => {
  let main, menu;

  const stubSession = (state, id = "stub", rootPath = "/project", folders = [rootPath]) => ({
    adapter: { id, displayName: `${id} Server` },
    rootPath,
    state,
    folders: new Set(folders),
    stop() {},
  });

  // elementForItem returns a row descriptor, so go through the list to get the
  // element it actually renders — the same path a real row takes.
  const render = (item) => menu.serverList.resolveElement(item, {});

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
    // The name stays in the primary text, so the ellipsis truncates it and not
    // the state.
    expect(element.querySelector(".primary-text").textContent).toBe("stub Server");
  });

  it("renders the state as a themed badge, one variant per state", () => {
    const badgeFor = (state) =>
      render({ label: "stub Server", state }).querySelector(".ide-client-session-state");

    expect([...badgeFor("running").classList]).toEqual([
      "ide-client-session-state",
      "badge",
      "badge-success",
    ]);
    expect(badgeFor("starting").classList.contains("badge-warning")).toBe(true);
    expect(badgeFor("stopping").classList.contains("badge-warning")).toBe(true);
    expect(badgeFor("failed").classList.contains("badge-error")).toBe(true);
    // An idle server gets the plain neutral pill, not a variant.
    expect([...badgeFor("stopped").classList]).toEqual(["ide-client-session-state", "badge"]);
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
    expect(menu.serverList.isVisible()).toBeFalsy();
    await menu.toggle();
    expect(menu.serverList.isVisible()).toBeTruthy();
    expect(menu.serverList.getPanel().getItem()).toBe(menu.serverList);

    menu.serverList.cancel();
    expect(menu.serverList.isVisible()).toBeFalsy();
  });

  it("clears the previous query when it reopens", async () => {
    await menu.toggle();
    menu.serverList.refs.queryEditor.setText("pyright");
    await menu.toggle();
    await menu.toggle();
    expect(menu.serverList.getQuery()).toBe("");
  });

  it("names every folder a server answers for, not the one that started it", () => {
    const shared = stubSession("running", "pyright", "/project", ["/project", "/work/tools"]);
    main.manager.sessions.set("pyright:/project", shared);
    main.manager.sessions.set("pyright:/work/tools", shared);
    spyOn(atom.project, "getPaths").and.returnValue(["/project", "/work/tools"]);

    const [item, ...rest] = menu.serverItems();
    // One entry for one server, however many folders it took on.
    expect(rest).toEqual([]);
    expect(item.detail).toBe("Roots (2) · /project, /work/tools");
  });

  it("shows the whole project for a workspace-scoped server", () => {
    const session = stubSession("running", "wide", "/project");
    session.adapter.sessionScope = "workspace";
    main.manager.sessions.set("wide:", session);
    spyOn(atom.project, "getPaths").and.returnValue(["/one", "/two"]);

    // Its own rootPath is just whichever folder came first.
    expect(menu.serverItems()[0].detail).toBe("Workspace · /one, /two");
  });

  it("calls a single project folder a root", () => {
    main.manager.sessions.set("stub:/project", stubSession("running"));
    spyOn(atom.project, "getPaths").and.returnValue(["/project"]);
    expect(menu.serverItems()[0].detail).toBe("Root · /project");
  });

  it("names the file for a server started outside the project", () => {
    // No project folder contains it, so the session is rooted at the file's own
    // directory — the directory is an implementation detail, the file is not.
    const session = stubSession("running", "loose", "/tmp/scratch");
    session.documents = new Map([["uri", { editor: { getPath: () => "/tmp/scratch/notes.py" } }]]);
    main.manager.sessions.set("loose:/tmp/scratch", session);
    spyOn(atom.project, "getPaths").and.returnValue(["/project"]);

    expect(menu.serverItems()[0].detail).toBe("File · /tmp/scratch/notes.py");
  });

  it("falls back to the directory when the loose file has no path yet", () => {
    const session = stubSession("running", "loose", "/tmp/scratch");
    main.manager.sessions.set("loose:/tmp/scratch", session);
    spyOn(atom.project, "getPaths").and.returnValue(["/project"]);

    expect(menu.serverItems()[0].detail).toBe("File · /tmp/scratch");
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

  describe("stepping into a server's actions", () => {
    let session;

    beforeEach(() => {
      session = stubSession("running", "pyright");
      main.manager.sessions.set("pyright:/project", session);
      spyOn(atom.project, "getPaths").and.returnValue(["/project"]);
    });

    it("routes a confirmed server row into showActions", async () => {
      spyOn(menu, "showActions");
      await menu.toggle();
      expect(menu.serverList.props.items.length).toBe(1);

      menu.serverList.confirmSelection();
      expect(menu.showActions).toHaveBeenCalledWith(session);
    });

    it("shows the actions as a flow step named after the server, with no Back row", async () => {
      await menu.toggle();
      await menu.showActions(session);

      expect(menu.serverList.isVisible()).toBeFalsy();
      expect(menu.actionsList.isVisible()).toBeTruthy();
      expect(atom.workspace.getModalTrail()).toEqual(["Servers", "pyright Server"]);
      expect(menu.actionsList.props.items.map((item) => item.label)).toEqual([
        "Restart",
        "Stop",
        "Show Server Log",
        "Show Problems",
      ]);
    });

    it("returns to a freshly built server list on back navigation", async () => {
      await menu.toggle();
      await menu.showActions(session);

      // A server that appeared while the actions were open must be in the
      // list the back navigation re-shows.
      main.manager.sessions.set("late:/project", stubSession("starting", "late"));

      expect(atom.workspace.popModal()).toBe(true);
      expect(menu.serverList.isVisible()).toBeTruthy();
      expect(menu.serverList.props.items.map((item) => item.label)).toEqual([
        "late Server",
        "pyright Server",
      ]);
      expect(atom.workspace.getModalTrail()).toEqual(["Servers"]);
    });

    it("ends the flow when an action is confirmed", async () => {
      await menu.toggle();
      await menu.showActions(session);

      menu.actionsList.props.didConfirmSelection({ action: () => {} });

      expect(menu.actionsList.isVisible()).toBeFalsy();
      expect(menu.serverList.isVisible()).toBeFalsy();
      expect(atom.workspace.getModalTrail()).toEqual([]);
    });
  });
});
