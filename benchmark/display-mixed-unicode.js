const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}
const source = path.resolve(option("source", path.join(__dirname, "..")));
const TextBuffer = require(path.join(source, "src/text-buffer"));
const utils = require(path.join(source, "src/text-utils"));
const samples = Number(option("samples", 12));
const warmups = Number(option("warmups", 4));
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

function standardRatio(character) {
  if (utils.isKoreanCharacter(character)) return 1.75;
  if (utils.isHalfWidthCharacter(character)) return 0.75;
  if (utils.isDoubleWidthCharacter(character)) return 2;
  return 1;
}

const token = "x".repeat(250000);
const withMiddle = (text, event) => {
  const middle = Math.floor(text.length / 2);
  return text.slice(0, middle) + event + text.slice(middle);
};
const words = "alpha beta gamma delta\t".repeat(12000);
const cases = [
  { id: "ascii-token", text: token, wrap: 500 },
  { id: "one-emoji", text: withMiddle(token, "😀"), wrap: 500 },
  { id: "one-combining", text: withMiddle(token, "e\u0301"), wrap: 500 },
  { id: "one-cjk", text: withMiddle(token, "界"), wrap: 500 },
  { id: "ascii-words-tabs", text: words, wrap: 80 },
  { id: "sparse-words-unicode", text: withMiddle(words, "😀e\u0301界"), wrap: 80 },
  { id: "dense-unicode", text: "x界😀e\u0301한ｶ ".repeat(25000), wrap: 80 },
  { id: "unwrapped-unicode", text: "😀界e\u0301한ｶ\t".repeat(25000), wrap: Infinity },
  { id: "short-unicode", text: "alpha 😀 beta 界 gamma\tend", wrap: 12 },
  { id: "one-emoji-custom", text: withMiddle(token, "😀"), wrap: 500, custom: true },
  {
    id: "folds-unicode",
    text: `${withMiddle(token, "界")}\n${withMiddle(token, "😀")}`,
    wrap: 500,
    folds: [
      [
        [0, 100000],
        [1, 100000],
      ],
    ],
  },
];

function snapshot(layer) {
  const screenRows = [
    0,
    Math.min(1, layer.getLastScreenRow()),
    Math.floor(layer.screenLineLengths.length / 2),
    layer.getLastScreenRow(),
  ];
  const points = [];
  for (let row = 0; row < layer.buffer.getLineCount(); row++) {
    const length = layer.buffer.lineLengthForRow(row);
    for (const column of [0, 1, Math.floor(length / 2), length - 1, length]) {
      const screen = layer.translateBufferPosition([row, column]);
      const buffer = layer.translateScreenPosition(screen);
      points.push([screen.row, screen.column, buffer.row, buffer.column]);
    }
  }
  return hash({
    lengths: layer.screenLineLengths,
    tabs: layer.tabCounts,
    flags: layer.screenLineStartFlags,
    hunks: layer.spatialIndex.getChanges(),
    rightmost: layer.getRightmostScreenPosition(),
    lines: screenRows.map((row) => {
      const { lineText, tags, softWrapIndent } = layer.getScreenLine(row);
      return { lineText, tags, softWrapIndent };
    }),
    points,
  });
}

const results = [];
for (const entry of cases) {
  if (option("case") && entry.id !== option("case")) continue;
  const times = { index: [], insert: [], remove: [] };
  let checksum;
  for (let iteration = -warmups; iteration < samples; iteration++) {
    const buffer = new TextBuffer({ text: entry.text });
    const ratio = entry.custom ? (character) => standardRatio(character) : standardRatio;
    const layer = buffer.addDisplayLayer({
      softWrapColumn: entry.wrap,
      tabLength: 4,
      ratioForCharacter: ratio,
      standardRatioForCharacter: entry.custom ? null : ratio,
      isWrapBoundary: utils.isWrapBoundary,
    });
    try {
      const start = performance.now();
      for (const fold of entry.folds || []) layer.foldBufferRange(fold);
      layer.populateSpatialIndexIfNeeded(Infinity, Infinity);
      const indexMs = performance.now() - start;
      const before = snapshot(layer);
      const column = Math.floor(buffer.lineLengthForRow(0) / 4);
      const insertStart = performance.now();
      buffer.insert([0, column], "q");
      const insertMs = performance.now() - insertStart;
      const inserted = snapshot(layer);
      const removeStart = performance.now();
      buffer.delete([
        [0, column],
        [0, column + 1],
      ]);
      const removeMs = performance.now() - removeStart;
      assert.equal(snapshot(layer), before, `${entry.id} restored layout`);
      const currentChecksum = hash([before, inserted]);
      if (checksum) assert.equal(currentChecksum, checksum, `${entry.id} output stability`);
      checksum = currentChecksum;
      if (iteration >= 0) {
        times.index.push(indexMs);
        times.insert.push(insertMs);
        times.remove.push(removeMs);
      }
    } finally {
      buffer.destroy();
    }
  }
  const result = {
    id: entry.id,
    textLength: entry.text.length,
    checksum,
    samplesMs: times,
    medianMs: Object.fromEntries(
      Object.entries(times).map(([name, values]) => [name, median(values)]),
    ),
  };
  results.push(result);
  console.log(`${entry.id}: ${JSON.stringify(result.medianMs)} ms`);
}
const report = {
  source,
  runtime: process.versions,
  cpu: os.cpus()[0].model,
  samples,
  warmups,
  results,
};
if (option("output"))
  fs.writeFileSync(path.resolve(option("output")), JSON.stringify(report, null, 2));
