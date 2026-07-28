const {
  activeSession,
  isModalOpen,
  modalElement,
  setQuery,
  confirm,
  settle,
} = require("../../../spec/helpers/modal-helpers");

describe("ide-client session menu", () => {
  let main, menu;

  const stubSession = (state, id = "stub", rootPath = "/project", folders = [rootPath]) => ({
    adapter: { id, displayName: `${id} Server` },
    rootPath,
    state,
    folders: new Set(folders),
    stop() {},
  });

  // Rows are built by the kernel from the view's renderer, so the way to see
  // one is to open the view that produces it.
  const renderRows = async (items) => {
    atom.modals.open({
      id: "spec.ide-client-rows",
      source: items,
      renderer: menu.renderer(),
    });
    await settle();
    return Array.from(modalElement().querySelectorAll("ol.list-group > li"));
  };

  beforeEach(async () => {
    await atom.packages.activatePackage("ide-client");
    main = atom.packages.getActivePackage("ide-client").mainModule;
    menu = main.sessionMenu;
  });

  afterEach(async () => {
    if (atom.modals.isOpen()) atom.modals.cancel("api");
    await atom.packages.deactivatePackage("ide-client");
  });

  it("puts the state in the trailing block of the primary line", async () => {
    const [element] = await renderRows([
      { label: "stub Server", detail: "/project", state: "running" },
    ]);
    const trailing = element.querySelector(".primary-line > .trailing-block");
    expect(trailing).not.toBe(null);

    const badge = trailing.querySelector(".ide-client-session-state");
    expect(badge.textContent).toBe("running");
    expect(badge.classList.contains("status-running")).toBe(true);
    // The name stays in the primary text, so the ellipsis truncates it and not
    // the state.
    expect(element.querySelector(".primary-text").textContent).toBe("stub Server");
  });

  it("renders the root path as a second line the theme dims", async () => {
    const [element] = await renderRows([
      { label: "stub Server", detail: "/project", state: "running" },
    ]);
    expect(element.classList.contains("two-lines")).toBe(true);
    expect(element.querySelector(".secondary-line").textContent).toBe("/project");
  });

  it("leaves out the trailing block for the action items, which have no state", async () => {
    const [element] = await renderRows([{ label: "Restart", detail: "Restart stub Server" }]);
    expect(element.querySelector(".trailing-block")).toBe(null);
    expect(element.querySelector(".primary-text").textContent).toBe("Restart");
  });

  it("opens and closes through the shared modal host", async () => {
    expect(isModalOpen()).toBe(false);
    menu.toggle();
    await settle();
    expect(isModalOpen()).toBe(true);

    activeSession().cancel("api");
    await settle();
    expect(isModalOpen()).toBe(false);
  });

  it("clears the previous query when it reopens", async () => {
    menu.toggle();
    await settle();
    setQuery("pyright");
    await settle();

    menu.toggle();
    await settle();
    menu.toggle();
    await settle();

    expect(activeSession().getQuery().raw).toBe("");
  });

  it("enters the actions for the chosen server instead of reopening a list", async () => {
    main.manager.sessions.set("stub:/project", stubSession("running"));
    spyOn(atom.project, "getPaths").and.returnValue(["/project"]);

    menu.toggle();
    await settle();
    const session = activeSession();
    expect(session.depth).toBe(1);

    confirm();
    await settle();

    expect(session.depth).toBe(2);
    // No "Back" row: escape pops instead.
    const labels = session.getVisibleItems().map((item) => item.label);
    expect(labels).not.toContain("Back");
    expect(labels).toContain("Restart");
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
    const editor = {};
    spyOn(main.manager, "sessionsForEditor").and.returnValue([other]);

    // The editor is the one the modal captured before it took focus, so it is
    // passed in rather than read back out of the workspace.
    expect(menu.serverItems(editor).map((item) => item.label)).toEqual([
      "zeta Server",
      "alpha Server",
    ]);
  });
});
