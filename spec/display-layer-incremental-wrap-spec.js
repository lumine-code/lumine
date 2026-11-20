const TextBuffer = require("../src/text-buffer");
const { isWrapBoundary } = require("../src/text-utils");

describe("DisplayLayer incremental wrapping", () => {
  const buffers = [];

  afterEach(() => {
    while (buffers.length) buffers.pop().destroy();
  });

  function create(text, softWrapColumn) {
    const buffer = new TextBuffer(text);
    buffers.push(buffer);
    const layer = buffer.addDisplayLayer({ softWrapColumn, isWrapBoundary });
    layer.getScreenLineCount();
    return { buffer, layer };
  }

  function expectFreshGeometry(buffer, layer) {
    const fresh = create(buffer.getText(), layer.softWrapColumn).layer;
    expect(layer.spatialIndex.getChanges()).toEqual(fresh.spatialIndex.getChanges());
    expect(layer.screenLineLengths.slice()).toEqual(fresh.screenLineLengths.slice());
    expect(layer.screenLineStartFlags.slice()).toEqual(fresh.screenLineStartFlags.slice());
    expect(layer.tabCounts.slice()).toEqual(fresh.tabCounts.slice());
  }

  it("retains screen rows on both sides of an edit once the wraps converge", () => {
    const text = "before\n" + "abc de-f. ".repeat(10000) + "\nafter";
    const { buffer, layer } = create(text, 81);
    const [prefix] = layer.getScreenLines(31, 32);
    const [suffix] = layer.getScreenLines(900, 901);
    const splice = spyOn(layer, "spliceScreenLineLengths").and.callThrough();
    buffer.insert([1, 50000], "Z");

    const [start, removed, inserted] = splice.calls.mostRecent().args;
    expect(start).toBe(624);
    expect(removed).toBe(3);
    expect(inserted.length).toBe(3);
    expect(layer.getScreenLines(31, 32)[0]).toBe(prefix);
    expect(layer.getScreenLines(900, 901)[0]).toBe(suffix);
    expectFreshGeometry(buffer, layer);
  });

  it("keeps a distant prefix before an edit whose fixed wraps cannot converge", () => {
    const { buffer, layer } = create("x".repeat(1_000_000), 80);
    const splice = spyOn(layer, "spliceScreenLineLengths").and.callThrough();
    buffer.insert([0, 999998], "x");

    const [start, removed, inserted] = splice.calls.mostRecent().args;
    expect(start).toBe(12498);
    expect(removed).toBe(2);
    expect(inserted).toEqual([80, 80, 1]);
    expect(layer.translateBufferPosition([0, 1000001]).toArray()).toEqual([12500, 1]);
  });

  it("bulk replaces every affected wrap when an edit near the head cannot converge", () => {
    const line = '{"payload":[' + '"abc de-f.,ghi jkl.mnop",'.repeat(41000) + '"finish"]}';
    const { buffer, layer } = create(line + "\na\n  hidden\nz\nlast", 81);
    const fold = [
      [1, 1],
      [3, 0],
    ];
    layer.foldBufferRange(fold);
    for (let index = 0; index < 20; index++) buffer.insert([0, line.length - 40 + index], " ");
    const scalarSplice = spyOn(layer.spatialIndex, "splice").and.callThrough();
    const rowSplice = spyOn(layer, "spliceScreenLineLengths").and.callThrough();

    for (let index = 0; index < 5; index++) buffer.insert([0, 20 + index], " ");

    expect(scalarSplice).not.toHaveBeenCalled();
    const [start, removed, inserted] = rowSplice.calls.mostRecent().args;
    expect(start).toBe(0);
    expect(removed).toBe(13667);
    expect(inserted.length).toBe(13667);
    const fresh = create(buffer.getText(), 81).layer;
    fresh.foldBufferRange(fold);
    expect(layer.spatialIndex.getChanges()).toEqual(fresh.spatialIndex.getChanges());
    expect(layer.screenLineLengths.slice()).toEqual(fresh.screenLineLengths.slice());
    expect(layer.getText(13665)).toBe(fresh.getText(13665));
  });

  it("maintains exact one-column wrap checkpoints through insert, delete, undo and redo", () => {
    const { buffer, layer } = create("a\n" + "x".repeat(4200) + "\nb", 1);
    buffer.insert([1, 4198], "a -b");
    expectFreshGeometry(buffer, layer);
    buffer.delete([
      [1, 4185],
      [1, 4201],
    ]);
    expectFreshGeometry(buffer, layer);
    buffer.undo();
    expectFreshGeometry(buffer, layer);
    buffer.redo();
    expectFreshGeometry(buffer, layer);
  });

  it("refreshes earlier trailing whitespace when a distant edit changes its decoration", () => {
    const { buffer, layer } = create("x".repeat(8000) + " ".repeat(6000), 80);
    const row = 120;
    const [trailing] = layer.getScreenLines(row, row + 1);
    buffer.append("z");
    const [interior] = layer.getScreenLines(row, row + 1);
    expect(interior).not.toBe(trailing);
    expect(interior.tags).not.toEqual(trailing.tags);
    expectFreshGeometry(buffer, layer);
  });

  it("recomputes exact geometry when edits introduce tabs and Unicode", () => {
    const { buffer, layer } = create("abc de-f. ".repeat(500), 21);
    buffer.insert([0, 2500], "\t你a\u0300🙂");
    expectFreshGeometry(buffer, layer);
    buffer.delete([
      [0, 2500],
      [0, 2506],
    ]);
    expectFreshGeometry(buffer, layer);
    buffer.insert([0, 2490], " ");
    expectFreshGeometry(buffer, layer);
  });
});
