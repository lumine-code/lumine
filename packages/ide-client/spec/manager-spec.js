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
