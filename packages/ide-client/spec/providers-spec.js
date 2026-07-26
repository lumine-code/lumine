const path = require("path");
const HoverProvider = require("../lib/hover-provider");
const SignatureProvider = require("../lib/signature-provider");
const OutlineProvider = require("../lib/outline-provider");

const stubEditor = {
  getPath: () => path.join(__dirname, "example.js"),
  getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
};

const managerWith = (...args) => {
  const sessions = args.filter(Boolean);
  return {
    addCapabilityFragment() {},
    allGrammarScopes: () => ["source.js"],
    activeSessionsForEditor: async () => sessions,
    activeSessionForEditor: async () => sessions[0] || null,
    activeSessionForFeature: async (editor, method) =>
      sessions.find((session) => session.supports(method, editor)) || null,
    sessions: new Map(sessions.map((session, index) => [`key-${index}`, session])),
  };
};

const sessionWith = (result, capabilities = {}) => ({
  state: "running",
  capabilities,
  supports: () => true,
  request: async () => result,
});

describe("HoverProvider", () => {
  const hoverFor = (result) =>
    new HoverProvider(managerWith(sessionWith(result))).hover(stubEditor, { row: 0, column: 1 });

  it("passes MarkupContent through", async () => {
    const result = await hoverFor({ contents: { kind: "plaintext", value: "docs" } });
    expect(result.contents).toEqual({ kind: "plaintext", value: "docs" });
  });
  it("normalizes MarkedString values to markdown", async () => {
    const result = await hoverFor({ contents: { language: "js", value: "const x = 1;" } });
    expect(result.contents).toEqual({ kind: "markdown", value: "```js\nconst x = 1;\n```" });
  });
  it("joins MarkedString arrays", async () => {
    const result = await hoverFor({ contents: ["first", { language: "js", value: "second" }] });
    expect(result.contents.value).toBe("first\n\n```js\nsecond\n```");
  });
  it("converts the optional range", async () => {
    const result = await hoverFor({
      contents: "docs",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    });
    expect(result.range).toEqual([
      [1, 2],
      [1, 5],
    ]);
  });
  it("returns null for empty responses and missing sessions", async () => {
    expect(await hoverFor(null)).toBeNull();
    expect(await hoverFor({ contents: "" })).toBeNull();
    const provider = new HoverProvider(managerWith(null));
    expect(await provider.hover(stubEditor, { row: 0, column: 0 })).toBeNull();
  });
  it("stacks the answers of every server serving the editor", async () => {
    const provider = new HoverProvider(
      managerWith(
        sessionWith({ contents: { kind: "markdown", value: "the type" } }),
        sessionWith({ contents: { kind: "markdown", value: "the lint rule" } }),
      ),
    );
    const result = await provider.hover(stubEditor, { row: 0, column: 1 });
    expect(result.contents.value).toBe("the type\n\n---\n\nthe lint rule");
  });
  it("collapses identical answers from several servers", async () => {
    const provider = new HoverProvider(
      managerWith(sessionWith({ contents: "same" }), sessionWith({ contents: "same" })),
    );
    const result = await provider.hover(stubEditor, { row: 0, column: 1 });
    expect(result.contents.value).toBe("same");
  });
});

describe("SignatureProvider", () => {
  it("collects trigger characters from running sessions", () => {
    const session = sessionWith(null, {
      signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [")"] },
    });
    const provider = new SignatureProvider(managerWith(session));
    expect([...provider.triggerCharacters]).toEqual(["(", ","]);
    expect([...provider.retriggerCharacters]).toEqual([")"]);
  });
  it("returns the raw SignatureHelp result with a default context", async () => {
    const help = { signatures: [{ label: "fn(a)" }], activeSignature: 0, activeParameter: 0 };
    const session = sessionWith(help);
    const requests = [];
    session.request = async (method, params) => {
      requests.push({ method, params });
      return help;
    };
    const provider = new SignatureProvider(managerWith(session));
    const result = await provider.getSignature(stubEditor, { row: 0, column: 4 });
    expect(result).toBe(help);
    expect(requests[0].method).toBe("textDocument/signatureHelp");
    expect(requests[0].params.context).toEqual({ triggerKind: 1, isRetrigger: false });
  });
});

describe("OutlineProvider", () => {
  it("maps hierarchical DocumentSymbol results", async () => {
    const symbols = [
      {
        name: "Outer",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        children: [
          {
            name: "inner",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
          },
        ],
      },
    ];
    const provider = new OutlineProvider(managerWith(sessionWith(symbols)));
    const { outlineTrees } = await provider.getOutline(stubEditor);
    expect(outlineTrees.length).toBe(1);
    expect(outlineTrees[0].kind).toBe("class");
    expect(outlineTrees[0].plainText).toBe("Outer");
    expect(outlineTrees[0].startPosition).toEqual([0, 6]);
    expect(outlineTrees[0].endPosition).toEqual([9, 1]);
    expect(outlineTrees[0].children[0].plainText).toBe("inner");
    expect(outlineTrees[0].children[0].kind).toBe("method");
  });
  it("nests flat SymbolInformation results by container name", async () => {
    const location = (line) => ({
      uri: "file:///project/example.js",
      range: { start: { line, character: 0 }, end: { line, character: 5 } },
    });
    const symbols = [
      { name: "Outer", kind: 5, location: location(0) },
      { name: "inner", kind: 12, location: location(1), containerName: "Outer" },
      { name: "loose", kind: 13, location: location(5), containerName: "Missing" },
    ];
    const provider = new OutlineProvider(managerWith(sessionWith(symbols)));
    const { outlineTrees } = await provider.getOutline(stubEditor);
    expect(outlineTrees.map((node) => node.plainText)).toEqual(["Outer", "loose"]);
    expect(outlineTrees[0].children.map((node) => node.plainText)).toEqual(["inner"]);
  });
  it("returns empty trees for empty results and null without a session", async () => {
    const provider = new OutlineProvider(managerWith(sessionWith([])));
    expect(await provider.getOutline(stubEditor)).toEqual({ outlineTrees: [] });
    const missing = new OutlineProvider(managerWith(null));
    expect(await missing.getOutline(stubEditor)).toBeNull();
  });
});
