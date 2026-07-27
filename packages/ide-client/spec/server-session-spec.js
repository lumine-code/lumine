const fs = require("fs");
const os = require("os");
const path = require("path");
const LanguageServerManager = require("../lib/language-server-manager");
const ServerSession = require("../lib/server-session");

const FIXTURE = path.join(__dirname, "fixtures", "fake-server.js");

const until = async (condition, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
};

describe("ServerSession against a fake server", () => {
  let manager, tempDir, sessions;

  const startSession = async (config = {}, adapterExtras = {}) => {
    const launch = {
      command: process.execPath,
      args: [FIXTURE, JSON.stringify(config)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      grammarScopes: ["source.js"],
      resolveServer: () => launch,
      ...adapterExtras,
    };
    const session = new ServerSession(manager, adapter, tempDir, launch);
    sessions.push(session);
    await session.start();
    return session;
  };

  const receivedMessages = (session) => session.request("test/getReceived");

  beforeEach(() => {
    // Real timers and Date.now: these specs wait on child-process I/O.
    jasmine.useRealClock();
    manager = new LanguageServerManager();
    sessions = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-client-"));
  });

  afterEach(async () => {
    for (const session of sessions) await session.stop();
    await manager.deactivate();
  });

  it("advertises only utf-16 positions and implemented capabilities", async () => {
    const session = await startSession();
    const received = await receivedMessages(session);
    const initialize = received.find((message) => message.method === "initialize");
    expect(initialize.params.capabilities.general.positionEncodings).toEqual(["utf-16"]);
    expect(initialize.params.capabilities.textDocument.inlayHint).toBeUndefined();
    expect(initialize.params.capabilities.textDocument.semanticTokens).toBeUndefined();
    expect(initialize.params.capabilities.textDocument.codeLens).toBeUndefined();
    // Diagnostic tags are only sent by a server that saw them advertised, so
    // assert this over the real handshake rather than by reading the module.
    expect(initialize.params.capabilities.textDocument.publishDiagnostics.tagSupport).toEqual({
      valueSet: [1, 2],
    });
  });

  it("merges registered capability fragments into the handshake", async () => {
    manager.addCapabilityFragment({ textDocument: { hover: { contentFormat: ["markdown"] } } });
    const session = await startSession();
    const received = await receivedMessages(session);
    const initialize = received.find((message) => message.method === "initialize");
    expect(initialize.params.capabilities.textDocument.hover.contentFormat).toEqual(["markdown"]);
    expect(initialize.params.capabilities.workspace.applyEdit).toBe(true);
  });

  it("pushes workspace configuration after the handshake", async () => {
    const session = await startSession({}, { getSettings: () => ({ example: { size: 2 } }) });
    await until(async () =>
      (await receivedMessages(session)).some(
        (message) => message.method === "workspace/didChangeConfiguration",
      ),
    );
    const received = await receivedMessages(session);
    const initialized = received.findIndex((message) => message.method === "initialized");
    const configured = received.findIndex(
      (message) => message.method === "workspace/didChangeConfiguration",
    );
    expect(initialized).toBeGreaterThan(-1);
    expect(configured).toBeGreaterThan(initialized);
    expect(received[configured].params.settings).toEqual({ example: { size: 2 } });
  });

  it("refuses servers that pick an unsupported position encoding", async () => {
    const launch = {
      command: process.execPath,
      args: [FIXTURE, JSON.stringify({ capabilities: { positionEncoding: "utf-8" } })],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const adapter = {
      id: "fake",
      displayName: "Fake Server",
      grammarScopes: ["source.js"],
      resolveServer: () => launch,
    };
    const session = new ServerSession(manager, adapter, tempDir, launch);
    sessions.push(session);
    await expectAsync(session.start()).toBeRejectedWithError(/position encoding 'utf-8'/);
  });

  it("synchronizes documents incrementally and closes them on detach", async () => {
    const filePath = path.join(tempDir, "example.js");
    fs.writeFileSync(filePath, "const one = 1;\n");
    const session = await startSession({ capabilities: { textDocumentSync: 2 } });
    const editor = await atom.workspace.open(filePath);
    await session.openEditor(editor);
    editor.setTextInBufferRange(
      [
        [0, 6],
        [0, 9],
      ],
      "two",
    );
    session.detachEditor(editor);
    const received = await receivedMessages(session);
    const didOpen = received.find((message) => message.method === "textDocument/didOpen");
    expect(didOpen.params.textDocument.version).toBe(1);
    expect(didOpen.params.textDocument.text).toBe("const one = 1;\n");
    const didChange = received.find((message) => message.method === "textDocument/didChange");
    expect(didChange.params.textDocument.version).toBe(2);
    expect(didChange.params.contentChanges[0].range).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 9 },
    });
    expect(didChange.params.contentChanges[0].text).toBe("two");
    expect(received.some((message) => message.method === "textDocument/didClose")).toBe(true);
  });

  it("sends full text when the server wants full sync", async () => {
    const filePath = path.join(tempDir, "full.js");
    fs.writeFileSync(filePath, "start\n");
    const session = await startSession({ capabilities: { textDocumentSync: 1 } });
    const editor = await atom.workspace.open(filePath);
    await session.openEditor(editor);
    editor.setText("replaced\n");
    const received = await receivedMessages(session);
    const didChange = received.find((message) => message.method === "textDocument/didChange");
    expect(didChange.params.contentChanges).toEqual([{ text: "replaced\n" }]);
  });

  it("routes $/progress to the busy provider", async () => {
    const busy = {
      added: [],
      removed: [],
      add(title) {
        this.added.push(title);
      },
      remove(title) {
        this.removed.push(title);
      },
      changeTitle() {},
      dispose() {},
    };
    manager.setBusyProvider(busy);
    const session = await startSession();
    await session.request("test/notify", {
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "t1", value: { kind: "begin", title: "Indexing" } },
    });
    await until(() => busy.added.length > 0);
    expect(busy.added).toEqual(["Fake Server: Indexing"]);
    await session.request("test/notify", {
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "t1", value: { kind: "end" } },
    });
    await until(() => busy.removed.length > 0);
    expect(busy.removed).toEqual(["Fake Server: Indexing"]);
  });

  it("honors dynamic registrations in supports()", async () => {
    const session = await startSession({ capabilities: { hoverProvider: true } });
    await session.request("test/notify", {
      jsonrpc: "2.0",
      id: 999,
      method: "client/registerCapability",
      params: {
        registrations: [
          {
            id: "reg-1",
            method: "textDocument/formatting",
            registerOptions: { documentSelector: [{ language: "python" }] },
          },
        ],
      },
    });
    await until(() => manager.dynamicCapabilities.has(session));
    const pythonEditor = {
      getGrammar: () => ({ scopeName: "source.python", name: "Python" }),
      getPath: () => path.join(tempDir, "x.py"),
    };
    const jsEditor = {
      getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
      getPath: () => path.join(tempDir, "x.js"),
    };
    expect(session.supports("textDocument/formatting", pythonEditor)).toBe(true);
    expect(session.supports("textDocument/formatting", jsEditor)).toBe(false);
    expect(session.supports("textDocument/hover", jsEditor)).toBe(true);
    expect(session.supports("textDocument/rename", jsEditor)).toBe(false);
  });

  it("marks the session failed when the server dies", async () => {
    const session = await startSession();
    const states = [];
    session.onDidChangeState(({ state }) => states.push(state));
    session.request("test/crash").catch(() => {});
    await until(() => states.includes("failed"));
    expect(session.state).toBe("failed");
  });

  it("lets the server exit on its own rather than killing it mid-frame", async () => {
    const session = await startSession();
    const child = session.process;
    await session.stop();
    expect(session.state).toBe("stopped");
    // `exit` was read and acted on: a killed process reports its signal here.
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  // The report this guards: `exit` is written to a server that is already gone,
  // the write fails a tick later, and an unheard stream error takes down the
  // renderer with "Uncaught Error: write EPIPE".
  it("stops a server whose pipe is already broken without raising", async () => {
    const session = await startSession();
    const child = session.process;
    session.request("test/crash").catch(() => {});
    await until(() => child.exitCode != null || child.signalCode != null);
    await session.stop();
    expect(session.state).toBe("stopped");
    // Reported into the server's log, not thrown at the renderer.
    expect(manager.getLog("fake")).toContain("Could not deliver exit");
  });
});
