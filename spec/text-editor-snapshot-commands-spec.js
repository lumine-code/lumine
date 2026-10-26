const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { PieceTree } = require("../src/text-model");

describe("Source-backed editing commands", () => {
  let editor;
  afterEach(() => editor?.destroy());
  function create(text) {
    editor = new TextEditor({ buffer: new TextBuffer(text), autoHeight: false });
    return editor;
  }

  it("preserves native Unicode casing and code-point reversal with undo", () => {
    const original = "AΣ\u0301B ß😀𐐀\ud800";
    create(original);
    editor.selectAll();
    editor.lowerCase();
    expect(editor.getText()).toBe(original.toLowerCase());
    expect(editor.getSelectedText()).toBe(original.toLowerCase());
    editor.undo();
    expect(editor.getText()).toBe(original);
    editor.transpose();
    expect(editor.getText()).toBe(Array.from(original).reverse().join(""));
    editor.undo();
    expect(editor.getText()).toBe(original);
  });

  it("prepares a large case transform asynchronously and discards stale work", async () => {
    jasmine.useRealClock();
    create("abc Σ ".repeat(180000));
    editor.selectAll();
    const original = editor.buffer.getTextSnapshot();
    spyOn(editor.getLastSelection(), "getText").and.throwError("Full selection string");
    const pending = editor.upperCase();
    expect(typeof pending.then).toBe("function");
    editor.setCursorBufferPosition([0, 0]);
    expect(await pending).toBe(false);
    expect(editor.buffer.getTextSnapshot().equals(original)).toBe(true);
    editor.selectAll();
    expect(await editor.upperCase()).toBe(true);
    expect(editor.buffer.getTextSnapshot().slice(0, 6)).toBe("ABC Σ ");
    editor.undo();
    expect(editor.buffer.getTextSnapshot().equals(original)).toBe(true);
  });

  it("inserts Enter beyond the runtime string limit without reading its line prefix", () => {
    create("");
    let source = new PieceTree("x".repeat(32768));
    while (source.length <= require("node:buffer").constants.MAX_STRING_LENGTH)
      source = source.replace(source.length, source.length, source);
    editor.buffer.setTextInRange(editor.buffer.getRange(), source, { normalizeLineEndings: false });
    editor.setCursorBufferPosition([0, source.length]);
    const read = spyOn(editor, "getTextInRange").and.throwError("Full line prefix");
    try {
      editor.getLastSelection().insertText("\n", { autoIndent: true });
    } finally {
      read.and.callThrough();
    }
    expect(editor.buffer.getLineCount()).toBe(2);
    expect(editor.buffer.getLength()).toBe(source.length + 1);
  });

  it("moves selected lines through immutable sources and restores exact undo", () => {
    create("first\n" + "x".repeat(1100000) + "\nlast");
    editor.setSelectedBufferRange([
      [1, 0],
      [2, 0],
    ]);
    const source = editor.buffer.getTextSnapshot();
    const read = spyOn(editor, "getTextInBufferRange").and.throwError("Full selected lines");
    try {
      editor.moveLineUp();
    } finally {
      read.and.callThrough();
    }
    expect(editor.buffer.getTextSnapshot().slice(1100000, 1100012)).toBe("\nfirst\nlast");
    editor.undo();
    expect(editor.buffer.getTextSnapshot().equals(source)).toBe(true);
  });

  it("joins a large selected block without materializing rows", async () => {
    jasmine.useRealClock();
    create("a ".repeat(550000) + " \n  b\n \n c");
    editor.selectAll();
    const original = editor.buffer.getTextSnapshot();
    const marker = editor.buffer.markRange(
      [
        [0, 10],
        [0, 20],
      ],
      { invalidate: "never" },
    );
    expect(await editor.joinLines()).toBe(true);
    expect(editor.buffer.getLineCount()).toBe(1);
    expect(editor.buffer.getTextSnapshot().slice(-10)).toBe(" a a a b c");
    expect(marker.getRange().serialize()).toEqual([
      [0, 10],
      [0, 20],
    ]);
    editor.undo();
    expect(editor.buffer.getTextSnapshot().equals(original)).toBe(true);
  });

  it("leaves all text and selections intact when native cut transport fails", async () => {
    create("one two three");
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 3],
      ],
      [
        [0, 8],
        [0, 13],
      ],
    ]);
    const ranges = editor.getSelectedBufferRanges();
    const error = new RangeError("Clipboard text is too large");
    const clipboard = { write: () => Promise.reject(error) };
    await expectAsync(editor.cutSelectedText({ clipboard })).toBeRejectedWith(error);
    expect(editor.getText()).toBe("one two three");
    expect(editor.getSelectedBufferRanges()).toEqual(ranges);
  });

  it("cuts only after asynchronous clipboard publication and cancels stale deletion", async () => {
    create("one two");
    editor.setSelectedBufferRange([
      [0, 0],
      [0, 3],
    ]);
    let resolve;
    const clipboard = {
      write: () =>
        new Promise((done) => {
          resolve = done;
        }),
    };
    const pending = editor.cutSelectedText({ clipboard });
    expect(editor.getText()).toBe("one two");
    editor.setCursorBufferPosition([0, 7]);
    resolve();
    expect(await pending).toBe(false);
    expect(editor.getText()).toBe("one two");
  });

  it("finds an exact word on a giant row without materializing that row", () => {
    create("a".repeat(1100000) + " needle tail");
    editor.setCursorBufferPosition([0, 1100004]);
    spyOn(editor, "lineTextForBufferRow").and.throwError("Whole row");
    spyOn(editor.buffer, "findAllInRangeSync").and.throwError("Native whole row regex");
    expect(editor.getLastCursor().getCurrentWordBufferRange().serialize()).toEqual([
      [0, 1100001],
      [0, 1100007],
    ]);
    expect(editor.getLastCursor().isInsideWord()).toBe(true);
    expect(editor.getLastCursor().hasPrecedingCharactersOnLine()).toBe(true);
  });
  it("streamed join retains legacy selection and cursor positions", async () => {
    jasmine.useRealClock();
    for (const text of ["a \n  b\n c", " \t\n a\n\t", "a\n \t", "a\n\n c"]) {
      for (const selected of [false, true]) {
        const legacy = new TextEditor({ buffer: new TextBuffer(text), autoHeight: false });
        create(text);
        try {
          if (selected) {
            legacy.selectAll();
            editor.selectAll();
          } else {
            legacy.setCursorBufferPosition([0, 0]);
            editor.setCursorBufferPosition([0, 0]);
          }
          legacy.joinLines();
          await require("../src/text-editor-join-lines").joinSelections(
            editor,
            editor.getSelectionsOrderedByBufferPosition(),
          );
          expect(editor.getText()).withContext(JSON.stringify(text)).toBe(legacy.getText());
          expect(editor.getSelectedBufferRanges())
            .withContext(JSON.stringify(text))
            .toEqual(legacy.getSelectedBufferRanges());
        } finally {
          legacy.destroy();
          editor.destroy();
          editor = null;
        }
      }
    }
  });
  it("keeps mounted editors alive and coherent when a cross-buffer observer tries to destroy one", async () => {
    create("x gap");
    const other = new TextEditor({ buffer: new TextBuffer("x tail"), autoHeight: false });
    const subscription = editor.buffer.onDidChangeText(() => other.destroy());
    try {
      const plans = await Promise.all([
        editor.buffer.prepareReplaceAllMatches(/x/g, "long"),
        other.buffer.prepareReplaceAllMatches(/x/g, "long"),
      ]);
      let failure;
      try {
        TextBuffer.commitPreparedReplacements(plans);
      } catch (error) {
        failure = error;
      }
      expect(failure?.committed).toBe(true);
      expect(other.isDestroyed()).toBe(false);
      expect(editor.getText()).toBe("long gap");
      expect(other.getText()).toBe("long tail");
      subscription.dispose();
      editor.undo();
      other.undo();
      expect(editor.getText()).toBe("x gap");
      expect(other.getText()).toBe("x tail");
    } finally {
      subscription.dispose();
      other.destroy();
    }
  });
  for (const asynchronous of [false, true]) {
    it(`reports a ${asynchronous ? "rejected" : "thrown"} native clipboard failure once and prevents browser fallback`, async () => {
      create("keep this text");
      editor.selectAll();
      const component = editor.getElement().getComponent();
      const error = new RangeError("Clipboard limit");
      const clipboard = {
        didWrite: () => false,
        write() {
          if (asynchronous) return Promise.reject(error);
          throw error;
        },
      };
      spyOn(editor.constructor.clipboard, "createDataTransferClipboard").and.returnValue(clipboard);
      const report = spyOn(lumine.notifications, "addError");
      const event = { clipboardData: {}, preventDefault: jasmine.createSpy("preventDefault") };
      component.pendingClipboardOperation = { type: "cut", handled: false };
      const result = component.writeClipboardEvent(event, true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(component.pendingClipboardOperation.handled).toBe(true);
      expect(await result).toBe(false);
      expect(report).toHaveBeenCalledTimes(1);
      expect(editor.getText()).toBe("keep this text");
    });
  }
});
