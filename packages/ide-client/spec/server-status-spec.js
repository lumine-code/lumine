describe("ide-client status-bar item", () => {
  let main, view, tiles;

  const fakeStatusBar = () => ({
    addRightTile(options) {
      const tile = {
        ...options,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      tiles.push(tile);
      return tile;
    },
  });

  // `stop` is what the manager calls on teardown for whatever is left in the
  // map; without it deactivation throws and the manager never finishes.
  const stubSession = (state, id = "stub", rootPath = "/project") => ({
    adapter: { id, displayName: `${id} Server` },
    rootPath,
    state,
    stop() {},
  });

  // The batched write is flushed by hand so the assertions stay synchronous.
  const flush = () => atom.views.performDocumentUpdate();

  const addSession = (session) => {
    main.manager.sessions.set(`${session.adapter.id}:${session.rootPath}`, session);
    main.manager.didChangeSession(session);
    flush();
  };

  beforeEach(async () => {
    await atom.packages.activatePackage("ide-client");
    main = atom.packages.getActivePackage("ide-client").mainModule;
    tiles = [];
    main.consumeStatusBar(fakeStatusBar());
    view = main.serverStatus;
    flush();
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("ide-client");
  });

  it("hides itself while no server is running", () => {
    expect(view.element.style.display).toBe("none");
    expect(view.label.textContent).toBe("IDE (0)");
  });

  it("counts the servers once they appear", () => {
    addSession(stubSession("running"));
    expect(view.element.style.display).toBe("");
    expect(view.label.textContent).toBe("IDE (1)");
    expect(view.failed.hidden).toBe(true);
  });

  it("recomputes from the manager, so a session that goes away is dropped", () => {
    const session = stubSession("running");
    addSession(session);

    // Only the state change is reported; the removal itself never is.
    main.manager.sessions.delete("stub:/project");
    session.state = "stopped";
    main.manager.didChangeSession(session);
    flush();

    expect(view.label.textContent).toBe("IDE (0)");
    expect(view.element.style.display).toBe("none");
  });

  it("badges the failed servers", () => {
    addSession(stubSession("failed"));
    expect(view.element.classList.contains("has-failed")).toBe(true);
    expect(view.failed.hidden).toBe(false);
    expect(view.failed.textContent).toBe("1");
  });

  it("marks a starting server without counting it as a failure", () => {
    addSession(stubSession("starting"));
    expect(view.element.classList.contains("has-starting")).toBe(true);
    expect(view.element.classList.contains("has-failed")).toBe(false);
  });

  it("keeps a restarting server in the count", () => {
    const session = stubSession("running");
    addSession(session);
    session.state = "stopping";
    main.manager.didChangeSession(session);
    flush();
    expect(view.label.textContent).toBe("IDE (1)");
  });

  it("counts every server, not just the first per adapter", () => {
    addSession(stubSession("running", "zeta"));
    addSession(stubSession("failed", "alpha"));
    expect(view.label.textContent).toBe("IDE (2)");
    expect(view.failed.textContent).toBe("1");
  });

  it("names the servers and their states on hover, one line each", () => {
    addSession(stubSession("running", "zeta"));
    addSession(stubSession("starting", "alpha"));
    const lines = [...view.tooltipContent.children].map((line) => line.textContent);
    expect(lines).toEqual(["zeta Server (running)", "alpha Server (starting)"]);
  });

  it("opens the session menu on a left click only", () => {
    spyOn(main.sessionMenu, "toggle");
    view.element.dispatchEvent(new MouseEvent("click", { button: 2 }));
    expect(main.sessionMenu.toggle).not.toHaveBeenCalled();

    view.element.dispatchEvent(new MouseEvent("click", { button: 0 }));
    expect(main.sessionMenu.toggle).toHaveBeenCalled();
  });

  it("stays hidden while the setting is off", () => {
    addSession(stubSession("running"));
    atom.config.set("ide-client.statusBar.enabled", false);
    flush();
    expect(view.element.style.display).toBe("none");

    atom.config.set("ide-client.statusBar.enabled", true);
    flush();
    expect(view.element.style.display).toBe("");
  });

  it("replaces the item when the status bar is consumed twice", () => {
    main.consumeStatusBar(fakeStatusBar());
    expect(tiles.length).toBe(2);
    expect(tiles[0].destroyed).toBe(true);
    expect(tiles[1].destroyed).toBe(false);
  });
});
