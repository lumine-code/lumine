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

const managerWith = (session, extras = {}) => ({
  addCapabilityFragment() {},
  allGrammarScopes: () => ["source.js"],
  activeSessionForEditor: async () => session,
  adapterForEditor: () => (session ? { id: "stub" } : undefined),
  diagnostics: new Map(),
  applyWorkspaceEdit: async () => true,
  ...extras,
});

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
  it("resolves null without a capable session", async () => {
    const provider = new ReferencesProvider(managerWith(null));
    expect(await provider.findReferences(stubEditor(), { row: 0, column: 0 })).toBeNull();
    expect(provider.isEditorSupported(stubEditor())).toBe(false);
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
    const map = await provider.rename(stubEditor(), { row: 0, column: 8 }, "renamed");
    expect([...map.keys()]).toEqual([filePath]);
    expect(map.get(filePath).length).toBe(2);
    expect(map.get(filePath)[0]).toEqual({
      oldRange: [
        [0, 6],
        [0, 11],
      ],
      newText: "renamed",
    });
  });
  it("applies resource operations itself and resolves null", async () => {
    const applied = [];
    const session = sessionWith(() => ({
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
    expect(result).toBeNull();
    expect(applied).toEqual(["Rename to next"]);
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
    const manager = managerWith(session);
    manager.diagnostics.set(fileUri, { diagnostics: [diagnostic] });
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
