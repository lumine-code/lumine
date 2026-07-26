const path = require("path");
const CompletionProvider = require("../lib/completion-provider");

const filePath = path.join(__dirname, "example.ts");

const stubEditor = (line = "con") => ({
  getPath: () => filePath,
  getGrammar: () => ({ scopeName: "source.ts", name: "TypeScript" }),
  getTextInBufferRange: ([start, end]) => line.slice(start[1], end[1]),
});

const sessionWith = (respond, capabilities = { completionProvider: {} }) => ({
  state: "running",
  capabilities,
  supports: () => true,
  requests: [],
  async request(method, params, options) {
    this.requests.push({ method, params, options });
    return respond(method, params, options);
  },
});

const managerWith = (...sessions) => ({
  addCapabilityFragment() {},
  allGrammarScopes: () => ["source.ts"],
  activeSessionsForEditor: async () => sessions.filter(Boolean),
  activeSessionForEditor: async () => sessions[0] || null,
});

// An item whose textEdit replaces exactly the typed prefix, as servers report.
const itemWithEdit = (label, endColumn) => ({
  label,
  textEdit: {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: endColumn } },
    newText: label,
  },
});

describe("CompletionProvider caching", () => {
  it("grows the cached edit range as the user keeps typing", async () => {
    const session = sessionWith(() => ({
      isIncomplete: false,
      items: [itemWithEdit("console", 2)],
    }));
    const provider = new CompletionProvider(managerWith(session));
    const editor = stubEditor("con");

    // First request at column 2, having typed "co".
    const first = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    expect(first[0].textEdit.range).toEqual([
      [0, 0],
      [0, 2],
    ]);

    // One more character: the cache answers, but the replaced span must now
    // cover "con" too. Leaving it at column 2 inserts "console" over "co" and
    // strands the "n", producing "consolen".
    const second = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 3 },
      prefix: "con",
    });
    expect(session.requests.length).toBe(1);
    expect(second[0].textEdit.range).toEqual([
      [0, 0],
      [0, 3],
    ]);
    expect(second[0].textEdit.newText).toBe("console");
  });

  it("re-anchors from the original range rather than compounding", async () => {
    const session = sessionWith(() => ({ items: [itemWithEdit("console", 2)] }));
    const provider = new CompletionProvider(managerWith(session));
    const editor = stubEditor("cons");
    await provider.getSuggestions({ editor, bufferPosition: { row: 0, column: 2 }, prefix: "co" });
    await provider.getSuggestions({ editor, bufferPosition: { row: 0, column: 3 }, prefix: "con" });
    const third = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 4 },
      prefix: "cons",
    });
    expect(third[0].textEdit.range).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("leaves suggestions without an edit range untouched", async () => {
    const session = sessionWith(() => ({ items: [{ label: "console" }] }));
    const provider = new CompletionProvider(managerWith(session));
    const editor = stubEditor("con");
    await provider.getSuggestions({ editor, bufferPosition: { row: 0, column: 2 }, prefix: "co" });
    const second = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 3 },
      prefix: "con",
    });
    expect(second[0].textEdit).toBeUndefined();
    expect(second[0].text).toBe("console");
  });

  it("does not cache the empty result of a superseded request", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const session = sessionWith(async (_method, _params, options) => {
      // The first request hangs until the second one has aborted it.
      if (session.requests.length === 1) {
        await gate;
        if (options.signal.aborted) throw new Error("cancelled");
      }
      return { items: [itemWithEdit("console", 3)] };
    });
    const provider = new CompletionProvider(managerWith(session));
    const editor = stubEditor("con");

    const stale = provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    const fresh = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 3 },
      prefix: "con",
    });
    release();
    expect(await stale).toEqual([]);
    expect(fresh.length).toBe(1);

    // The aborted request must not have replaced the good cache with an empty
    // one, which would starve every later keystroke of this word.
    const next = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 4 },
      prefix: "cons",
    });
    expect(next.length).toBe(1);
  });

  it("does not cache when every server failed", async () => {
    const session = sessionWith(() => {
      throw new Error("server exploded");
    });
    const provider = new CompletionProvider(managerWith(session));
    const editor = stubEditor("con");
    expect(
      await provider.getSuggestions({
        editor,
        bufferPosition: { row: 0, column: 2 },
        prefix: "co",
      }),
    ).toEqual([]);
    // A cached failure would stop the next keystroke from asking again.
    await provider.getSuggestions({ editor, bufferPosition: { row: 0, column: 3 }, prefix: "con" });
    expect(session.requests.length).toBe(2);
  });
});
