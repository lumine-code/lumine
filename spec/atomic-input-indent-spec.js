const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const dispatchInput = require("../src/text-editor-input-queue");

describe("Atomic input indentation", () => {
  let editor, service;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-javascript");
    service = new Service(lumine.grammars);
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
  });
  afterEach(async () => {
    editor.destroy();
    await service.dispose();
  });
  async function start(text, scope = "source.python") {
    editor.setText(text);
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName(scope),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
    return mode;
  }
  function hold() {
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const ready = new Promise((resolve) => (entered = resolve));
    const request = service.client.request.bind(service.client);
    spyOn(service.client, "request").and.callFake(async (operation, ...args) => {
      const result = request(operation, ...args);
      if (operation === "prepared-indent") {
        entered();
        await gate;
      }
      return result;
    });
    return { release, ready };
  }

  it("prepares distant cursors without scanning the private editor's preceding rows", async () => {
    const source = "value = 1\n".repeat(12020);
    await start(source);
    editor.foldBufferRange([
      [2000, 0],
      [5000, 0],
    ]);
    const positions = [100, 6000, 12000].map((row) => [row, 9]);
    editor.setSelectedBufferRanges(positions.map((position) => [position, position]));
    const DisplayLayer = require("../src/display-layer");
    const update = DisplayLayer.prototype.updateSpatialIndex;
    const privateScans = [];
    spyOn(DisplayLayer.prototype, "updateSpatialIndex").and.callFake(function (...args) {
      if (this.buffer !== editor.getBuffer() && this.softWrapColumn !== Infinity)
        privateScans.push(args);
      return update.apply(this, args);
    });
    await editor.insertNewline();
    expect(privateScans).toEqual([]);
    const expected = source.split("\n");
    for (const [row] of positions.slice().reverse()) expected.splice(row + 1, 0, "");
    expect(editor.getText()).toBe(expected.join("\n"));
    expect(editor.getCursorBufferPositions().map((position) => position.serialize())).toEqual([
      [101, 0],
      [6002, 0],
      [12003, 0],
    ]);
    editor.undo();
    expect(editor.getText()).toBe(source);
    expect(editor.getCursorBufferPositions().map((position) => position.serialize())).toEqual(
      positions,
    );
    editor.redo();
    expect(editor.getText()).toBe(expected.join("\n"));
  });

  it("moves a complete long buffer line without introducing private safety-wrap boundaries", async () => {
    const long = "# " + "x".repeat(1200) + "🦉";
    const source = "head = 1\n" + long + "\ntail = 2";
    await start(source);
    editor.setCursorBufferPosition([1, 700]);
    await editor.moveLineUp();
    expect(editor.getText()).toBe(long + "\nhead = 1\ntail = 2");
    expect(editor.getCursorBufferPosition()).toEqual([0, 700]);
    editor.undo();
    expect(editor.getText()).toBe(source);
    expect(editor.getCursorBufferPosition()).toEqual([1, 700]);
    editor.redo();
    expect(editor.getText()).toBe(long + "\nhead = 1\ntail = 2");
  });

  it("keeps ordinary Python typing synchronous without indentation requests", async () => {
    await start("class Record:\n    field = ");
    editor.setCursorBufferPosition([1, Infinity]);
    const request = spyOn(service.client, "request").and.callThrough();
    for (const character of "hello_world_1234567890") {
      const result = editor.insertText(character);
      expect(Boolean(result?.then)).toBe(false);
    }
    expect(editor.getText()).toBe("class Record:\n    field = hello_world_1234567890");
    expect(request.calls.allArgs().some(([operation]) => operation === "prepared-indent")).toBe(
      false,
    );
  });

  it("lets a live insertion observer cancel prepared input once without creating history", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    let attempts = 0;
    editor.onWillInsertText((event) => {
      attempts++;
      event.cancel();
    });
    expect(await editor.insertNewline()).toBe(false);
    expect(attempts).toBe(1);
    expect(editor.getText()).toBe("class Record:");
    editor.undo();
    expect(editor.getText()).toBe("class Record:");
  });

  it("rejects asynchronous preparation hooks before publication", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    editor.onWillPublishTextInsertion(() => Promise.reject(new Error("async cleanup")));
    await expectAsync(editor.insertNewline()).toBeRejectedWithError(
      TypeError,
      "Insertion preparation callbacks must be synchronous",
    );
    expect(editor.getText()).toBe("class Record:");
  });

  it("keeps a replacement queued by an insertion-cancellation observer", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    let replacement;
    editor.onWillInsertText((event) => {
      if (event.text !== "\n") return;
      replacement = editor.insertText(" # replacement");
      event.cancel();
    });
    expect(await editor.insertNewline()).toBe(false);
    await replacement;
    expect(editor.getText()).toBe("class Record: # replacement");
  });

  for (const scenario of [
    {
      name: "Python else",
      text: "if ready:\n    work()\n    els",
      input: "e",
      expected: "if ready:\n    work()\nelse",
    },
    {
      name: "JavaScript closing brace",
      text: "if (ready) {\n    ",
      input: "}",
      expected: "if (ready) {\n}",
      scope: "source.js",
    },
  ])
    it(`publishes ${scenario.name} together with its dedent`, async () => {
      await start(scenario.text, scenario.scope);
      editor.moveToBottom();
      editor.moveToEndOfLine();
      const before = editor.getSelectedBufferRanges();
      const changes = [];
      editor.getBuffer().onDidApplyChanges(() => changes.push(editor.getText()));
      const gate = hold(),
        result = editor.insertText(scenario.input);
      try {
        await gate.ready;
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          expect(editor.getText()).toBe(scenario.text);
          expect(editor.getSelectedBufferRanges()).toEqual(before);
        }
      } finally {
        gate.release();
      }
      await result;
      expect(changes).toEqual([scenario.expected]);
      editor.undo();
      expect(editor.getText()).toBe(scenario.text);
      expect(editor.getSelectedBufferRanges()).toEqual(before);
      editor.redo();
      expect(editor.getText()).toBe(scenario.expected);
    });

  for (const command of ["insertNewlineAbove", "insertNewlineBelow"])
    it(`prepares ${command} without moving the live cursor early`, async () => {
      const original = "def work():\n    pass\n";
      await start(original);
      editor.setCursorBufferPosition([1, 6]);
      const before = editor.getSelectedBufferRanges(),
        changes = [];
      editor.getBuffer().onDidApplyChanges(() => changes.push(editor.getText()));
      const gate = hold(),
        pending = editor[command]();
      try {
        await gate.ready;
        await new Promise(requestAnimationFrame);
        expect(editor.getText()).toBe(original);
        expect(editor.getSelectedBufferRanges()).toEqual(before);
      } finally {
        gate.release();
      }
      await pending;
      expect(changes.length).toBe(1);
      const after = editor.getText();
      editor.undo();
      expect(editor.getText()).toBe(original);
      expect(editor.getSelectedBufferRanges()).toEqual(before);
      editor.redo();
      expect(editor.getText()).toBe(after);
    });

  it("orders Enter, typing, backspace and undo while syntax is pending", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    const gate = hold();
    const newline = dispatchInput(editor, () => editor.insertNewline());
    await gate.ready;
    const type = dispatchInput(editor, () => editor.insertText("value"));
    const backspace = dispatchInput(editor, () => editor.backspace());
    const undo = dispatchInput(editor, () => editor.undo());
    gate.release();
    await Promise.all([newline, type, backspace, undo]);
    expect(editor.getText()).toBe("class Record:\n    value");
    editor.undo();
    expect(editor.getText()).toBe("class Record:\n    ");
    editor.undo();
    expect(editor.getText()).toBe("class Record:");
  });

  it("settles the input accepted before a completion intent and rejects later input", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    const gate = hold();
    const first = dispatchInput(editor, () => editor.insertNewline());
    await gate.ready;
    const second = dispatchInput(editor, () => editor.insertText("field"));
    const ready = editor.whenPendingTextInputSettled();
    gate.release();
    await Promise.all([first, second]);
    expect(await ready).toBe(true);
    expect(editor.getText()).toBe("class Record:\n    field");
  });

  it("cancels a waiting completion immediately when newer input is accepted", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    const gate = hold(),
      first = dispatchInput(editor, () => editor.insertNewline());
    await gate.ready;
    const ready = editor.whenPendingTextInputSettled();
    const second = dispatchInput(editor, () => editor.insertText("field"));
    try {
      expect(await ready).toBe(false);
    } finally {
      gate.release();
    }
    await Promise.all([first, second]);
    expect(editor.getText()).toBe("class Record:\n    field");
  });

  it("repeats Enter on whitespace-only rows without syntax requests and groups insertion hooks", async () => {
    const original = "class Record:\n\t  ";
    await start(original);
    editor.setCursorBufferPosition([1, Infinity]);
    const scan = spyOn(
      editor.getBuffer().getLanguageMode(),
      "scanPreparedIndentation",
    ).and.callThrough();
    editor.onWillPublishTextInsertion(({ editor: target, range }) =>
      target.setIndentationForBufferRow(range.start.row, 0),
    );
    const publications = [];
    editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
    for (let i = 0; i < 20; i++) await editor.insertNewline();
    expect(scan).not.toHaveBeenCalled();
    expect(publications.length).toBe(20);
    expect(publications.every((text) => text.endsWith("\n\t  "))).toBe(true);
    for (let i = 0; i < 20; i++) editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("keeps repeated grouped Enter commands in one undo step", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    editor.undoGroupingInterval = 10000;
    for (let i = 0; i < 10; i++) await editor.insertNewline({ groupUndo: true });
    const after = editor.getText();
    editor.undo();
    expect(editor.getText()).toBe("class Record:");
    editor.redo();
    expect(editor.getText()).toBe(after);
  });

  it("inserts repeated newlines before plain text without speculative syntax requests", async () => {
    await lumine.packages.activatePackage("language-text");
    const original = "first line\n" + "    next line\n".repeat(10000);
    const mode = await start(original, "text.plain");
    expect(mode.canIndentNewlineWithoutSyntax()).toBe(true);
    editor.setCursorBufferPosition([0, 0]);
    const scan = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    for (let i = 0; i < 20; i++) await dispatchInput(editor, () => editor.insertNewline());
    expect(scan).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("\n".repeat(20) + original);
    expect(editor.getCursorBufferPosition()).toEqual([20, 0]);
    for (let i = 0; i < 20; i++) editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("inserts leading newlines in Python without awaiting syntax, even while it is pending", async () => {
    const original = "# generated header\n" + "class Record:\n    field = 1\n\n".repeat(10000);
    const mode = await start(original);
    editor.setCursorBufferPosition([0, 0]);
    const scan = spyOn(mode, "scanPreparedIndentation").and.callFake(() => {
      throw new Error("Leading blank rows must not request indentation syntax");
    });
    const publications = [];
    const sub = editor
      .getBuffer()
      .onDidApplyChanges(() => publications.push(editor.getCursorBufferPosition()));
    for (let i = 0; i < 50; i++) await dispatchInput(editor, () => editor.insertNewline());
    sub.dispose();
    expect(scan).not.toHaveBeenCalled();
    expect(publications.length).toBe(50);
    expect(editor.getText()).toBe("\n".repeat(50) + original);
    expect(editor.getCursorBufferPosition()).toEqual([50, 0]);
    for (let i = 0; i < 50; i++) editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("still resolves indentation when a blank row follows real code", async () => {
    const mode = await start("if ready:\n\n    value = 1");
    editor.setCursorBufferPosition([2, 0]);
    const scan = spyOn(mode, "scanPreparedIndentation").and.callThrough();
    await editor.insertNewline();
    expect(scan).toHaveBeenCalled();
    expect(editor.getText()).toBe("if ready:\n\n\n    value = 1");
  });

  it("matches syntax-resolved newline indentation for split prefixes, selections and multiple cursors", async () => {
    await lumine.packages.activatePackage("language-text");
    const original = "\t  first line\r\n    next line\r\n\tlast line";
    const scenarios = [
      [
        [
          [0, 0],
          [0, 0],
        ],
      ],
      [
        [
          [0, 1],
          [0, 1],
        ],
      ],
      [
        [
          [0, 3],
          [0, 3],
        ],
      ],
      [
        [
          [0, 8],
          [0, 8],
        ],
      ],
      [
        [
          [0, 8],
          [1, 2],
        ],
      ],
      [
        [
          [0, 1],
          [0, 1],
        ],
        [
          [0, 8],
          [0, 8],
        ],
        [
          [2, 1],
          [2, 1],
        ],
      ],
    ];
    for (const softTabs of [true, false]) {
      editor.update({ softTabs });
      for (const ranges of scenarios) {
        const results = [];
        for (const useLocal of [false, true]) {
          const mode = await start(original, "text.plain");
          if (!useLocal) mode.canIndentNewlineWithoutSyntax = () => false;
          editor.setSelectedBufferRanges(ranges);
          const before = editor.getSelectedBufferRanges();
          try {
            await editor.insertNewline();
          } catch (error) {
            throw new Error(JSON.stringify({ softTabs, ranges, useLocal }), { cause: error });
          }
          results.push({ text: editor.getText(), ranges: editor.getSelectedBufferRanges() });
          editor.undo();
          expect(editor.getText()).toBe(original);
          expect(editor.getSelectedBufferRanges()).toEqual(before);
          editor.redo();
          expect(editor.getText()).toBe(results.at(-1).text);
        }
        expect(results[1]).toEqual(results[0]);
      }
    }
  });

  it("resolves queued typing against the completed newline rather than its old row", async () => {
    await start("if (ready) {", "source.js");
    editor.moveToEndOfLine();
    const gate = hold(),
      newline = editor.insertNewline();
    await gate.ready;
    const closing = editor.insertText("}");
    gate.release();
    await Promise.all([newline, closing]);
    expect(editor.getText()).toBe("if (ready) {\n}");
  });

  it("inserts above the first line and an indented row independently with multiple cursors", async () => {
    const original = "class Record:\n    field = 1\n";
    await start(original);
    editor.setSelectedBufferRanges([
      [
        [0, 3],
        [0, 3],
      ],
      [
        [1, 6],
        [1, 6],
      ],
    ]);
    const before = editor.getSelectedBufferRanges();
    await editor.insertNewlineAbove();
    expect(editor.getText()).toBe("\nclass Record:\n    \n    field = 1\n");
    expect(editor.getCursorBufferPositions().map((p) => p.serialize())).toEqual([
      [0, 0],
      [2, 4],
    ]);
    editor.undo();
    expect(editor.getText()).toBe(original);
    expect(editor.getSelectedBufferRanges()).toEqual(before);
  });

  it("publishes a small indentation edit as a local range in a long document", async () => {
    const text = "class Record:\n" + "    value = 1\n".repeat(10000);
    await start(text);
    editor.setCursorBufferPosition([0, Infinity]);
    const changes = [];
    editor.getBuffer().onDidApplyChanges((batch) => changes.push(...batch.changes));
    await editor.insertNewline();
    expect(changes.every((c) => c.oldRange.end.row <= 1 && c.newRange.end.row <= 1)).toBe(true);
    expect(changes.reduce((n, c) => n + c.newTextSource.length, 0)).toBe(5);
    editor.undo();
    expect(editor.getText()).toBe(text);
  });

  it("uses the same atomic mechanism for direct selection insertion", async () => {
    await start("class Record:");
    editor.moveToEndOfLine();
    const changes = [];
    editor.getBuffer().onDidApplyChanges(() => changes.push(editor.getText()));
    await editor.getLastSelection().insertText("\n", { autoIndentNewline: true });
    expect(changes).toEqual(["class Record:\n    "]);
  });

  it("keeps newline and indentation transport local for 128 cursors beyond the string limit", async () => {
    const { PieceTree } = require("../src/text-model");
    let source = new PieceTree("a\n".repeat(1024));
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    editor.getBuffer().setTextInRange(editor.getBuffer().getRange(), source);
    const mode = editor.getBuffer().getLanguageMode();
    mode.scanPreparedIndentation = async function* (changes, ranges) {
      expect(changes.length).toBe(128);
      expect(changes.every((c) => c.newTextSource.length === 1)).toBe(true);
      for (const [start, end] of ranges) {
        for (let row = start; row <= end; row++) yield [[row, 1]];
      }
    };
    editor.setSelectedBufferRanges(
      Array.from({ length: 128 }, (_, i) => [
        [i * 10000 + 1, 1],
        [i * 10000 + 1, 1],
      ]),
    );
    const before = editor.getSelectedBufferRanges();
    const applied = [];
    editor.getBuffer().onDidApplyChanges((batch) => applied.push(...batch.changes));
    const materialize = PieceTree.prototype.toString;
    spyOn(PieceTree.prototype, "toString").and.callFake(function () {
      if (this.length > 65536) throw new Error("Unbounded materialization");
      return materialize.call(this);
    });
    await editor.insertNewline();
    expect(applied.length).toBe(256);
    expect(applied.every((c) => c.newTextSource.length <= 4)).toBe(true);
    expect(editor.getBuffer().getLength()).toBe(source.length + 128 * 5);
    const after = editor.getBuffer().getTextSnapshot();
    editor.undo();
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBe(true);
    expect(editor.getSelectedBufferRanges()).toEqual(before);
    editor.redo();
    expect(editor.getBuffer().getTextSnapshot().equals(after)).toBe(true);
  });
});
