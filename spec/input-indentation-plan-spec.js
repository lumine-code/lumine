const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

describe("Input indentation plans", () => {
  let editor, service;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    service = new Service(lumine.grammars);
    editor = lumine.workspace.buildTextEditor({ autoIndent: true, tabLength: 4, softTabs: true });
  });

  afterEach(async () => {
    editor.destroy();
    await service.dispose();
  });

  async function start(text) {
    editor.setText(text);
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.python"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    await editor.whenGrammarSettled();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    editor.getBuffer().clearUndoStack();
    return mode;
  }

  it("plans every cursor together and publishes final input in one history step", async () => {
    const original = "class First:\n    field = 1\nclass Second:\n    field = 2";
    const mode = await start(original);
    editor.setSelectedBufferRanges([
      [
        [0, 12],
        [0, 12],
      ],
      [
        [2, 13],
        [2, 13],
      ],
    ]);
    const before = editor.getSelectedBufferRanges();
    const plan = spyOn(mode, "prepareInputIndentation").and.callThrough();
    const stream = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    const publications = [];
    editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
    await editor.insertNewline();
    const expected = "class First:\n    \n    field = 1\nclass Second:\n    \n    field = 2";
    expect(plan).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
    expect(publications).toEqual([expected]);
    expect(editor.getCursorBufferPositions().map((point) => point.serialize())).toEqual([
      [1, 4],
      [4, 4],
    ]);
    const request = plan.calls.mostRecent().args[0];
    expect(request.ranges).toEqual([
      [1, 1],
      [4, 4],
    ]);
    expect(request.changes.length).toBe(2);
    expect(request.options.rowOptions instanceof Map).toBe(true);
    expect(request.options.isPastedText).toBe(false);
    expect(typeof request.signal.aborted).toBe("boolean");
    expect(typeof request.isCurrent).toBe("function");
    expect(request.options.signal).toBeUndefined();
    expect(request.options.isCurrent).toBeUndefined();
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(editor.getSelectedBufferRanges()).toEqual(before);
    editor.redo();
    expect(editor.getText()).toBe(expected);
  });

  it("keeps automatic dedent on the bounded input API", async () => {
    const original = "if ready:\n    work()\n    els";
    const mode = await start(original);
    editor.setCursorBufferPosition([2, Infinity]);
    const plan = spyOn(mode, "prepareInputIndentation").and.callThrough();
    const stream = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    const publications = [];
    editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
    await editor.insertText("e");
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.calls.mostRecent().args[0].options.rowOptions.get(2).edited).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect(publications).toEqual(["if ready:\n    work()\nelse"]);
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("keeps mutations beyond the input row bound on the cooperative stream", async () => {
    const original = "value = 1\n".repeat(129);
    const mode = await start(original);
    editor.setSelectedBufferRanges(
      Array.from({ length: 129 }, (_, row) => [
        [row, 9],
        [row, 9],
      ]),
    );
    const before = editor.getSelectedBufferRanges();
    const plan = spyOn(mode, "prepareInputIndentation").and.callThrough();
    const stream = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    await editor.insertNewline();
    expect(plan).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("value = 1\n\n".repeat(129));
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(editor.getSelectedBufferRanges()).toEqual(before);
  });

  it("keeps multiline paste on the range API even when its result is small", async () => {
    const original = "class Record:\n    \n";
    const mode = await start(original);
    editor.setCursorBufferPosition([1, 4]);
    const plan = spyOn(mode, "prepareInputIndentation").and.callThrough();
    const stream = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    await editor.pasteText({
      autoIndent: true,
      clipboard: { readWithMetadata: () => ({ text: "first = 1\nsecond = 2" }) },
    });
    expect(plan).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("class Record:\n    first = 1\n    second = 2\n");
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("uses the range API when a language mode does not provide input planning", async () => {
    const mode = await start("class Record:");
    mode.prepareInputIndentation = undefined;
    editor.setCursorBufferPosition([0, Infinity]);
    const stream = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    await editor.insertNewline();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("class Record:\n    ");
    editor.undo();
    expect(editor.getText()).toBe("class Record:");
  });

  for (const [name, result] of [
    ["unknown result kind", { kind: "partial", levels: [[1, 1]] }],
    ["missing levels", { kind: "ready" }],
    ["missing row", { kind: "ready", levels: [] }],
    ["wrong row", { kind: "ready", levels: [[2, 1]] }],
    [
      "duplicate row",
      {
        kind: "ready",
        levels: [
          [1, 1],
          [1, 1],
        ],
      },
    ],
    ["negative level", { kind: "ready", levels: [[1, -1]] }],
  ])
    it(`rejects a ${name} without publishing input or history`, async () => {
      const original = "class Record:";
      const mode = await start(original);
      editor.setCursorBufferPosition([0, Infinity]);
      const before = editor.getSelectedBufferRanges();
      spyOn(mode, "prepareInputIndentation").and.resolveTo(result);
      const stream = spyOn(mode, "scanPreparedIndentation").and.callThrough();
      const publications = [];
      editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
      await expectAsync(editor.insertNewline()).toBeRejectedWithError();
      expect(stream).not.toHaveBeenCalled();
      expect(publications).toEqual([]);
      expect(editor.getText()).toBe(original);
      expect(editor.getSelectedBufferRanges()).toEqual(before);
      expect(editor.hasPendingIndentation()).toBe(false);
      editor.undo();
      expect(editor.getText()).toBe(original);
    });
});
