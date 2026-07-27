const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const { languageIdForEditor } = require("../lib/language-ids");

describe("LanguageServerManager adapters", () => {
  let manager;
  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());
  it("validates adapters", () =>
    expect(() => manager.registerAdapter({ id: "bad" })).toThrowError(/grammarScopes/));
  it("rejects duplicate IDs and disposes registrations", () => {
    const adapter = {
      id: "test",
      displayName: "Test",
      grammarScopes: ["source.test"],
      resolveServer: async () => null,
    };
    const registration = manager.registerAdapter(adapter);
    expect(() => manager.registerAdapter(adapter)).toThrowError(/already registered/);
    registration.dispose();
    expect(manager.adapters.has("test")).toBe(false);
  });
});

describe("LanguageServerManager session lifetime", () => {
  let manager;
  const sessionAt = (rootPath) => {
    const session = {
      adapter: { id: "test", displayName: "Test", grammarScopes: ["source.test"] },
      rootPath,
      state: "running",
      documents: new Map(),
      stop: jasmine.createSpy("stop").and.callFake(async () => {
        session.state = "stopped";
      }),
    };
    manager.sessions.set(`test:${rootPath}`, session);
    return session;
  };

  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());

  it("reclaims a session rooted outside the project once its last editor closes", () => {
    // What opening a lone file with no project folder produces: the root is
    // the file's own directory, so nothing will ever ask for this session
    // again.
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    manager.didCloseDocument(session);
    advanceClock(1000);
    expect(session.stop).toHaveBeenCalled();
    expect(manager.sessions.size).toBe(0);
  });

  it("keeps a session rooted at a project path warm", () => {
    const [root] = atom.project.getPaths();
    expect(root).toBeDefined();
    const session = sessionAt(root);
    manager.didCloseDocument(session);
    advanceClock(1000);
    // Reopening a file in the project must not pay for another server start.
    expect(session.stop).not.toHaveBeenCalled();
    expect(manager.sessions.size).toBe(1);
  });

  it("keeps a session whose documents came back before the grace period", () => {
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    manager.didCloseDocument(session);
    // A save under a new name closes and reopens the document.
    session.documents.set("file:///tmp/loose/a.test", {});
    advanceClock(1000);
    expect(session.stop).not.toHaveBeenCalled();
  });

  it("gives an editor a new server when its root leaves the project", async () => {
    const editor = await atom.workspace.open(path.join(atom.project.getPaths()[0], "a.test"));
    spyOn(manager, "reattachEditor");
    spyOn(manager, "attachEditor");

    // The session serving it was stopped by reconcileProjects when the root
    // went away, leaving the still-open editor with nothing.
    manager.rerouteEditorsToTheirRoots();
    expect(manager.attachEditor).toHaveBeenCalledWith(editor);
    editor.destroy();
  });

  it("moves an editor onto the session of the root it just gained", async () => {
    const filePath = path.join(atom.project.getPaths()[0], "b.test");
    const editor = await atom.workspace.open(filePath);
    // Attached to a session keyed to its own directory, as it would be when
    // opened before any project folder existed.
    const loose = sessionAt(path.dirname(filePath));
    loose.documents.set(require("url").pathToFileURL(filePath).href, {});
    spyOn(manager, "reattachEditor");

    manager.rerouteEditorsToTheirRoots();
    expect(manager.reattachEditor).toHaveBeenCalledWith(editor);
    editor.destroy();
  });

  it("leaves an editor alone when its root did not change", async () => {
    const filePath = path.join(atom.project.getPaths()[0], "c.test");
    const editor = await atom.workspace.open(filePath);
    manager.registerAdapter({
      id: "test",
      displayName: "Test",
      grammarScopes: [editor.getGrammar().scopeName],
      resolveServer: async () => null,
    });
    const root = atom.project.getPaths()[0];
    const session = sessionAt(root);
    session.documents.set(require("url").pathToFileURL(filePath).href, {});
    spyOn(manager, "reattachEditor");
    spyOn(manager, "attachEditor");

    // Already on the right session: no didClose/didOpen churn for every open
    // editor each time a folder is added.
    manager.rerouteEditorsToTheirRoots();
    expect(manager.reattachEditor).not.toHaveBeenCalled();
    expect(manager.attachEditor).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("reroutes editors whenever the project paths change", () => {
    spyOn(manager, "rerouteEditorsToTheirRoots");
    manager.knownRoots = [];
    manager.projectPathsChanged();
    expect(manager.rerouteEditorsToTheirRoots).toHaveBeenCalled();
  });

  it("drops pending checks when the package deactivates", async () => {
    const session = sessionAt(path.join(path.sep, "tmp", "loose"));
    manager.didCloseDocument(session);
    expect(manager.idleChecks.size).toBe(1);
    await manager.deactivate();
    expect(manager.idleChecks.size).toBe(0);
  });
});

describe("LanguageServerManager capabilities", () => {
  let manager;
  beforeEach(() => {
    manager = new LanguageServerManager();
  });
  afterEach(async () => manager.deactivate());

  it("merges fragments over the base without mutating either", () => {
    manager.addCapabilityFragment({ textDocument: { hover: { contentFormat: ["markdown"] } } });
    manager.addCapabilityFragment({ textDocument: { hover: { dynamicRegistration: true } } });
    const first = manager.buildClientCapabilities();
    expect(first.textDocument.hover).toEqual({
      contentFormat: ["markdown"],
      dynamicRegistration: true,
    });
    expect(first.general.positionEncodings).toEqual(["utf-16"]);
    const second = manager.buildClientCapabilities();
    expect(second.textDocument.hover).toEqual(first.textDocument.hover);
  });

  it("matches string and relative glob patterns", () => {
    const filePath = path.join("C:", "project", "src", "main.ts");
    expect(manager.globMatches("**/*.ts", filePath)).toBe(true);
    expect(manager.globMatches("*.ts", filePath)).toBe(true);
    expect(manager.globMatches("**/*.py", filePath)).toBe(false);
    const base = require("url").pathToFileURL(path.join("C:", "project")).href;
    expect(manager.globMatches({ baseUri: base, pattern: "src/*.ts" }, filePath)).toBe(true);
    expect(manager.globMatches({ baseUri: base, pattern: "lib/*.ts" }, filePath)).toBe(false);
  });

  it("scopes dynamic registrations by document selector", () => {
    const session = { adapter: { grammarScopes: ["source.python"] } };
    manager.registerCapabilities(session, [
      {
        id: "reg-1",
        method: "textDocument/formatting",
        registerOptions: { documentSelector: [{ language: "python" }] },
      },
    ]);
    const pythonEditor = {
      getGrammar: () => ({ scopeName: "source.python", name: "Python" }),
      getPath: () => "x.py",
    };
    const jsEditor = {
      getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
      getPath: () => "x.js",
    };
    expect(manager.dynamicSupport(session, "textDocument/formatting", pythonEditor)).toBe(true);
    expect(manager.dynamicSupport(session, "textDocument/formatting", jsEditor)).toBe(false);
    expect(manager.dynamicSupport(session, "textDocument/hover", jsEditor)).toBeUndefined();
    manager.unregisterCapabilities(session, [{ id: "reg-1" }]);
    expect(
      manager.dynamicSupport(session, "textDocument/formatting", pythonEditor),
    ).toBeUndefined();
  });

  it("routes watched-file events through registered watchers", () => {
    const notifications = [];
    const session = {
      state: "running",
      adapter: { grammarScopes: [] },
      notify: (method, params) => notifications.push({ method, params }),
    };
    manager.registerCapabilities(session, [
      {
        id: "watch-1",
        method: "workspace/didChangeWatchedFiles",
        registerOptions: { watchers: [{ globPattern: "**/*.ts", kind: 5 }] },
      },
    ]);
    const tsPath = path.join("C:", "project", "a.ts");
    const pyPath = path.join("C:", "project", "b.py");
    manager.routeFileEvents([
      { action: "created", path: tsPath },
      { action: "modified", path: tsPath },
      { action: "created", path: pyPath },
      { action: "renamed", path: tsPath, oldPath: path.join("C:", "project", "old.ts") },
    ]);
    expect(notifications.length).toBe(1);
    const changes = notifications[0].params.changes;
    // kind 5 = create | delete: the "modified" event and the .py file are filtered out.
    expect(changes.map((change) => change.type)).toEqual([1, 3, 1]);
  });

  it("notifies running sessions about workspace folder changes", () => {
    const notifications = [];
    const session = {
      state: "running",
      adapter: { sessionScope: "workspace", grammarScopes: [] },
      capabilities: { workspace: { workspaceFolders: { changeNotifications: true } } },
      notify: (method, params) => notifications.push({ method, params }),
      stop: () => {},
    };
    manager.sessions.set("fake:root", session);
    manager.knownRoots = [];
    manager.projectPathsChanged();
    const roots = atom.project.getPaths();
    if (roots.length) {
      expect(notifications[0].method).toBe("workspace/didChangeWorkspaceFolders");
      expect(notifications[0].params.event.added.length).toBe(roots.length);
    }
    expect(manager.knownRoots).toEqual(roots);
    manager.sessions.clear();
  });
});

describe("languageIdForEditor", () => {
  const editorWith = (scopeName, name) => ({
    getGrammar: () => ({ scopeName, name }),
  });
  it("maps grammar scopes through the table", () => {
    expect(languageIdForEditor({}, editorWith("source.python", "Python"))).toBe("python");
    expect(languageIdForEditor({}, editorWith("source.js", "JavaScript"))).toBe("javascript");
    expect(languageIdForEditor({}, editorWith("text.tex.latex", "LaTeX"))).toBe("latex");
  });
  it("prefers the adapter scope override, then the table, then the blanket id", () => {
    const adapter = {
      languageId: "blanket",
      languageIdForScope: (scope) => (scope === "source.custom" ? "custom" : undefined),
    };
    expect(languageIdForEditor(adapter, editorWith("source.custom", "Custom"))).toBe("custom");
    expect(languageIdForEditor(adapter, editorWith("source.python", "Python"))).toBe("python");
    expect(languageIdForEditor(adapter, editorWith("source.unknown", "Unknown"))).toBe("blanket");
    expect(languageIdForEditor({}, editorWith("source.unknown", "Unknown"))).toBe("unknown");
  });
});
