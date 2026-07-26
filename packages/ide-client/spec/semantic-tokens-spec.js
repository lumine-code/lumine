const path = require("path");
const os = require("os");
const { Emitter } = require("atom");
const SemanticTokens = require("../lib/semantic-tokens");
const { createScopeMap } = require("../lib/semantic-scope-map");

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

const legend = {
  tokenTypes: ["keyword", "variable", "string", "function"],
  tokenModifiers: ["deprecated", "defaultLibrary"],
};

describe("SemanticTokens", () => {
  let editor, semanticTokens, tracker;

  // The spec harness renders editors synchronously, so decorations are in the
  // DOM as soon as the fetch chain settles — no update promise to await.
  const attach = async (session) => {
    const manager = makeManager(session);
    semanticTokens = new SemanticTokens(manager, tracker);
    await flush();
    return manager;
  };

  beforeEach(async () => {
    const workspaceElement = atom.workspace.getElement();
    workspaceElement.style.width = "800px";
    workspaceElement.style.height = "400px";
    jasmine.attachToDOM(workspaceElement);
    editor = await atom.workspace.open(path.join(os.tmpdir(), "semantic-tokens-example.js"));
    editor.setText("const one = 1;\nlet two = 2;\n");
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    tracker = makeTracker();
  });

  afterEach(() => semanticTokens?.dispose());

  it("stays inert without the config opt-in", async () => {
    const session = makeSession(() => ({ data: [0, 0, 5, 0, 0] }), {
      semanticTokensProvider: { legend, full: true },
    });
    await attach(session);
    expect(session.requests.length).toBe(0);
    expect(editor.getElement().querySelectorAll(".ide-client-semantic-token").length).toBe(0);
  });

  it("decodes the packed array into text decorations with mapped syntax classes", async () => {
    atom.config.set("ide-client.semanticTokens.enabled", true);
    // "const"(keyword), "one"(variable), then "two"(variable, deprecated).
    const data = [0, 0, 5, 0, 0, 0, 6, 3, 1, 0, 1, 4, 3, 1, 1];
    const session = makeSession(
      (method) => (method === "textDocument/semanticTokens/full" ? { resultId: "r1", data } : null),
      { semanticTokensProvider: { legend, full: true } },
    );
    await attach(session);
    const spans = editor.getElement().querySelectorAll(".line .ide-client-semantic-token");
    const byText = new Map([...spans].map((span) => [span.textContent, span]));
    expect(byText.get("const").classList.contains("syntax--keyword")).toBe(true);
    expect(byText.get("one").classList.contains("syntax--variable")).toBe(true);
    expect(byText.get("two").classList.contains("syntax--variable")).toBe(true);
    expect(byText.get("two").classList.contains("ide-client-strike")).toBe(true);
    expect(byText.get("const").classList.contains("ide-client-strike")).toBe(false);
  });

  it("applies semantic token deltas to the stored data", async () => {
    atom.config.set("ide-client.semanticTokens.enabled", true);
    const data = [0, 0, 5, 0, 0, 0, 6, 3, 1, 0];
    const session = makeSession(
      (method) => {
        if (method === "textDocument/semanticTokens/full") return { resultId: "r1", data };
        if (method === "textDocument/semanticTokens/full/delta")
          // Retype the first token from keyword to string.
          return { resultId: "r2", edits: [{ start: 3, deleteCount: 1, data: [2] }] };
        return null;
      },
      { semanticTokensProvider: { legend, full: { delta: true } } },
    );
    await attach(session);
    editor.setTextInBufferRange(
      [
        [1, 12],
        [1, 12],
      ],
      " ",
    );
    advanceClock(editor.getBuffer().stoppedChangingDelay + 1);
    await flush();
    const delta = session.requests.find(
      ({ method }) => method === "textDocument/semanticTokens/full/delta",
    );
    expect(delta.params.previousResultId).toBe("r1");
    const state = semanticTokens.states.get(editor);
    expect(state.data).toEqual([0, 0, 5, 2, 0, 0, 6, 3, 1, 0]);
    expect(state.resultId).toBe("r2");
    const spans = editor.getElement().querySelectorAll(".line .ide-client-semantic-token");
    const constSpan = [...spans].find((span) => span.textContent === "const");
    expect(constSpan.classList.contains("syntax--string")).toBe(true);
    expect(constSpan.classList.contains("syntax--keyword")).toBe(false);
  });

  it("falls back to viewport range mode past the token budget", async () => {
    atom.config.set("ide-client.semanticTokens.enabled", true);
    const bigData = [];
    for (let i = 0; i < 20001; i++) bigData.push(0, 1, 1, 0, 0);
    const session = makeSession(
      (method) => {
        if (method === "textDocument/semanticTokens/full")
          return { resultId: "big", data: bigData };
        if (method === "textDocument/semanticTokens/range")
          return { data: [0, 0, 5, 0, 0, 0, 6, 3, 1, 0] };
        return null;
      },
      { semanticTokensProvider: { legend, full: true, range: true } },
    );
    await attach(session);
    const state = semanticTokens.states.get(editor);
    expect(state.rangeMode).toBe(true);
    expect(session.requests.map(({ method }) => method)).toContain(
      "textDocument/semanticTokens/range",
    );
    expect(state.markers.length).toBe(2);
    // Further viewport changes keep driving range requests.
    tracker.emitStale(editor, [0, 1]);
    await flush();
    const ranges = session.requests.filter(
      ({ method }) => method === "textDocument/semanticTokens/range",
    );
    expect(ranges.length).toBe(2);
    expect(ranges[1].params.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 2, character: 0 },
    });
  });

  it("skips the feature when neither budget nor capability fits", async () => {
    atom.config.set("ide-client.semanticTokens.enabled", true);
    const bigData = [];
    for (let i = 0; i < 20001; i++) bigData.push(0, 1, 1, 0, 0);
    const session = makeSession(
      (method) =>
        method === "textDocument/semanticTokens/full" ? { resultId: "big", data: bigData } : null,
      { semanticTokensProvider: { legend, full: true } },
    );
    await attach(session);
    const state = semanticTokens.states.get(editor);
    expect(state.markers.length).toBe(0);
    expect(state.rangeMode).toBe(false);
  });
});

describe("semantic scope map", () => {
  it("memoizes decoration properties per type and modifier bitset", () => {
    const map = createScopeMap(legend);
    const keyword = map.propertiesFor(0, 0);
    expect(keyword.type).toBe("text");
    expect(keyword.class).toBe("ide-client-semantic-token syntax--keyword");
    expect(map.propertiesFor(0, 0)).toBe(keyword);
    const deprecated = map.propertiesFor(1, 0b01);
    expect(deprecated.class).toBe("ide-client-semantic-token syntax--variable ide-client-strike");
    const library = map.propertiesFor(3, 0b10);
    expect(library.class).toBe(
      "ide-client-semantic-token syntax--entity syntax--name syntax--function syntax--support",
    );
  });

  it("keeps unknown token types on the base class", () => {
    const map = createScopeMap({ tokenTypes: ["somethingCustom"], tokenModifiers: [] });
    expect(map.propertiesFor(0, 0).class).toBe("ide-client-semantic-token");
    expect(map.propertiesFor(5, 0).class).toBe("ide-client-semantic-token");
  });
});
