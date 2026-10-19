const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const option = (key, fallback) =>
  args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const source = path.resolve(option("source", path.join(__dirname, "..")));
const TextBuffer = require(path.join(source, "src/text-buffer"));
const samples = Number(option("samples", 9)),
  warmups = Number(option("warmups", 3));
const scenarios = [
  { id: "replace-1000", count: 1000, markers: 0 },
  { id: "replace-1000-markers", count: 1000, markers: 1000 },
  { id: "replace-1000-dense-markers", count: 1000, markers: 10000 },
  { id: "replace-5000-markers", count: 5000, markers: 1000 },
  { id: "replace-one-line-1000", count: 1000, markers: 1000, sameRow: true },
  { id: "replace-one-line-5000", count: 5000, markers: 1000, sameRow: true },
  { id: "independent-5000", count: 5000, markers: 1000, planned: true },
  { id: "multiline-replacement-1000", count: 1000, markers: 1000, multiline: true },
  { id: "single-edit-control", count: 1000, markers: 10000, single: true },
];
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
function state(buffer, layer, display) {
  return sha(
    JSON.stringify({
      text: buffer.getText(),
      markers: layer
        .getMarkers()
        .map((marker) => [marker.getRange().serialize(), marker.isValid()]),
      lines: display.getScreenLines().map((line) => line.lineText),
    }),
  );
}
function build(scenario) {
  const line = scenario.sameRow ? "foo tail " : "foo tail\n";
  const original = line.repeat(scenario.count);
  const buffer = new TextBuffer(original);
  const display = buffer.addDisplayLayer({ softWrapColumn: 80 });
  display.getScreenLines();
  const layer = buffer.addMarkerLayer({ maintainHistory: true });
  const strategies = ["never", "touch", "inside", "overlap", "surround"];
  for (let i = 0; i < scenario.markers; i++) {
    const row = scenario.sameRow ? 0 : i % scenario.count,
      column = scenario.sameRow ? (i % scenario.count) * line.length : 0;
    layer.markRange(
      [
        [row, column],
        [row, column + 3],
      ],
      { invalidate: strategies[i % strategies.length], exclusive: i % 2 === 0 },
    );
  }
  buffer.clearUndoStack();
  return { buffer, display, layer, original, line };
}
function apply(context, scenario, scalar = false) {
  const { buffer, line } = context;
  if (scenario.single) return buffer.insert([500, 4], "X");
  const replacement = scenario.multiline ? "longer\nvalue" : "longer";
  if (scenario.planned || scalar) {
    const edits = Array.from({ length: scenario.count }, (_, i) => ({
      range: [
        [scenario.sameRow ? 0 : i, scenario.sameRow ? i * line.length : 0],
        [scenario.sameRow ? 0 : i, (scenario.sameRow ? i * line.length : 0) + 3],
      ],
      text: replacement,
    }));
    if (scenario.planned && !scalar) buffer.setTextInIndependentRanges(edits);
    else
      buffer.transact(() => {
        for (const edit of edits.reverse())
          buffer.setTextInRange(edit.range, edit.text, { normalizeLineEndings: false });
      });
  } else assert.equal(buffer.replace(/foo/g, replacement), scenario.count);
}
const results = [];
for (const scenario of scenarios) {
  const oracle = build(scenario),
    expected = { before: state(oracle.buffer, oracle.layer, oracle.display) };
  apply(oracle, scenario, true);
  expected.edit = state(oracle.buffer, oracle.layer, oracle.display);
  oracle.buffer.undo();
  expected.undo = state(oracle.buffer, oracle.layer, oracle.display);
  oracle.buffer.redo();
  expected.redo = state(oracle.buffer, oracle.layer, oracle.display);
  oracle.buffer.destroy();
  const values = { edit: [], undo: [], redo: [] };
  for (let sample = -warmups; sample < samples; sample++) {
    const context = build(scenario),
      { buffer, layer, display } = context;
    assert.equal(state(buffer, layer, display), expected.before);
    for (const operation of ["edit", "undo", "redo"]) {
      global.gc?.();
      const start = performance.now();
      if (operation === "edit") apply(context, scenario);
      else buffer[operation]();
      const elapsed = performance.now() - start;
      assert.equal(
        state(buffer, layer, display),
        expected[operation],
        `${scenario.id}/${operation}`,
      );
      if (sample >= 0) values[operation].push(elapsed);
    }
    buffer.destroy();
  }
  for (const [operation, times] of Object.entries(values))
    results.push({
      id: `${scenario.id}/${operation}`,
      median: median(times),
      p95: times.slice().sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1],
      samples: times,
    });
}
const files = [
  "text-buffer.js",
  "text-store.js",
  "text-patch.js",
  "marker-layer.js",
  "helpers.js",
  "piece-tree.js",
  "marker-index.js",
];
const report = {
  node: process.version,
  samples,
  warmups,
  driverHash: sha(fs.readFileSync(__filename)),
  sourceHashes: Object.fromEntries(
    files.map((file) => [file, sha(fs.readFileSync(path.join(source, "src", file)))]),
  ),
  results,
};
fs.writeFileSync(
  option("output", "bulk-edit-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(results.map(({ id, median }) => ({ id, median }))));
