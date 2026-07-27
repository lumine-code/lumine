const path = require("path");
const CodeFormatProvider = require("../lib/code-format-provider");
const ReferencesProvider = require("../lib/references-provider");
const RefactorProvider = require("../lib/refactor-provider");
const IntentionsProvider = require("../lib/intentions-provider");

const filePath = path.join(__dirname, "example.js");
const fileUri = require("url").pathToFileURL(filePath).href;

const stubEditor = (lines = ["const value = 1;"]) => ({
  getPath: () => filePath,
  getGrammar: () => ({ scopeName: "source.js", name: "JavaScript" }),
  getTabLength: () => 2,
  getSoftTabs: () => true,
  getBuffer: () => ({ lineForRow: (row) => lines[row] }),
});

const managerWith = (...args) => {
  const extras = args.length && !isSessionLike(args[args.length - 1]) ? args.pop() : {};
  const sessions = args.filter(Boolean);
  return {
    addCapabilityFragment() {},
    allGrammarScopes: () => ["source.js"],
    activeSessionsForEditor: async () => sessions,
    activeSessionForEditor: async () => sessions[0] || null,
    activeSessionForFeature: async (editor, method) =>
      sessions.find((session) => session.supports(method, editor)) || null,
    adapterForEditor: () => (sessions.length ? { id: "stub" } : undefined),
    adaptersForEditor: () => sessions.map((_, index) => ({ id: `stub-${index}` })),
    diagnostics: new Map(),
    diagnosticsFor: () => [],
    applyWorkspaceEdit: async () => true,
    ...extras,
  };
};

const isSessionLike = (value) => !value || typeof value.request === "function";

const sessionWith = (respond, capabilities = {}) => ({
  state: "running",
  capabilities,
  supports: () => true,
  request: async (method, params) => respond(method, params),
});

const lspRange = (row, start, end) => ({
  start: { line: row, character: start },
  end: { line: row, character: end },
});

describe("CodeFormatProvider", () => {
  it("maps formatting edits and editor options", async () => {
    const requests = [];
    const session = sessionWith((method, params) => {
      requests.push({ method, params });
      return [{ range: lspRange(0, 0, 5), newText: "let  " }];
    });
    const provider = new CodeFormatProvider(managerWith(session));
    const edits = await provider.formatFile(stubEditor());
    expect(requests[0].method).toBe("textDocument/formatting");
    expect(requests[0].params.options).toEqual({ tabSize: 2, insertSpaces: true });
    expect(edits).toEqual([
      {
        oldRange: [
          [0, 0],
          [0, 5],
        ],
        newText: "let  ",
      },
    ]);
  });
  it("gates on-type formatting on the server trigger characters", async () => {
    const requests = [];
    const session = sessionWith(
      (method) => {
        requests.push(method);
        return [];
      },
      { documentOnTypeFormattingProvider: { firstTriggerCharacter: "}" } },
    );
    const provider = new CodeFormatProvider(managerWith(session));
    await provider.formatOnType(stubEditor(), { row: 0, column: 1 }, ";");
    expect(requests).toEqual([]);
    await provider.formatOnType(stubEditor(), { row: 0, column: 1 }, "}");
    expect(requests).toEqual(["textDocument/onTypeFormatting"]);
  });
  it("prefers willSaveWaitUntil on save and falls back to formatting", async () => {
    const requests = [];
    const respond = (method) => {
      requests.push(method);
      return [];
    };
    const withWillSave = new CodeFormatProvider(
      managerWith(sessionWith(respond, { textDocumentSync: { willSaveWaitUntil: true } })),
    );
    await withWillSave.formatOnSave(stubEditor());
    expect(requests).toEqual(["textDocument/willSaveWaitUntil"]);
    requests.length = 0;
    const withoutWillSave = new CodeFormatProvider(
      managerWith(sessionWith(respond, { textDocumentSync: 2 })),
    );
    await withoutWillSave.formatOnSave(stubEditor());
    expect(requests).toEqual(["textDocument/formatting"]);
  });
});

