const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { PieceTree } = require("../src/text-model");

describe("Snapshot-backed editor operations", () => {
  let editor;
  afterEach(() => editor?.destroy());

  function hugeSource() {
    let text = new PieceTree("abc\n".repeat(1024));
    while (text.length <= 536870888) text = text.replace(text.length, text.length, text);
    return text;
  }

  it("duplicates a selection larger than the runtime string limit with exact undo", () => {
    const source = hugeSource();
    const buffer = new TextBuffer();
    buffer.setTextInRange(buffer.getRange(), source, { normalizeLineEndings: false });
    buffer.setPreferredLineEnding("\n");
    buffer.clearUndoStack();
    editor = new TextEditor({ buffer, softWrapped: false, autoHeight: false });
    editor.selectAll();
    const range = editor.getSelectedBufferRange();
    spyOn(editor, "getTextInBufferRange").and.throwError("Whole-selection materialization");
    editor.duplicateLines();
    const duplicated = buffer.getTextSnapshot();
    expect(duplicated.length).toBe(source.length * 2);
    expect(duplicated.subtext(0, source.length).equals(source)).toBe(true);
    expect(duplicated.subtext(source.length).equals(source)).toBe(true);
    expect(editor.getSelectedBufferRange()).toEqual(range.translate([source.lineCount - 1, 0]));
    editor.undo();
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
    expect(editor.getSelectedBufferRange()).toEqual(range);
    editor.redo();
    expect(buffer.getTextSnapshot().equals(duplicated)).toBe(true);
  });

  it("retains duplicate-line normalization and the missing final newline", () => {
    const buffer = new TextBuffer("first\r\nsecond\nlast");
    buffer.setPreferredLineEnding("\r\n");
    editor = new TextEditor({ buffer });
    editor.selectAll();
    editor.duplicateLines();
    expect(buffer.getText()).toBe("first\r\nsecond\nlast\r\nfirst\r\nsecond\r\nlast");
    editor.undo();
    expect(buffer.getText()).toBe("first\r\nsecond\nlast");
  });
  it("normalizes a large duplicate cooperatively and maps reversed selections across lone CRs", async () => {
    const text = "head\r" + "x".repeat(1048577) + "\rtail";
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    buffer.setPreferredLineEnding("\n");
    editor.setSelectedBufferRange(
      [
        [0, 1],
        [0, text.length - 1],
      ],
      { reversed: true },
    );
    const originalRange = editor.getSelectedBufferRange();
    buffer.clearUndoStack();
    const pending = editor.duplicateLines();
    expect(typeof pending.then).toBe("function");
    expect(buffer.getLength()).toBe(text.length);
    await pending;
    expect(buffer.getText()).toBe(text + "\n" + text.replace(/\r/g, "\n"));
    expect(editor.getSelectedBufferRange()).toEqual(new (require("../src/range"))([1, 1], [3, 3]));
    expect(editor.getLastSelection().isReversed()).toBe(true);
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRange()).toEqual(originalRange);
    editor.redo();
    expect(editor.getSelectedBufferRange()).toEqual(new (require("../src/range"))([1, 1], [3, 3]));
  });
  it("cancels large duplicate normalization when the selection moves", async () => {
    const text = "x\r".repeat(600000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    buffer.setPreferredLineEnding("\n");
    editor.selectAll();
    const pending = editor.duplicateLines();
    editor.setCursorBufferPosition([0, 0]);
    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(buffer.getText()).toBe(text);
    expect(buffer.undo()).toBe(false);
  });
  it("publishes normalized copies of separate selections using original source offsets", async () => {
    const line = "x".repeat(1048577) + "\rz";
    const text = "prefix\n" + line + "\nend\n";
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    buffer.setPreferredLineEnding("\n");
    editor.setSelectedBufferRanges([
      [
        [0, 1],
        [0, 4],
      ],
      [
        [1, 0],
        [1, line.length],
      ],
    ]);
    const before = editor.getSelectedBufferRanges();
    await editor.duplicateLines();
    expect(buffer.getText()).toBe(
      "prefix\nprefix\n" + line + "\n" + line.replace(/\r/g, "\n") + "\nend\n",
    );
    expect(editor.getSelectedBufferRanges()).toEqual([
      new (require("../src/range"))([1, 1], [1, 4]),
      new (require("../src/range"))([3, 0], [4, 1]),
    ]);
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRanges()).toEqual(before);
  });
  it("rejects a prepared source edit when a will-change observer invalidates its owner", async () => {
    const buffer = new TextBuffer("original");
    editor = new TextEditor({ buffer, autoHeight: false });
    let current = true;
    const subscription = buffer.onWillChange(() => {
      current = false;
    });
    try {
      await expectAsync(
        buffer.applyTextEdits(
          [
            {
              range: [
                [0, 0],
                [0, 1],
              ],
              text: "X",
            },
          ],
          { isCurrent: () => current },
        ),
      ).toBeRejectedWith(jasmine.objectContaining({ code: "ERR_STALE_EDIT" }));
      expect(buffer.getText()).toBe("original");
      expect(buffer.undo()).toBe(false);
    } finally {
      subscription.dispose();
    }
  });
  it("cancels empty edit batches before consuming the rest of a no-match scan", async () => {
    const buffer = new TextBuffer("unchanged");
    editor = new TextEditor({ buffer });
    const controller = new AbortController();
    let visited = 0;
    async function* batches() {
      for (let i = 0; i < 10000; i++) {
        visited++;
        controller.abort();
        yield [];
      }
    }
    await expectAsync(
      buffer.applyTextEdits(batches(), { signal: controller.signal }),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(visited).toBe(1);
    expect(buffer.getText()).toBe("unchanged");
  });
  it("applies a source diff whose exact inserted span exceeds the native string limit", () => {
    const source = hugeSource();
    const buffer = new TextBuffer("prefix\n");
    editor = new TextEditor({ buffer, autoHeight: false });
    const expected = source.replace(0, 0, "prefix\n");
    buffer.setTextViaDiff(expected);
    expect(buffer.getTextSnapshot().equals(expected)).toBe(true);
    editor.undo();
    expect(buffer.getText()).toBe("prefix\n");
    editor.redo();
    expect(buffer.getTextSnapshot().equals(expected)).toBe(true);
  });

  it("normalizes snapshot endings across piece boundaries including lone CR and Unicode", () => {
    const buffer = new TextBuffer("before\n");
    editor = new TextEditor({ buffer });
    let source = new PieceTree("x".repeat(65535) + "\r");
    source = source.replace(source.length, source.length, "\n😀\r\nz\rx\n\r");
    buffer.setPreferredLineEnding("\n");
    const inserted = buffer.append(source);
    const text = buffer.getTextInRange(inserted);
    expect(text).toBe("x".repeat(65535) + "\n😀\nz\nx\n\n");
    expect(source.slice(65535)).toBe("\r\n😀\r\nz\rx\n\r");
    const captured = buffer.getTextSnapshotInRange([
      [1, 65535],
      [2, 2],
    ]);
    expect(captured.toString()).toBe("\n😀");
    buffer.append("later");
    expect(captured.toString()).toBe("\n😀");
  });

  it("applies independent source replacements over huge deleted ranges without reading their strings", () => {
    const buffer = new TextBuffer();
    editor = new TextEditor({ buffer, autoHeight: false });
    const source = hugeSource();
    buffer.setTextInRange(buffer.getRange(), source, { normalizeLineEndings: false });
    buffer.clearUndoStack();
    spyOn(buffer, "getTextInRange").and.throwError("Whole-range string read");
    expect(buffer.setTextInIndependentRanges([{ range: buffer.getRange(), text: source }])).toBe(
      false,
    );
    const tail = source.subtext(source.length - 8);
    buffer.setTextInIndependentRanges([{ range: buffer.getRange(), text: tail }]);
    expect(buffer.getTextSnapshot().equals(tail)).toBe(true);
    editor.undo();
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
    buffer.setTextInIndependentRanges([{ range: buffer.getRange(), text: "" }]);
    expect(buffer.getLength()).toBe(0);
    editor.undo();
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
  });

  it("streams edits with scalar CRLF marker semantics and restores them with undo", async () => {
    const text = "a\rb\ncd\r\nef\n";
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    const scalar = new TextBuffer(text);
    const range = [
      [0, 1],
      [2, 1],
    ];
    const marker = buffer.markRange(range, { invalidate: "touch" });
    const expectedMarker = scalar.markRange(range, { invalidate: "touch" });
    const edits = [
      {
        range: [
          [0, 2],
          [0, 3],
        ],
        text: "",
      },
      {
        range: [
          [1, 1],
          [1, 2],
        ],
        text: "\r",
      },
    ];
    const source = buffer.getTextSnapshot();
    let delta = 0;
    for (const edit of edits) {
      const start = source.offsetAt({ row: edit.range[0][0], column: edit.range[0][1] });
      const end = source.offsetAt({ row: edit.range[1][0], column: edit.range[1][1] });
      scalar.setTextInRange(
        [
          scalar.positionForCharacterIndex(start + delta),
          scalar.positionForCharacterIndex(end + delta),
        ],
        edit.text,
        { normalizeLineEndings: false },
      );
      delta += edit.text.length - (end - start);
    }
    await buffer.applyTextEdits(edits);
    expect(buffer.getText()).toBe(scalar.getText());
    expect(marker.getRange()).toEqual(expectedMarker.getRange());
    expect(marker.isValid()).toBe(expectedMarker.isValid());
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(marker.getRange()).toEqual(new (require("../src/range"))(range[0], range[1]));
    scalar.destroy();
  });

  it("discards cancelled or invalid edit streams without publishing a partial prefix", async () => {
    const buffer = new TextBuffer("a\nb\nc\n");
    editor = new TextEditor({ buffer, autoHeight: false });
    const original = buffer.getTextSnapshot();
    const controller = new AbortController();
    async function* cancelled() {
      yield {
        range: [
          [0, 0],
          [0, 1],
        ],
        text: "x",
      };
      controller.abort();
      yield {
        range: [
          [1, 0],
          [1, 1],
        ],
        text: "y",
      };
    }
    await expectAsync(
      buffer.applyTextEdits(cancelled(), { signal: controller.signal }),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    expect(buffer.getTextSnapshot().equals(original)).toBe(true);
    await expectAsync(
      buffer.applyTextEdits([
        {
          range: [
            [1, 0],
            [1, 1],
          ],
          text: "x",
        },
        {
          range: [
            [0, 0],
            [0, 1],
          ],
          text: "y",
        },
      ]),
    ).toBeRejected();
    expect(buffer.getTextSnapshot().equals(original)).toBe(true);
  });

  it("indents and outdents many selected rows atomically while preserving empty lines and undo", async () => {
    const text = "a\r\n\n  b\n".repeat(2000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false, tabLength: 2, softTabs: true });
    editor.selectAll();
    const before = editor.getSelectedBufferRange();
    buffer.clearUndoStack();
    await editor.indentSelectedRows();
    expect(buffer.getText()).toBe("  a\r\n\n    b\n".repeat(2000));
    await editor.outdentSelectedRows();
    expect(buffer.getText()).toBe(text);
    editor.undo();
    expect(buffer.getText()).toBe("  a\r\n\n    b\n".repeat(2000));
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRange()).toEqual(before);
  });

  it("keeps mixed bulk Tab selections and inline cursor indentation in one undo operation", async () => {
    const text = "  word\n".repeat(6000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false, tabLength: 2, softTabs: true });
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [5500, 0],
        [5500, 0],
      ],
    ]);
    const original = editor.getSelectedBufferRanges();
    buffer.clearUndoStack();
    await editor.indent({ autoIndent: false });
    const after = editor.getSelectedBufferRanges();
    expect(buffer.lineForRow(0)).toBe("    word");
    expect(buffer.lineForRow(5000)).toBe("  word");
    expect(buffer.lineForRow(5500)).toBe("    word");
    expect(after[1]).toEqual(new (require("../src/range"))([5500, 4], [5500, 4]));
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRanges()).toEqual(original);
    editor.redo();
    expect(editor.getSelectedBufferRanges()).toEqual(after);
  });

  it("collapses newline runs across source chunks without consuming retained blank-line markers", async () => {
    const text = "x".repeat(32766) + "\r\n\r\n\r\n\r\n" + "a\r\n\n\r\r\nb".repeat(5000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    const marker = buffer.markPosition([1, 0], { invalidate: "touch" });
    const expected = text.replace(/(?:\r\n|\n|\r(?!\n)){3,}/g, (run) =>
      run
        .match(/\r\n|\n|\r/g)
        .slice(0, 2)
        .join(""),
    );
    await editor.collapseBlankLines();
    expect(buffer.getText()).toBe(expected);
    expect(marker.isValid()).toBe(true);
    expect(marker.getStartPosition()).toEqual(new (require("../src/point"))(1, 0));
    editor.undo();
    expect(buffer.getText()).toBe(text);
  });

  it("collapses content spaces across chunks while retaining every indentation prefix", async () => {
    const text =
      "x".repeat(32767) +
      "    y\n" +
      " \t   one    two\t   three\r\n\t   \r\n\u00a0    four\n".repeat(2000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    const expected = text
      .split("\n")
      .map((line) => {
        const indent = line.match(/^[ \t]*/)[0];
        return indent + line.slice(indent.length).replace(/ {2,}/g, " ");
      })
      .join("\n");
    await editor.collapseContentSpaces();
    expect(buffer.getText()).toBe(expected);
    editor.undo();
    expect(buffer.getText()).toBe(text);
  });

  it("comments large row ranges with exact indentation and one undo without retaining line strings", async () => {
    const text = "\talpha\r\n    beta\n  \n".repeat(2000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false, tabLength: 4, softTabs: true });
    const options = { commentStrings: { commentStartString: "//" } };
    const readLine = buffer.lineForRow.bind(buffer);
    spyOn(buffer, "lineForRow").and.callFake((row) => {
      if (buffer.lineLengthForRow(row) > 4096) throw new Error("Unbounded line read");
      return readLine(row);
    });
    await editor.toggleLineCommentsForBufferRows(0, 5999, options);
    const commented = "\t// alpha\r\n    // beta\n    // \n".repeat(2000);
    expect(buffer.getText()).toBe(commented);
    await editor.toggleLineCommentsForBufferRows(0, 5999, options);
    expect(buffer.getText()).toBe("\talpha\r\n    beta\n    \n".repeat(2000));
    editor.undo();
    expect(buffer.getText()).toBe(commented);
    editor.undo();
    expect(buffer.getText()).toBe(text);
  });

  it("adds and removes block delimiters around a line above the string limit", async () => {
    let source = new PieceTree("text".repeat(8192));
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    const buffer = new TextBuffer();
    buffer.setTextInRange(buffer.getRange(), source, { normalizeLineEndings: false });
    editor = new TextEditor({ buffer, autoHeight: false });
    editor.selectAll();
    const options = {
      commentStrings: { commentStartString: "/*", commentEndString: "*/" },
      correctSelection: true,
      selection: editor.getLastSelection(),
    };
    spyOn(buffer, "lineForRow").and.throwError("Whole-line reads forbidden");
    await editor.toggleLineCommentsForBufferRows(0, 0, options);
    expect(buffer.getLength()).toBe(source.length + 6);
    expect(buffer.getTextSnapshot().slice(0, 7)).toBe("/* text");
    expect(buffer.getTextSnapshot().slice(buffer.getLength() - 7)).toBe("text */");
    expect(editor.getSelectedBufferRange()).toEqual(
      new (require("../src/range"))([0, 3], [0, source.length + 3]),
    );
    await editor.toggleLineCommentsForBufferRows(0, 0, options);
    expect(buffer.getTextSnapshot().equals(source)).toBe(true);
  });

  it("comments separate large selections in one atomic history entry", async () => {
    const text = "word\n".repeat(16000);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false });
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [5000, 0],
      ],
      [
        [10000, 0],
        [15000, 0],
      ],
    ]);
    buffer.clearUndoStack();
    await editor.toggleLineCommentsInSelection({ commentStrings: { commentStartString: "//" } });
    expect(buffer.lineForRow(0)).toBe("// word");
    expect(buffer.lineForRow(5000)).toBe("word");
    expect(buffer.lineForRow(10000)).toBe("// word");
    expect(buffer.lineForRow(15000)).toBe("word");
    editor.undo();
    expect(buffer.getText()).toBe(text);
  });

  it("corrects every cursor inside a grouped long-row block comment", async () => {
    const text = "x".repeat(1048577);
    const buffer = new TextBuffer(text);
    editor = new TextEditor({ buffer, autoHeight: false, maxScreenLineLength: Infinity });
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 4],
      ],
      [
        [0, text.length],
        [0, text.length],
      ],
    ]);
    const original = editor.getSelectedBufferRanges();
    buffer.clearUndoStack();
    await editor.toggleLineCommentsInSelection({
      commentStrings: { commentStartString: "/*", commentEndString: "*/" },
    });
    const selections = editor.getSelectedBufferRanges();
    expect(selections[0]).toEqual(new (require("../src/range"))([0, 3], [0, 7]));
    expect(selections[1]).toEqual(
      new (require("../src/range"))([0, text.length + 3], [0, text.length + 3]),
    );
    editor.undo();
    expect(buffer.getText()).toBe(text);
    expect(editor.getSelectedBufferRanges()).toEqual(original);
  });
});
