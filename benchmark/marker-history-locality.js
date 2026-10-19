// Run with --expose-gc. --source points at an immutable editor checkout.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const source = path.resolve(option("source", path.join(__dirname, "..")));
const TextBuffer = require(path.join(source, "src/text-buffer"));
const MarkerLayer = require(path.join(source, "src/marker-layer"));
const samples = Number(option("samples", 15));
const warmups = Number(option("warmups", 4));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const scenarios = [
  { id: "typing-no-markers", markers: 0, edits: 1 },
  { id: "typing-10-markers", markers: 10, edits: 1 },
  { id: "typing-1000-markers", markers: 1000, edits: 1 },
  { id: "typing-10000-markers", markers: 10000, edits: 1 },
  { id: "scalar-batch-10000-markers", markers: 10000, edits: 100 },
  { id: "bulk-batch-10000-markers", markers: 10000, edits: 100, bulk: true },
  { id: "same-row-10000-markers", markers: 10000, edits: 1, sameRow: true },
  { id: "mostly-same-row-10000-markers", markers: 10000, edits: 1, skewed: true },
  { id: "touching-row-10000-markers", markers: 10000, edits: 1, sameRow: true, touching: true },
  { id: "newline-10000-markers", markers: 10000, edits: 1, newline: true },
];
const results = [];
for (const scenario of scenarios) {
  const times = [];
  let outputHash;
  for (let sample = -warmups; sample < samples; sample++) {
    const original = "abcdefghij\n".repeat(10000);
    const buffer = new TextBuffer(original);
    const layer = buffer.addMarkerLayer({ maintainHistory: true });
    for (let i = 0; i < scenario.markers; i++) {
      const row = scenario.sameRow || (scenario.skewed && i < 9000) ? 5000 : i;
      layer.markRange(
        [
          [row, scenario.touching ? 2 : 7],
          [row, 9],
        ],
        {
          invalidate: "never",
          exclusive: i % 2 === 0,
        },
      );
    }
    buffer.clearUndoStack();
    const edits = Array.from({ length: scenario.edits }, (_, i) => ({
      range: [
        [5000 + i, 3],
        [5000 + i, 3],
      ],
      text: scenario.newline ? "x\ny" : "x",
    }));
    global.gc?.();
    const start = performance.now();
    if (scenario.bulk) buffer.setTextInIndependentRanges(edits);
    else
      buffer.transact(() => {
        for (const edit of edits) buffer.setTextInRange(edit.range, edit.text);
      });
    const elapsed = performance.now() - start;
    if (sample >= 0) times.push(elapsed);
    const snapshot = MarkerLayer.materializeSnapshot(layer.createSnapshot());
    const ranges = layer.index.dump();
    for (const [id, state] of Object.entries(snapshot))
      assert.deepEqual(state.range.serialize(), [
        [ranges[id].start.row, ranges[id].start.column],
        [ranges[id].end.row, ranges[id].end.column],
      ]);
    const digest = sha(JSON.stringify([buffer.getText(), ranges]));
    if (outputHash) assert.equal(digest, outputHash);
    outputHash = digest;
    buffer.undo();
    assert.equal(buffer.getText(), original);
    buffer.redo();
    assert.equal(sha(JSON.stringify([buffer.getText(), layer.index.dump()])), outputHash);
    buffer.destroy();
  }
  const sorted = times.slice().sort((a, b) => a - b);
  results.push({
    ...scenario,
    outputHash,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: times,
  });
}
const report = {
  node: process.version,
  samples,
  warmups,
  driverHash: sha(fs.readFileSync(__filename)),
  results,
};
const output = option("output");
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.table(results.map(({ id, median, p95 }) => ({ id, median, p95 })));