describe("ReferencesProvider", () => {
  it("returns the symbol name and mapped references", async () => {
    const session = sessionWith(() => [
      { uri: fileUri, range: lspRange(0, 6, 11) },
      { uri: "untitled:one", range: lspRange(1, 0, 5) },
    ]);
    const provider = new ReferencesProvider(managerWith(session));
    const result = await provider.findReferences(stubEditor(), { row: 0, column: 8 });
    expect(result.symbolName).toBe("value");
    expect(result.references).toEqual([
      {
        path: filePath,
        range: [
          [0, 6],
          [0, 11],
        ],
        name: null,
      },
    ]);
  });
  it("resolves null when a newer request supersedes it", async () => {
    // A session that actually honours the signal, the way the JSON-RPC
    // connection does.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let pending = 0;
    const session = {
      state: "running",
      capabilities: {},
      supports: () => true,
      request: async (_method, _params, { signal } = {}) => {
        if (++pending === 1) {
          await gate;
          if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
        }
        return [{ uri: fileUri, range: lspRange(0, 6, 11) }];
      },
    };
    const provider = new ReferencesProvider(managerWith(session));

    // The cursor rests, then moves again before the server has answered.
    const superseded = provider.findReferences(stubEditor(), { row: 0, column: 8 });
    const current = provider.findReferences(stubEditor(), { row: 0, column: 9 });
    release();

    // Cancelling our own request is not a failure: rejecting here is what put
    // "the reference request failed — signal is aborted without reason" on
    // screen for ordinary cursor movement.
    expect(await superseded).toBeNull();
    expect((await current).references.length).toBe(1);
  });
  it("still rejects when the server genuinely fails", async () => {
    const session = sessionWith(() => {
      throw new Error("server exploded");
    });
    const provider = new ReferencesProvider(managerWith(session));
    let message = null;
    try {
      await provider.findReferences(stubEditor(), { row: 0, column: 8 });
    } catch (error) {
      message = error.message;
    }
    expect(message).toBe("server exploded");
  });
  it("resolves null without a capable session", async () => {
    const provider = new ReferencesProvider(managerWith(null));
    expect(await provider.findReferences(stubEditor(), { row: 0, column: 0 })).toBeNull();
    expect(provider.isEditorSupported(stubEditor())).toBe(false);
  });
  it("merges references from several servers and drops duplicates", async () => {
    const shared = { uri: fileUri, range: lspRange(0, 6, 11) };
    const provider = new ReferencesProvider(
      managerWith(
        sessionWith(() => [shared, { uri: fileUri, range: lspRange(2, 0, 5) }]),
        sessionWith(() => [shared, { uri: fileUri, range: lspRange(4, 1, 4) }]),
      ),
    );
    const result = await provider.findReferences(stubEditor(), { row: 0, column: 8 });
    expect(result.references.map((reference) => reference.range[0][0])).toEqual([0, 2, 4]);
  });
});

describe("multi-server capability routing", () => {
  it("asks the server that supports the feature, not the first one registered", async () => {
    const asked = [];
    const withSupport = (methods, name) => ({
      state: "running",
      capabilities: {},
      supports: (method) => methods.includes(method),
      request: async (method) => {
        asked.push(`${name}:${method}`);
        return [];
      },
    });
    // A linter registered first has no formatting; the type checker behind it
    // does, and must be the one asked.
    const manager = managerWith(
      withSupport(["textDocument/codeAction"], "linter"),
      withSupport(["textDocument/formatting"], "checker"),
    );
    const provider = new CodeFormatProvider(manager);
    await provider.formatFile(stubEditor());
    expect(asked).toEqual(["checker:textDocument/formatting"]);
  });
});

