const TextBuffer = require("../src/text-buffer");
const TestLanguageMode = require("./text-buffer-helpers/test-language-mode");

describe("DisplayLayer sparse unwrapped projection", () => {
  const buffers = [];
  function build(text, params = {}) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    return { buffer, layer: buffer.addDisplayLayer({ softWrapColumn: Infinity, ...params }) };
  }
  afterEach(() => {
    while (buffers.length) buffers.pop().destroy();
  });

  it("jumps to a distant row without indexing its prefix and edits only measured blocks", () => {
    const { buffer, layer } = build("x\n".repeat(1_000_000));
    const lineReads = spyOn(buffer, "lineForRow").and.callThrough();
    expect(layer.translateBufferPosition([999_999, 1]).toArray()).toEqual([999_999, 1]);
    expect(layer.getScreenLineCount()).toBe(1_000_001);
    expect(layer.screenLineLengths.storedCount).toBe(1);
    expect(lineReads).not.toHaveBeenCalled();
    const copy = layer.copy();
    expect(copy.getScreenLines(999_999, 1_000_001).map((line) => line.lineText)).toEqual(["x", ""]);
    buffer.insert([0, 0], "\n");
    expect(layer.translateBufferPosition([1_000_000, 1]).toArray()).toEqual([1_000_000, 1]);
    expect(copy.layoutState).toBe(layer.layoutState);
    expect(layer.screenLineLengths.storedCount).toBeLessThan(10);
    buffer.undo();
    expect(layer.getScreenLineCount()).toBe(1_000_001);
    expect(layer.translateBufferPosition([999_999, 1]).toArray()).toEqual([999_999, 1]);
  });

  it("handles distant folds, overlapping folds, restoration, and copies without scanning hidden rows", () => {
    const { buffer, layer } = build("ab\tcd\n".repeat(100_000));
    const lineReads = spyOn(buffer, "lineForRow").and.callThrough();
    layer.foldBufferRange([
      [10, 1],
      [90_000, 2],
    ]);
    expect(layer.getScreenLineCount()).toBe(10_011);
    expect(layer.getScreenLine(10).lineText).toBe("a⋯  cd");
    expect(lineReads.calls.count()).toBeLessThan(10);
    const copy = layer.copy();
    layer.foldBufferRange([
      [90_000, 1],
      [90_001, 3],
    ]);
    expect(copy.getScreenLineCount()).toBe(10_011);
    expect(layer.getScreenLineCount()).toBe(10_010);
    buffer.insert([0, 0], "lead\n");
    buffer.undo();
    expect(layer.getScreenLine(10).lineText).toBe("a⋯cd");
    layer.destroyAllFolds();
    expect(layer.getScreenLineCount()).toBe(100_001);
    expect(copy.getScreenLineCount()).toBe(10_011);
  });

  it("builds bounded windows without materializing giant source lines", () => {
    const { buffer, layer } = build(`${"a".repeat(40_000)}\tAB😀CD${"z".repeat(40_000)}`);
    const full = layer.getScreenLine(0).lineText;
    spyOn(buffer, "lineForRow").and.throwError("unbounded line read");
    for (const [start, end] of [
      [0, 7],
      [39_998, 40_007],
      [40_007, 40_017],
      [79_999, 80_010],
    ]) {
      const window = layer.getScreenLineWindow(0, start, end);
      expect(window.lineText).toBe(
        full.slice(window.startScreenColumn, window.startScreenColumn + window.lineText.length),
      );
      expect(window.lineText.length).toBeLessThan(30);
      expect(window.totalScreenLineLength).toBe(full.length);
      expect(/^[\udc00-\udfff]/.test(window.lineText)).toBe(false);
      expect(/[\ud800-\udbff]$/.test(window.lineText)).toBe(false);
    }
    buffer.insert([0, 0], "\n");
    expect(layer.getScreenLineWindow(1, 39_998, 40_010).lineText).toBe(full.slice(39_998, 40_010));
    expect(layer.translateBufferPosition([1, 40_001]).column).toBe(40_004);
    expect(layer.translateScreenPosition([1, 40_003], { clipDirection: "forward" }).column).toBe(
      40_001,
    );
  });

  it("preserves fold, tab, invisible and syntax scopes in a horizontal window", () => {
    const { buffer, layer } = build("   abc\tdef hidden\nother hidden\ntail  xyz   ", {
      invisibles: { space: "·", tab: "→" },
    });
    buffer.setLanguageMode(
      new TestLanguageMode([
        [
          "outer",
          [
            [0, 1],
            [2, 10],
          ],
        ],
        [
          "inner",
          [
            [0, 4],
            [0, 10],
          ],
        ],
      ]),
    );
    layer.foldBufferRange([
      [0, 11],
      [2, 4],
    ]);
    const full = layer.getScreenLine(0);
    for (let start = 0; start < full.lineText.length - 4; start++) {
      const window = layer.getScreenLineWindow(0, start, start + 4);
      expect(window.lineText).toBe(
        full.lineText.slice(
          window.startScreenColumn,
          window.startScreenColumn + window.lineText.length,
        ),
      );
      expect(characterScopes(layer, window)).toEqual(
        characterScopes(layer, full).slice(
          window.startScreenColumn,
          window.startScreenColumn + window.lineText.length,
        ),
      );
    }
  });

  it("requires bounded source reads even when a fold makes a giant line look short", () => {
    const { buffer, layer } = build(`a${"x".repeat(100_000)}z`);
    layer.foldBufferRange([
      [0, 1],
      [0, 100_001],
    ]);
    spyOn(buffer, "lineForRow").and.throwError("unbounded folded line read");
    expect(layer.lineLengthForScreenRow(0)).toBe(3);
    expect(layer.requiresScreenLineWindow(0)).toBe(true);
    expect(layer.getScreenLineWindow(0, 0, 3).lineText).toBe("a⋯z");
  });

  it("switches projection before a large insertion is laid out", () => {
    const { buffer, layer } = build("small", {
      softWrapColumn: 8,
      resolveSoftWrapColumn: ({ lineCount }) => (lineCount > 100 ? Infinity : 8),
    });
    buffer.insert([0, 0], "x\n".repeat(1000));
    expect(layer.softWrapColumn).toBe(Infinity);
    expect(layer.getScreenLineCount()).toBe(1001);
    expect(layer.screenLineLengths.storedCount).toBeLessThan(10);
    const copy = layer.copy();
    const layouts = spyOn(layer, "updateSpatialIndex").and.callThrough();
    buffer.undo();
    expect(layer.softWrapColumn).toBe(8);
    expect(layer.getScreenLines().map((line) => line.lineText)).toEqual(["small"]);
    expect(copy.softWrapColumn).toBe(8);
    expect(copy.layoutState).toBe(layer.layoutState);
    expect(layouts.calls.allArgs().every((args) => args[2] <= 1)).toBe(true);
  });
});

function characterScopes(layer, line) {
  const active = [];
  const scopes = [];
  for (const tag of line.tags) {
    if (tag >= 0) {
      for (let index = 0; index < tag; index++) scopes.push(active.slice().sort());
    } else if (layer.isOpenTag(tag)) active.push(layer.classNameForScopeId(-tag));
    else active.splice(active.lastIndexOf(layer.classNameForScopeId(-tag - 1)), 1);
  }
  return scopes;
}
