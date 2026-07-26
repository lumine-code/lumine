const path = require("path");
const os = require("os");
const { Emitter } = require("atom");
const CodeLens = require("../lib/code-lens");

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const makeTracker = () => {
  const emitter = new Emitter();
  return {
    onDidBecomeStale: (fn) => emitter.on("stale", fn),
    rangeForEditor: (editor) => [0, editor.getBuffer().getLastRow()],
    emitStale: (editor, range) => emitter.emit("stale", { editor, range }),
  };
};

const makeManager = (session) => {
  const emitter = new Emitter();
  return {
    addCapabilityFragment() {},
    activeSessionForEditor: async () => session,
    onDidRequestRefresh: (fn) => emitter.on("refresh", fn),
    onDidChangeSession: (fn) => emitter.on("session", fn),
    requestRefresh: (refreshSession, kind) =>
      emitter.emit("refresh", { session: refreshSession, kind }),
  };
};

const makeSession = (respond, capabilities = {}) => ({
  state: "running",
  capabilities,
  supports: () => true,
  requests: [],
  request(method, params) {
    this.requests.push({ method, params });
    return Promise.resolve(respond(method, params));
  },
});

const lensAt = (row, title, extra = {}) => ({
  range: { start: { line: row, character: 0 }, end: { line: row, character: 1 } },
  ...(title ? { command: { title, command: "test.command", arguments: [row] } } : {}),
  ...extra,
});

describe("CodeLens", () => {
  let editor, codeLens, tracker;

  // The spec harness renders editors synchronously, so decorations are in the
  // DOM as soon as the fetch chain settles — no update promise to await.
  const attach = async (session) => {
    codeLens = new CodeLens(makeManager(session), tracker);
    await flush();
  };

  beforeEach(async () => {
    atom.config.set("ide-client.codeLens.enabled", true);
    const workspaceElement = atom.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await atom.workspace.open(path.join(os.tmpdir(), "code-lens-example.js"));
    editor.setText("function one() {}\nfunction two() {}\nfunction three() {}\n");
    tracker = makeTracker();
  });

  afterEach(() => codeLens?.dispose());

  it("renders lenses as block decorations grouped per row", async () => {
    const session = makeSession((method) =>
      method === "textDocument/codeLens"
        ? [lensAt(0, "3 references"), lensAt(0, "run test"), lensAt(2, "1 reference")]
        : null,
    );
    await attach(session);
    const items = editor.getElement().querySelectorAll(".ide-client-code-lens");
    expect(items.length).toBe(2);
    const texts = [...items].map((item) => [...item.children].map((a) => a.textContent));
    expect(texts).toContain(["3 references", "run test"]);
    expect(texts).toContain(["1 reference"]);
    const state = codeLens.states.get(editor);
    expect([...state.rows.keys()].sort()).toEqual([0, 2]);
    expect(state.rows.get(0).decoration.getProperties().type).toBe("block");
    expect(state.rows.get(0).decoration.getProperties().position).toBe("before");
  });

  it("shows a placeholder for unresolved lenses and resolves them on viewport entry", async () => {
    const session = makeSession(
      (method, params) => {
        if (method === "textDocument/codeLens") return [lensAt(1, null, { data: 7 })];
        if (method === "codeLens/resolve")
          return { ...params, command: { title: "Resolved", command: "test.resolved" } };
        return null;
      },
      { codeLensProvider: { resolveProvider: true } },
    );
    await attach(session);
    const entry = codeLens.states.get(editor).rows.get(1);
    expect(entry.item.children[0].textContent).toBe("…");
    tracker.emitStale(editor, [0, 2]);
    await flush();
    expect(session.requests.map(({ method }) => method)).toContain("codeLens/resolve");
    expect(entry.item.children[0].textContent).toBe("Resolved");
    // A second pass must not resolve the same lens again.
    tracker.emitStale(editor, [0, 2]);
    await flush();
    const resolves = session.requests.filter(({ method }) => method === "codeLens/resolve");
    expect(resolves.length).toBe(1);
  });

  it("refreshes in place, keeping marker and item identity for surviving rows", async () => {
    let lenses = [lensAt(0, "2 references"), lensAt(2, "old row")];
    const session = makeSession((method) => (method === "textDocument/codeLens" ? lenses : null));
    const manager = makeManager(session);
    codeLens = new CodeLens(manager, tracker);
    await flush();
    const state = codeLens.states.get(editor);
    const survivor = state.rows.get(0);
    const removed = state.rows.get(2);
    lenses = [lensAt(0, "3 references"), lensAt(1, "new row")];
    manager.requestRefresh(session, "codeLens");
    await flush();
    expect(state.rows.get(0)).toBe(survivor);
    expect(state.rows.get(0).marker.isDestroyed()).toBe(false);
    expect(state.rows.get(0).decoration).toBe(survivor.decoration);
    expect(state.rows.get(0).item.children[0].textContent).toBe("3 references");
    expect(removed.marker.isDestroyed()).toBe(true);
    expect([...state.rows.keys()].sort()).toEqual([0, 1]);
  });

  it("executes the lens command on click and ignores placeholders", async () => {
    const session = makeSession((method) =>
      method === "textDocument/codeLens" ? [lensAt(0, "run test"), lensAt(1, null)] : null,
    );
    await attach(session);
    const anchor = editor.getElement().querySelector(".ide-client-code-lens a");
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    const executed = session.requests.find(({ method }) => method === "workspace/executeCommand");
    expect(executed.params).toEqual({ command: "test.command", arguments: [0] });
    const placeholder = codeLens.states.get(editor).rows.get(1).item.children[0];
    placeholder.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    const executions = session.requests.filter(
      ({ method }) => method === "workspace/executeCommand",
    );
    expect(executions.length).toBe(1);
  });

  it("renders nothing when the scoped config disables it", async () => {
    atom.config.set("ide-client.codeLens.enabled", false);
    const session = makeSession(() => [lensAt(0, "hidden")]);
    await attach(session);
    expect(session.requests.length).toBe(0);
    expect(codeLens.states.get(editor).rows.size).toBe(0);
  });
});