describe("RefactorProvider", () => {
  it("flattens changes and documentChanges into a path map", async () => {
    const session = sessionWith(() => ({
      changes: { [fileUri]: [{ range: lspRange(0, 6, 11), newText: "renamed" }] },
      documentChanges: [
        {
          textDocument: { uri: fileUri, version: 3 },
          edits: [{ range: lspRange(2, 0, 5), newText: "renamed" }],
        },
      ],
    }));
    const provider = new RefactorProvider(managerWith(session));
    const { outcome, edits } = await provider.rename(
      stubEditor(),
      { row: 0, column: 8 },
      "renamed",
    );
    expect(outcome).toBe("edits");
    expect([...edits.keys()]).toEqual([filePath]);
    expect(edits.get(filePath).length).toBe(2);
    expect(edits.get(filePath)[0]).toEqual({
      oldRange: [
        [0, 6],
        [0, 11],
      ],
      newText: "renamed",
    });
  });
  it("applies resource operations itself and reports them as applied", async () => {
    const applied = [];
    const session = sessionWith(() => ({
      changes: { [fileUri]: [{ range: lspRange(0, 6, 11), newText: "next" }] },
      documentChanges: [{ kind: "rename", oldUri: fileUri, newUri: fileUri }],
    }));
    const manager = managerWith(session, {
      applyWorkspaceEdit: async (edit, label) => {
        applied.push(label);
        return true;
      },
    });
    const provider = new RefactorProvider(manager);
    const result = await provider.rename(stubEditor(), { row: 0, column: 8 }, "next");
    expect(result).toEqual({ outcome: "applied", paths: [filePath] });
    expect(applied).toEqual(["Rename to next"]);
  });
  it("reports an aborted apply distinctly from declining to rename", async () => {
    const session = sessionWith(() => ({
      documentChanges: [{ kind: "delete", uri: fileUri }],
    }));
    const manager = managerWith(session, { applyWorkspaceEdit: async () => false });
    const provider = new RefactorProvider(manager);
    // A consumer must not read this as "try the next provider": the user
    // declined the operation, so renaming through another provider would
    // override that decision.
    expect(await provider.rename(stubEditor(), { row: 0, column: 8 }, "next")).toEqual({
      outcome: "aborted",
    });
  });
  it("computes edits without applying resource operations when dry running", async () => {
    const applied = [];
    const session = sessionWith(() => ({
      changes: { [fileUri]: [{ range: lspRange(0, 6, 11), newText: "next" }] },
      documentChanges: [{ kind: "rename", oldUri: fileUri, newUri: fileUri }],
    }));
    const manager = managerWith(session, {
      applyWorkspaceEdit: async () => {
        applied.push("applied");
        return true;
      },
    });
    const provider = new RefactorProvider(manager);
    const result = await provider.rename(stubEditor(), { row: 0, column: 8 }, "next", {
      dryRun: true,
    });
    expect(result.outcome).toBe("edits");
    expect(result.resourceOperations).toBe(true);
    expect([...result.edits.keys()]).toEqual([filePath]);
    expect(applied).toEqual([]);
  });
  it("normalizes the three prepareRename response shapes", async () => {
    const shapes = [
      {
        response: lspRange(0, 6, 11),
        expected: {
          range: [
            [0, 6],
            [0, 11],
          ],
        },
      },
      {
        response: { range: lspRange(0, 6, 11), placeholder: "value" },
        expected: {
          range: [
            [0, 6],
            [0, 11],
          ],
          placeholder: "value",
        },
      },
      {
        response: { defaultBehavior: true },
        expected: {
          range: [
            [0, 6],
            [0, 11],
          ],
        },
      },
    ];
    for (const { response, expected } of shapes) {
      const session = sessionWith(() => response, { renameProvider: { prepareProvider: true } });
      const provider = new RefactorProvider(managerWith(session));
      const result = await provider.prepareRename(stubEditor(), { row: 0, column: 8 });
      expect(result).toEqual(expected);
    }
  });
});

describe("IntentionsProvider", () => {
  it("passes overlapping diagnostics as context and maps priorities", async () => {
    const diagnostic = { range: lspRange(0, 6, 11), message: "unused" };
    const requests = [];
    const session = sessionWith((method, params) => {
      requests.push({ method, params });
      return [
        { title: "Preferred fix", kind: "quickfix", isPreferred: true, edit: {} },
        { title: "Quick fix", kind: "quickfix", edit: {} },
        { title: "Refactor", kind: "refactor.extract", edit: {} },
        { title: "Disabled", kind: "quickfix", disabled: { reason: "no" }, edit: {} },
        { title: "Run tool", command: "tool.run", arguments: [] },
      ];
    });
    const manager = managerWith(session, {
      // Diagnostics are stored per session, and each server is asked with the
      // diagnostics it published itself.
      diagnosticsFor: (candidate, uri) =>
        candidate === session && uri === fileUri ? [diagnostic] : [],
    });
    const provider = new IntentionsProvider(manager);
    const intentions = await provider.getIntentions({
      textEditor: stubEditor(),
      bufferPosition: { row: 0, column: 8 },
    });
    expect(requests[0].params.context.diagnostics).toEqual([diagnostic]);
    expect(requests[0].params.range).toEqual(diagnostic.range);
    expect(intentions.map((item) => item.title)).toEqual([
      "Preferred fix",
      "Quick fix",
      "Refactor",
      "Run tool",
    ]);
    expect(intentions.map((item) => item.priority)).toEqual([100, 80, 60, 40]);
  });
  it("executes bare commands and applies resolved edits", async () => {
    const calls = [];
    const session = sessionWith(
      (method, params) => {
        calls.push({ method, params });
        if (method === "codeAction/resolve") return { ...params, edit: { changes: {} } };
        return null;
      },
      { codeActionProvider: { resolveProvider: true } },
    );
    const applied = [];
    const manager = managerWith(session, {
      applyWorkspaceEdit: async (edit, label) => {
        applied.push(label);
        return true;
      },
    });
    const provider = new IntentionsProvider(manager);
    await provider.applyAction(session, { title: "Bare", command: "tool.run", arguments: [1] });
    expect(calls[0]).toEqual({
      method: "workspace/executeCommand",
      params: { command: "tool.run", arguments: [1] },
    });
    calls.length = 0;
    await provider.applyAction(session, { title: "Lazy", kind: "quickfix" });
    expect(calls[0].method).toBe("codeAction/resolve");
    expect(applied).toEqual(["Lazy"]);
  });
});
