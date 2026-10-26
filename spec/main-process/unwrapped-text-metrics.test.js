const assert = require("node:assert/strict");
const test = require("node:test");
const { PieceTree } = require("../../src/text-model");
const { UnwrappedTextMetrics, UnwrappedPixelMetrics } = require("../../src/unwrapped-text-metrics");

function measure(text, column, pixel, previous, targetColumn = Infinity, targetPixel = Infinity) {
  for (
    let index = 0;
    index < text.length && column < targetColumn && pixel < targetPixel;
    index++
  ) {
    const code = text.charCodeAt(index);
    const columns = code === 9 ? this.tabLength - (column % this.tabLength) : 1;
    const width =
      code === 9
        ? columns
        : code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
          ? 0
          : code === 0x200d || code === 0x0301 || code === 0xfe0f
            ? 0
            : (code >= 0xd800 && code <= 0xdbff) || code === 0x754c
              ? 2
              : code === 90
                ? 1.5
                : 1;
    const fraction = Math.max(
      0,
      Math.min(1, (targetColumn - column) / columns, width ? (targetPixel - pixel) / width : 1),
    );
    column += columns * fraction;
    pixel += width * fraction;
    previous = code;
    if (fraction < 1) break;
  }
  return { column, pixel };
}

test("subtree tab transforms and pixel widths match scalar traversal at shifted origins", () => {
  const text = "\tZ界😀é\t👩‍🔬 A ".repeat(5000) + "tail\t";
  const source = new PieceTree(text);
  for (const tabLength of [2, 3, 4, 8, 2.5]) {
    const metrics = new UnwrappedTextMetrics(tabLength),
      root = metrics.measure(source);
    const reference = measure.bind({ tabLength });
    const pixels = new UnwrappedPixelMetrics(metrics, reference, 1);
    for (const origin of [0, 1, 3, 13.5]) {
      const result = reference(text, origin, 0, NaN);
      assert.equal(metrics.advance(root, origin), result.column);
      assert.equal(pixels.width(root, origin, NaN), result.pixel);
      for (const raw of [0, 1, 32767, 32768, 32769, text.length]) {
        const leaf = metrics.findLeaf(root, raw, origin, false);
        assert.equal(leaf.column, reference(text.slice(0, leaf.offset), origin, 0, NaN).column);
        const expected = reference(text.slice(0, raw), origin, 0, NaN);
        const pixelLeaf = pixels.findLeaf(root, expected.column, origin, 0, NaN, false);
        assert.equal(
          reference(
            pixelLeaf.node.text,
            pixelLeaf.column,
            pixelLeaf.pixel,
            pixelLeaf.previousCode,
            expected.column,
          ).pixel,
          expected.pixel,
        );
      }
    }
  }
});

test("partial surrogate pieces retain the width of their preceding source character", () => {
  const source = new PieceTree("x".repeat(32767) + "😀\t界");
  const metrics = new UnwrappedTextMetrics(4),
    reference = measure.bind({ tabLength: 4 });
  const pixels = new UnwrappedPixelMetrics(metrics, reference, 1);
  const suffix = source.subtext(32768),
    node = metrics.measure(suffix);
  assert.equal(
    pixels.width(node, 32768, 0xd83d),
    reference(suffix.toString(), 32768, 0, 0xd83d).pixel,
  );
});

test("changed paths reuse pixel summaries and locate windows without traversing the shared prefix", () => {
  let source = new PieceTree("Z\t界😀 é ".repeat(3000));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  const metrics = new UnwrappedTextMetrics(4),
    reference = measure.bind({ tabLength: 4 });
  let units = 0;
  const pixels = new UnwrappedPixelMetrics(
    metrics,
    (...args) => {
      units += args[0].length;
      return reference(...args);
    },
    1,
  );
  const before = metrics.measure(source);
  pixels.width(before, 0, NaN);
  assert.ok(units < 131072);
  units = 0;
  const after = metrics.measure(source.replace(source.length - 1, source.length, "Q"));
  const end = metrics.advance(after, 0);
  pixels.width(after, 0, NaN);
  assert.ok(units < 131072);
  const runs = [...metrics.runs(after, 0, end - 100, end)];
  assert.ok(runs.length <= 2);
  assert.equal(runs.at(-1).endColumn, end);
  assert.equal(after.firstNonWhitespace, 0);
  assert.equal(after.lastNonWhitespace, source.length - 1);
});

test("ordinary distinct backing leaves also reuse unchanged pixel summaries after edits", () => {
  const source = new PieceTree("a\t界😀 ".repeat(300000));
  const metrics = new UnwrappedTextMetrics(4),
    reference = measure.bind({ tabLength: 4 });
  let units = 0;
  const pixels = new UnwrappedPixelMetrics(
    metrics,
    (...args) => {
      units += args[0].length;
      return reference(...args);
    },
    1,
  );
  const before = metrics.measure(source);
  pixels.width(before, 0, NaN);
  assert.ok(units >= source.length);
  units = 0;
  const changed = source.replace(source.length - 2, source.length - 1, "Q");
  const after = metrics.measure(changed);
  assert.equal(pixels.width(after, 0, NaN), reference(changed.toString(), 0, 0, NaN).pixel);
  assert.ok(units < 131072, String(units));
});

test("pixel inversion uses the same leftmost boundary for every immutable leaf split", () => {
  const examples = [
    "a\u0301b",
    "\u0301b",
    "a\u0301\u0301b",
    "a\u200d\u0301b",
    "👩‍🔬x",
    "\udc00a\u0301",
    "ab\t\u0301c",
    "\t\u0301\tb",
    "a\ufe0fb",
  ];
  for (const text of examples) {
    const reference = measure.bind({ tabLength: 4 });
    const total = reference(text, 0, 0, NaN).pixel;
    const targets = [
      0,
      0.25,
      0.5,
      ...Array.from({ length: Math.ceil(total) + 1 }, (_, index) => index),
      total,
      total + 0.5,
      Infinity,
    ];
    for (let cut = 1; cut < text.length; cut++) {
      const source = PieceTree.fromSnapshotNode(
        undefined,
        new PieceTree(text.slice(0, cut)),
        new PieceTree(text.slice(cut)),
      );
      const metrics = new UnwrappedTextMetrics(4),
        root = metrics.measure(source);
      const pixels = new UnwrappedPixelMetrics(metrics, reference, 1);
      for (const target of targets) {
        const leaf = pixels.findLeaf(root, target, 0, 0, NaN, true);
        const actual = reference(
          leaf.node.text,
          leaf.column,
          leaf.pixel,
          leaf.previousCode,
          Infinity,
          target,
        ).column;
        assert.equal(
          actual,
          reference(text, 0, 0, NaN, Infinity, target).column,
          JSON.stringify({ text, cut, target }),
        );
      }
    }
  }
});
