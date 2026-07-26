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
  sessions: new Map(sessions.filter(Boolean).map((session, index) => [`key-${index}`, session])),
});

// An item whose textEdit replaces exactly the typed prefix, as servers report.
const itemWithEdit = (label, endColumn) => ({
  label,
  textEdit: {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: endColumn } },
    newText: label,
  },
});

describe("CompletionProvider item mapping", () => {
  const suggestionFor = async (item) => {
    const provider = new CompletionProvider(managerWith(sessionWith(() => ({ items: [item] }))));
    const suggestions = await provider.getSuggestions({
      editor: stubEditor("con"),
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    return suggestions[0];
  };

  it("renders markdown documentation as markdown", async () => {
    const suggestion = await suggestionFor({
      label: "console",
      documentation: { kind: "markdown", value: "**bold** and `code`" },
    });
    expect(suggestion.descriptionMarkdown).toBe("**bold** and `code`");
    // The plain field stays populated: it is what the popup measures and what
    // any text-only consumer reads.
    expect(suggestion.description).toBe("**bold** and `code`");
  });

  it("leaves plaintext documentation as plain text", async () => {
    const suggestion = await suggestionFor({
      label: "console",
      documentation: { kind: "plaintext", value: "**not bold**" },
    });
    expect(suggestion.descriptionMarkdown).toBeUndefined();
    expect(suggestion.description).toBe("**not bold**");
  });

  it("leaves string documentation as plain text", async () => {
    const suggestion = await suggestionFor({ label: "console", documentation: "plain" });
    expect(suggestion.descriptionMarkdown).toBeUndefined();
    expect(suggestion.description).toBe("plain");
  });

  it("maps labelDetails onto the detail and the right label", async () => {
    const suggestion = await suggestionFor({
      label: "readFile",
      labelDetails: { detail: "(path: string): Buffer", description: "node:fs" },
    });
    expect(suggestion.displayText).toBe("readFile");
    expect(suggestion.displayTextDetail).toBe("(path: string): Buffer");
    expect(suggestion.rightLabel).toBe("node:fs");
  });

  it("passes through the fields autocomplete now understands", async () => {
    const suggestion = await suggestionFor({
      label: "<console>",
      filterText: "console",
      preselect: true,
      commitCharacters: ["(", "."],
    });
    expect(suggestion.filterText).toBe("console");
    expect(suggestion.preselect).toBe(true);
    expect(suggestion.commitCharacters).toEqual(["(", "."]);
  });

  it("inherits commit characters from the list defaults", async () => {
    const provider = new CompletionProvider(
      managerWith(
        sessionWith(() => ({
          itemDefaults: { commitCharacters: ["("] },
          items: [{ label: "own", commitCharacters: ["."] }, { label: "inherited" }],
        })),
      ),
    );
    const suggestions = await provider.getSuggestions({
      editor: stubEditor("con"),
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    const byLabel = Object.fromEntries(suggestions.map((s) => [s.displayText, s]));
    expect(byLabel.inherited.commitCharacters).toEqual(["("]);
    // An item's own list wins over the default.
    expect(byLabel.own.commitCharacters).toEqual(["."]);
  });

  it("strikes through a deprecated item", async () => {
    // The 3.15 tag and the boolean it replaced both mean the same thing, and
    // servers in the field still send either.
    expect((await suggestionFor({ label: "old", tags: [1] })).className).toBe("ide-client-strike");
    expect((await suggestionFor({ label: "old", deprecated: true })).className).toBe(
      "ide-client-strike",
    );
    expect((await suggestionFor({ label: "current" })).className).toBeUndefined();
    // Tag 1 is the only deprecation tag; anything else must not strike.
    expect((await suggestionFor({ label: "current", tags: [2] })).className).toBeUndefined();
  });

  it("advertises deprecated tag support", () => {
    const completionItem = CompletionProvider.capabilities.textDocument.completion.completionItem;
    expect(completionItem.tagSupport.valueSet).toEqual([1]);
  });

  it("advertises labelDetails support", () => {
    const completionItem = CompletionProvider.capabilities.textDocument.completion.completionItem;
    expect(completionItem.labelDetailsSupport).toBe(true);
    expect(completionItem.resolveSupport.properties).toContain("labelDetails");
  });

  it("advertises commit character support", () => {
    const completion = CompletionProvider.capabilities.textDocument.completion;
    expect(completion.completionItem.commitCharactersSupport).toBe(true);
    // A server is free to send the list once for the whole response rather
    // than repeating it on every item.
    expect(completion.completionList.itemDefaults).toContain("commitCharacters");
  });
});

describe("CompletionProvider trigger characters", () => {
  const runningWith = (...triggerCharacters) =>
    sessionWith(() => ({ items: [] }), { completionProvider: { triggerCharacters } });

  it("unions the characters of every running session", () => {
    const provider = new CompletionProvider(managerWith(runningWith("."), runningWith(".", "<")));
    expect([...provider.triggerCharacters]).toEqual([".", "<"]);
  });

  it("ignores sessions that are not running", () => {
    const starting = runningWith("@");
    starting.state = "starting";
    const provider = new CompletionProvider(managerWith(runningWith("."), starting));
    expect([...provider.triggerCharacters]).toEqual(["."]);
  });

  it("ignores a server that advertises none", () => {
    const provider = new CompletionProvider(
      managerWith(sessionWith(() => ({ items: [] }), { completionProvider: {} })),
    );
    expect([...provider.triggerCharacters]).toEqual([]);
  });

  it("answers from the sessions running now, not those running at registration", () => {
    const manager = managerWith();
    const provider = new CompletionProvider(manager);
    expect([...provider.triggerCharacters]).toEqual([]);

    // Servers start well after the provider is handed to autocomplete, which
    // reads this getter on every keystroke for exactly that reason.
    manager.sessions.set("late", runningWith("."));
    expect([...provider.triggerCharacters]).toEqual(["."]);

    manager.sessions.delete("late");
    expect([...provider.triggerCharacters]).toEqual([]);
  });
});

describe("CompletionProvider resolve and commands", () => {
  const resolvingProvider = (respond) => {
    const session = sessionWith(respond, {
      completionProvider: { resolveProvider: true },
    });
    return { session, provider: new CompletionProvider(managerWith(session)) };
  };

  const selectFirst = async (provider, session) => {
    const suggestions = await provider.getSuggestions({
      editor: stubEditor("con"),
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    session.requests.length = 0;
    return suggestions[0];
  };

  it("keeps fields the resolve response leaves out", async () => {
    const { session, provider } = resolvingProvider((method) =>
      method === "completionItem/resolve"
        ? // A sparse response: only documentation came back.
          { label: "console", documentation: "docs" }
        : {
            items: [
              {
                label: "console",
                detail: "the console",
                additionalTextEdits: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    newText: "import x\n",
                  },
                ],
              },
            ],
          },
    );
    const first = await selectFirst(provider, session);
    expect(first.additionalTextEdits.length).toBe(1);

    const detailed = await provider.getSuggestionDetailsOnSelect(first);
    expect(detailed.description).toBe("docs");
    // Spreading the sparse response wholesale would drop both of these.
    expect(detailed.leftLabel).toBe("the console");
    expect(detailed.additionalTextEdits.length).toBe(1);
  });

  it("resolves an item only once", async () => {
    const { session, provider } = resolvingProvider((method) =>
      method === "completionItem/resolve"
        ? { label: "console", documentation: "docs" }
        : { items: [{ label: "console" }] },
    );
    const first = await selectFirst(provider, session);
    const detailed = await provider.getSuggestionDetailsOnSelect(first);
    await provider.getSuggestionDetailsOnSelect(detailed);
    expect(session.requests.length).toBe(1);
  });

  it("cancels a resolve that the next selection supersedes", async () => {
    const { session, provider } = resolvingProvider(async (method, _params, options) => {
      if (method !== "completionItem/resolve") return { items: [{ label: "console" }] };
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (options?.signal?.aborted) throw new Error("cancelled");
      return { label: "console", documentation: "docs" };
    });
    const first = await selectFirst(provider, session);
    jasmine.useRealClock();

    const stale = provider.getSuggestionDetailsOnSelect(first);
    const fresh = provider.getSuggestionDetailsOnSelect({ ...first });
    // The superseded request resolves to the item it was given, unchanged.
    expect((await stale).description).toBeUndefined();
    expect((await fresh).description).toBe("docs");
  });

  it("answers a client-side command in the editor instead of the server", async () => {
    const { session, provider } = resolvingProvider(() => ({
      items: [{ label: "console", command: { command: "editor.action.triggerSuggest" } }],
    }));
    const suggestion = await selectFirst(provider, session);
    const editor = { getPath: () => filePath };
    spyOn(atom.commands, "dispatch");
    spyOn(atom.views, "getView").and.returnValue("view");

    provider.onDidInsertSuggestion({ editor, suggestion });
    expect(atom.commands.dispatch).toHaveBeenCalledWith("view", "autocomplete:activate");
    expect(session.requests.length).toBe(0);
  });

  it("reports a server command that fails", async () => {
    const { session, provider } = resolvingProvider((method) => {
      if (method === "workspace/executeCommand") throw new Error("no such command");
      return { items: [{ label: "console", command: { command: "server.doThing" } }] };
    });
    const suggestion = await selectFirst(provider, session);
    jasmine.useRealClock();

    provider.onDidInsertSuggestion({ editor: stubEditor("con"), suggestion });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const warning = atom.notifications
      .getNotifications()
      .find((n) => n.getMessage().includes("server.doThing"));
    expect(warning).toBeDefined();
  });
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

  it("picks the insert or replace range according to consumeSuffix", async () => {
    const insertReplace = {
      label: "console",
      textEdit: {
        insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        newText: "console",
      },
    };
    const editor = stubEditor("console");

    atom.config.set("autocomplete.consumeSuffix", true);
    let provider = new CompletionProvider(
      managerWith(sessionWith(() => ({ items: [insertReplace] }))),
    );
    let result = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    // Replacing the whole identifier is what consuming the suffix means;
    // taking `insert` here strands "nsole" and yields "consolensole".
    expect(result[0].textEdit.range[1]).toEqual([0, 7]);

    atom.config.set("autocomplete.consumeSuffix", false);
    provider = new CompletionProvider(managerWith(sessionWith(() => ({ items: [insertReplace] }))));
    result = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 2 },
      prefix: "co",
    });
    expect(result[0].textEdit.range[1]).toEqual([0, 2]);
  });

  it("delegates narrowing to autocomplete and supplies the server's order", async () => {
    const session = sessionWith(() => ({
      items: [
        { label: "setFontName", sortText: "b" },
        { label: "unrelated", sortText: "a" },
      ],
    }));
    const provider = new CompletionProvider(managerWith(session));
    expect(provider.filterSuggestions).toBe(true);
    const editor = stubEditor("sfn");

    const first = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 1 },
      prefix: "s",
    });
    expect(first.map((s) => s.sortText)).toEqual(["a", "b"]);

    // The cache path must hand back everything: filtering here on a substring
    // would drop `setFontName` for the subsequence query `sfn`, which the
    // scorer in autocomplete is what should judge.
    const cached = await provider.getSuggestions({
      editor,
      bufferPosition: { row: 0, column: 3 },
      prefix: "sfn",
    });
    expect(session.requests.length).toBe(1);
    expect(cached.length).toBe(2);
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
