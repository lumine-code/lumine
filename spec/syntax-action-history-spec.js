const TextEditor = require("../src/text-editor");
const Range = require("../src/range");

describe("Syntax action history", () => {
  let editor, mode, epoch;
  beforeEach(() => {
    editor = new TextEditor();
    editor.setText("function work() {\n  value();\n}\nfunction next() {\n  value();\n}\n");
    editor.setCursorBufferPosition([1, 3]);
    mode = editor.getBuffer().getLanguageMode();
    epoch = 1;
    mode.getSyntaxRequestEpoch = () => epoch;
    mode.getRangeForSyntaxNodeContainingRange = () => new Range([1, 2], [1, 7]);
    mode.syntaxSelectionRanges = (ranges) =>
      Promise.resolve(ranges.map(() => new Range([1, 2], [1, 7])));
  });
  afterEach(() => editor.destroy());

  for (const asynchronous of [false, true]) {
    for (const change of [
      "edit",
      "equal extent edit",
      "undo",
      "grammar",
      "epoch",
      "selection",
      "away and back",
    ]) {
      it(`discards stale selection history after ${change} (async ${asynchronous})`, async () => {
        mode.asynchronousSyntax = asynchronous;
        await editor.selectLargerSyntaxNode();
        if (change === "edit" || change === "undo") editor.getBuffer().insert([1, 4], "X");
        if (change === "equal extent edit")
          editor.getBuffer().setTextInRange(
            [
              [1, 3],
              [1, 4],
            ],
            "X",
          );
        if (change === "undo") editor.undo();
        if (change === "grammar") editor.getBuffer().setLanguageMode(null);
        if (change === "epoch") epoch++;
        if (change === "selection")
          editor.setSelectedBufferRange([
            [1, 0],
            [1, 9],
          ]);
        if (change === "away and back") {
          editor.setCursorBufferPosition([3, 0]);
          editor.setSelectedBufferRange([
            [1, 2],
            [1, 7],
          ]);
        }
        const expected = editor.getSelectedBufferRange();
        editor.selectSmallerSyntaxNode();
        expect(editor.getSelectedBufferRange()).toEqual(expected);
      });
    }
    it(`starts a new growth chain after a manual selection (async ${asynchronous})`, async () => {
      mode.asynchronousSyntax = asynchronous;
      await editor.selectLargerSyntaxNode();
      const manual = new Range([1, 0], [1, 7]);
      editor.setSelectedBufferRange(manual);
      mode.getRangeForSyntaxNodeContainingRange = () => new Range([1, 0], [1, 9]);
      mode.syntaxSelectionRanges = () => Promise.resolve([new Range([1, 0], [1, 9])]);
      await editor.selectLargerSyntaxNode();
      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedBufferRange()).toEqual(manual);
      editor.selectSmallerSyntaxNode();
      expect(editor.getSelectedBufferRange()).toEqual(manual);
    });
  }

  it("cancels independent pending folds when a later fold-all replaces them", async () => {
    let release;
    mode.getFoldableRangeContainingPoint = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    mode.getFoldableRanges = () => Promise.resolve([new Range([3, 17], [5, 0])]);
    const pending = editor.foldBufferRow(0);
    await editor.foldAll();
    release(new Range([0, 17], [2, 0]));
    await pending;
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
    expect(editor.isFoldedAtBufferRow(3)).toBe(true);
  });

  it("keeps independent pending row folds when their replies arrive in reverse order", async () => {
    mode.asynchronousSyntax = true;
    const releases = [];
    mode.getFoldableRangeContainingPoint = () => new Promise((resolve) => releases.push(resolve));
    const first = editor.foldBufferRow(0);
    const second = editor.foldBufferRow(3);
    releases[1](new Range([3, 17], [5, 0]));
    await second;
    releases[0](new Range([0, 17], [2, 0]));
    await first;
    expect(editor.isFoldedAtBufferRow(0)).toBe(true);
    expect(editor.isFoldedAtBufferRow(3)).toBe(true);
  });

  it("lets an explicit row fold supersede a pending fold-all replacement", async () => {
    let release;
    mode.getFoldableRanges = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    mode.getFoldableRangeContainingPoint = () => Promise.resolve(new Range([3, 17], [5, 0]));
    const pending = editor.foldAll();
    await editor.foldBufferRow(3);
    release([new Range([0, 17], [2, 0])]);
    await pending;
    expect(editor.isFoldedAtBufferRow(0)).toBe(false);
    expect(editor.isFoldedAtBufferRow(3)).toBe(true);
  });
});
