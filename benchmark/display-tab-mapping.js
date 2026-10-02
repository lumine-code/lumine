const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

// Freeze with script/benchmark-display.js, then pass --baseline <frozen source>.
// For fresh-process controls, --source <source> --case <id> measures one variant.
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? null : args[index + 1];
}
const baselinePath = option("baseline");
const sourcePath = path.resolve(option("source") || path.join(__dirname, ".."));
const TextBuffer = require(path.join(sourcePath, "src/text-buffer"));
const { isWrapBoundary } = require(path.join(sourcePath, "src/text-utils"));
const BaselineBuffer = baselinePath
  ? require(path.resolve(baselinePath, "src/text-buffer"))
  : TextBuffer;
const baselineWrapBoundary = baselinePath
  ? require(path.resolve(baselinePath, "src/text-utils")).isWrapBoundary
  : isWrapBoundary;
const samples = 12;
const repetitions = 16;
const warmups = 20;
const cases = [
  { id: "sparse-4k", text: `${"x".repeat(4096)}\tend` },
  { id: "sparse-64k", text: `${"x".repeat(65536)}\tend` },
  { id: "early-64k", text: `${"x".repeat(65536)}\tend`, early: true },
  { id: "dense-tabs", text: "ab\t".repeat(1024) },
  { id: "short-lines", text: "const value = 123;\treturn value;" },
  { id: "unicode-16k", text: `${"😀e\u0301界".repeat(4096)}\tend` },
  { id: "sparse-wrap", text: `${"x".repeat(16384)}\tend`, wrap: 500 },
  { id: "words-wrap", text: "alpha beta gamma\t".repeat(1024), wrap: 500 },
  {
    id: "folds-tabs",
    text: `${"x".repeat(4096)}\thidden\n${"y".repeat(4096)}\tend`,
    fold: [
      [0, 2048],
      [1, 1024],
    ],
  },
];

function build(BufferClass, entry, wrapBoundary) {
  const buffer = new BufferClass({ text: entry.text });
  const layer = buffer.addDisplayLayer({
    tabLength: 4,
    softWrapColumn: entry.wrap ?? Infinity,
    isWrapBoundary: wrapBoundary,
  });
  if (entry.fold) layer.foldBufferRange(entry.fold);
  layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
  return { buffer, layer };
}

function pointsFor(layer, early) {
  const bufferPoints = [];
  const screenPoints = [];
  for (let index = 0; index < 32; index++) {
    const bufferRow = index % layer.buffer.getLineCount();
    const screenRow = index % layer.getScreenLineCount();
    const bufferLength = layer.buffer.lineLengthForRow(bufferRow);
    const screenLength = layer.lineLengthForScreenRow(screenRow);
    bufferPoints.push([bufferRow, early ? index : Math.max(0, bufferLength - index * 3)]);
    screenPoints.push([screenRow, early ? index : Math.max(0, screenLength - index * 3)]);
  }
  return { bufferPoints, screenPoints };
}

function run(layer, points, direction) {
  let checksum = 0;
  for (let iteration = 0; iteration < repetitions; iteration++) {
    for (const point of points) {
      const result =
        direction === "bufferToScreen"
          ? layer.translateBufferPosition(point)
          : layer.translateScreenPosition(point);
      checksum += result.row + result.column;
    }
  }
  return checksum;
}

function median(values) {
  return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

const results = [];
for (const entry of cases) {
  if (option("case") && entry.id !== option("case")) continue;
  const before = build(BaselineBuffer, entry, baselineWrapBoundary);
  const after = build(TextBuffer, entry, isWrapBoundary);
  try {
    const { bufferPoints, screenPoints } = pointsFor(before.layer, entry.early);
    for (const direction of ["bufferToScreen", "screenToBuffer"]) {
      const points = direction === "bufferToScreen" ? bufferPoints : screenPoints;
      const map = (layer) =>
        points.map((point) => {
          const result =
            direction === "bufferToScreen"
              ? layer.translateBufferPosition(point)
              : layer.translateScreenPosition(point);
          return [result.row, result.column];
        });
      assert.deepEqual(map(after.layer), map(before.layer), `${entry.id}/${direction}`);
      const expected = run(before.layer, points, direction);
      for (let warmup = 0; warmup < warmups; warmup++) {
        assert.equal(run(before.layer, points, direction), expected);
        assert.equal(run(after.layer, points, direction), expected);
      }
      const timings = { before: [], after: [] };
      // Alternate ABBA order to reduce bias from JIT and temperature drift.
      for (let sample = 0; sample < samples; sample++) {
        const order = sample % 2 === 0 ? ["before", "after"] : ["after", "before"];
        for (const variant of order) {
          const layer = variant === "before" ? before.layer : after.layer;
          const start = performance.now();
          const actual = run(layer, points, direction);
          timings[variant].push(performance.now() - start);
          assert.equal(actual, expected);
        }
      }
      const beforeMs = median(timings.before);
      const afterMs = median(timings.after);
      const result = {
        id: entry.id,
        direction,
        queries: repetitions * points.length,
        beforeMs,
        afterMs,
        improvementPercent: 100 * (1 - afterMs / beforeMs),
        checksum: expected,
        timings,
        medianMs: baselinePath ? undefined : median([...timings.before, ...timings.after]),
      };
      results.push(result);
      console.log(
        baselinePath
          ? `${entry.id}/${direction}: ${beforeMs.toFixed(3)} -> ${afterMs.toFixed(3)} ms (${result.improvementPercent.toFixed(1)}%)`
          : `${entry.id}/${direction}: ${result.medianMs.toFixed(3)} ms (${result.queries} queries)`,
      );
    }
  } finally {
    before.buffer.destroy();
    after.buffer.destroy();
  }
}
if (option("output")) {
  fs.writeFileSync(
    path.resolve(option("output")),
    JSON.stringify(
      {
        runtime: process.versions,
        sourcePath,
        baselinePath,
        samples,
        repetitions,
        warmups,
        results,
      },
      null,
      2,
    ),
  );
}
