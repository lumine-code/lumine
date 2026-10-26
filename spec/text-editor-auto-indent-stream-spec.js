const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { PieceTree } = require("../src/text-model");
const { autoIndentRanges } = require("../src/text-editor-auto-indent");

describe("Streamed editor indentation", () => {
  let editor;
  afterEach(() => editor?.destroy());
  function create(text, options = {}) {
    editor = new TextEditor({
      buffer: new TextBuffer(text),
      autoHeight: false,
      softTabs: true,
      tabLength: 4,
      ...options,
    });
    return editor.getBuffer();
  }
  it("indents thousands of plain rows atomically using virtual preceding indentation", async () => {
    const text = "  seed\n" + "       value\n\n".repeat(3000);
    const buffer = create(text);
    editor.setSelectedBufferRange([
      [1, 0],
      [6000, 0],
    ]);
    const selection = editor.getSelectedBufferRange();
    buffer.clearUndoStack();
    spyOn(buffer, "lineForRow").and.throwError("Whole-line read");
    const result = await editor.autoIndentSelectedRows();
    expect(result.changed).toBe(true);
    expect(buffer.getText()).toBe("  seed\n" + "  value\n  \n".repeat(2999) + "  value\n\n");
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRange()).toEqual(selection);
    expect(buffer.undo()).toBe(false);
  });
  it("matches sequential None indentation over sparse ranges and retained tab prefixes", async () => {
    const initial = "  seed\n \tvalue\n\u00a0blank\n\n   other\n\tvalue\n x\n";
    for (const softTabs of [true, false])
      for (const preserveLeadingWhitespace of [false, true]) {
        const reference = new TextEditor({
          buffer: new TextBuffer(initial),
          softTabs,
          tabLength: 4,
          autoHeight: false,
        });
        const rows = [1, 2, 3, 5, 6];
        reference.autoIndentBufferRowsAtRows(rows, { preserveLeadingWhitespace });
        const expected = reference.getText();
        reference.destroy();
        const buffer = create(initial, { softTabs });
        await autoIndentRanges(
          editor,
          [
            [1, 3],
            [5, 6],
          ],
          { preserveLeadingWhitespace },
        );
        expect(buffer.getText()).toBe(expected);
        editor.destroy();
      }
  });
  it("cancels a pending stream without changing text, markers or history", async () => {
    const text = "  seed\n" + "value\n".repeat(10000);
    const buffer = create(text);
    const controller = new AbortController();
    const promise = autoIndentRanges(editor, [[1, 10000]], { signal: controller.signal });
    controller.abort();
    let error;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }
    expect(error.name).toBe("AbortError");
    expect(buffer.getText()).toBe(text);
    expect(buffer.undo()).toBe(false);
  });
  it("rejects partial or malformed provider streams before publishing any edit", async () => {
    for (const batch of [
      [[0, 2]],
      [
        [0, 2],
        [0, 3],
      ],
      [
        [0, 2],
        [1, NaN],
      ],
    ]) {
      const buffer = create("x\ny");
      spyOn(buffer.getLanguageMode(), "scanSuggestedIndentation").and.callFake(() =>
        (async function* () {
          yield batch;
        })(),
      );
      let failed = false;
      try {
        await autoIndentRanges(editor, [[0, 1]]);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(buffer.getText()).toBe("x\ny");
      expect(buffer.undo()).toBe(false);
      editor.destroy();
    }
  });
  it("changes the prefix of a line larger than the native string limit", () => {
    const buffer = create("");
    let source = new PieceTree("data".repeat(1024));
    while (source.length <= 536870888)
      source = source.replace(source.length, source.length, source);
    buffer.setTextInRange(buffer.getRange(), source);
    buffer.clearUndoStack();
    editor.applyIndentationLevels(new Map([[0, 2]]));
    expect(buffer.getLength()).toBe(source.length + 8);
    expect(buffer.getTextSnapshot().slice(0, 12)).toBe("        data");
    editor.undo();
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
  });
  it("refuses millions of cursors before changing the original selection", () => {
    const buffer = create("x\n".repeat(10000));
    editor.selectAll();
    const selection = editor.getSelectedBufferRange();
    expect(() => editor.splitSelectionsIntoLines()).toThrow();
    expect(editor.getSelections().length).toBe(1);
    expect(editor.getSelectedBufferRange()).toEqual(selection);
    expect(buffer.undo()).toBe(false);
  });
  it("coalesces a column-zero Tab cursor with a row-prefix edit", async () => {
    const text = "word\n".repeat(6000);
    const buffer = create(text);
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 0],
      ],
      [
        [0, 1],
        [5000, 0],
      ],
    ]);
    const original = editor.getSelectedBufferRanges();
    await editor.indent({ autoIndent: false });
    expect(buffer.lineForRow(0)).toBe("        word");
    expect(buffer.lineForRow(1)).toBe("    word");
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRanges()).toEqual(original);
  });
  it("plans a single enormous row without asking for a line string", async () => {
    const buffer = create("  first\n" + "word".repeat(300000));
    const before = buffer.getTextSnapshot();
    editor.setCursorBufferPosition([1, 0]);
    spyOn(buffer, "lineForRow").and.throwError("Whole-line read");
    await editor.autoIndentSelectedRows();
    expect(buffer.getTextSnapshot().slice(8, 16)).toBe("  wordwo");
    expect(editor.isBufferRowCommented(1)).toBe(false);
    editor.undo();
    expect(buffer.getTextSnapshot().equals(before)).toBe(true);
  });
  it("leaves text intact when a string callback throws or exceeds its input budget", () => {
    const buffer = create("small");
    editor.selectAll();
    expect(() =>
      editor.replaceSelectedText({}, () => {
        throw new Error("failed callback");
      }),
    ).toThrowError("failed callback");
    expect(buffer.getText()).toBe("small");
    const source = new PieceTree("x".repeat(8 * 1024 * 1024 + 1));
    buffer.setTextInRange(buffer.getRange(), source);
    buffer.clearUndoStack();
    editor.selectAll();
    const callback = jasmine.createSpy("callback");
    expect(() => editor.replaceSelectedText({}, callback)).toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
    expect(buffer.undo()).toBe(false);
  });
  it("declines optional tab detection when a syntax query reaches its budget", () => {
    const buffer = create("  word");
    const query = spyOn(buffer.getLanguageMode(), "isRowCommented").and.callFake(() => {
      throw Object.assign(new Error("bounded query"), { code: "ERR_SYNTAX_QUERY_BUDGET" });
    });
    expect(editor.usesSoftTabs()).toBeUndefined();
    query.and.throwError("unrelated failure");
    expect(() => editor.usesSoftTabs()).toThrowError("unrelated failure");
  });
});
