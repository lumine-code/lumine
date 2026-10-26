const TextEditor = require("../src/text-editor");
const { PieceTree } = require("../src/text-model");

describe("Selection callback preparation", () => {
  let editor;
  beforeEach(() => {
    editor = new TextEditor();
  });
  afterEach(() => editor.destroy());

  function selectWords() {
    editor.setText("one\ntwo");
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 3],
      ],
      [
        [1, 0],
        [1, 3],
      ],
    ]);
    editor.getBuffer().clearUndoStack();
  }

  it("accepts the legacy null and undefined options forms", () => {
    editor.replaceSelectedText(null, () => "one");
    expect(editor.getText()).toBe("one");
    editor.replaceSelectedText(undefined, () => "two");
    expect(editor.getText()).toBe("two");
  });

  it("does not change an earlier selection when a later callback throws", () => {
    selectWords();
    const ranges = editor.getSelectedBufferRanges();
    expect(() =>
      editor.replaceSelectedText({}, (text) => {
        if (text === "two") throw new Error("later callback failed");
        return "replacement";
      }),
    ).toThrowError("later callback failed");
    expect(editor.getText()).toBe("one\ntwo");
    expect(editor.getSelectedBufferRanges()).toEqual(ranges);
    expect(editor.getBuffer().undo()).toBe(false);
  });

  it("preflights the aggregate selection length before invoking callbacks or reading strings", () => {
    let source = new PieceTree("x\n".repeat(16384));
    for (let index = 0; index < 9; index++)
      source = source.replace(source.length, source.length, source);
    editor.setText(source);
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [3000000, 0],
      ],
      [
        [3100000, 0],
        [6100000, 0],
      ],
    ]);
    const ranges = editor.getSelectedBufferRanges();
    const callback = jasmine.createSpy("callback");
    expect(() => editor.replaceSelectedText({}, callback)).toThrowError(/in total/);
    expect(callback).not.toHaveBeenCalled();
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBe(true);
    expect(editor.getSelectedBufferRanges()).toEqual(ranges);
  });

  it("checks aggregate output before the first edit and rejects invalid return values", () => {
    selectWords();
    const text = "x".repeat(5 * 1024 * 1024);
    expect(() => editor.replaceSelectedText({}, () => text)).toThrowError(/in total/);
    expect(editor.getText()).toBe("one\ntwo");
    expect(() =>
      editor.replaceSelectedText({}, (value) => (value === "one" ? "new" : undefined)),
    ).toThrowError(/must return a string/);
    expect(editor.getText()).toBe("one\ntwo");
  });

  it("keeps word expansion private until every callback succeeds", () => {
    editor.setText("one\ntwo");
    editor.setCursorBufferPosition([0, 1]);
    editor.addCursorAtBufferPosition([1, 1]);
    const ranges = editor.getSelectedBufferRanges();
    expect(() =>
      editor.replaceSelectedText({ selectWordIfEmpty: true }, (text) => {
        if (text === "two") throw new Error("later word failed");
        return "ONE";
      }),
    ).toThrowError("later word failed");
    expect(editor.getText()).toBe("one\ntwo");
    expect(editor.getSelectedBufferRanges()).toEqual(ranges);
    editor.replaceSelectedText({ selectWordIfEmpty: true }, (text) => text.toUpperCase());
    expect(editor.getText()).toBe("ONE\nTWO");
    editor.undo();
    expect(editor.getText()).toBe("one\ntwo");
  });

  it("does not overwrite explicit edits made by an impure callback", () => {
    selectWords();
    expect(() =>
      editor.replaceSelectedText({}, () => {
        editor.setText("callback edit");
        return "replacement";
      }),
    ).toThrowError(/changed its source/);
    expect(editor.getText()).toBe("callback edit");
  });
});
