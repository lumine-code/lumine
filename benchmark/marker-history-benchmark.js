// Use one immutable source and one native build per process. The runner writes
// only when --output is supplied; alternate baseline/candidate process order.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const source = path.resolve(option("source", path.join(__dirname, "..")));
const TextBuffer = require(path.join(source, "src/text-buffer"));
const MarkerLayer = require(path.join(source, "src/marker-layer"));
const samples = Number(option("samples", 20));
const warmups = Number(option("warmups", 5));
const counts = option("counts", "0,1000,10000").split(",").map(Number);
const filter = new RegExp(option("filter", "."));
assert(Number.isInteger(samples) && samples >= 1);
assert(Number.isInteger(warmups) && warmups >= 0);
assert(counts.every((count) => Number.isInteger(count) && count >= 0));
assert(global.gc, "Run with --expose-gc to collect between independently prepared samples");

const results = [];
for (const count of counts) {
  for (const history of [false, true]) {
    for (const operation of [
      "snapshot",
      "replace-before",
      "insert-before",
      "newline-before",
      "insert-same-row",
      "replace-touched",
    ]) {
      if (operation === "snapshot" && !history) continue;
      const id = `${operation}/${count}/${history ? "history" : "no-history"}`;
      if (!filter.test(id)) continue;
      const samplesMs = [];
      const singleRow = operation === "insert-same-row";
      const text = singleRow ? "abcd".repeat(count + 2) : "abcd\n".repeat(count + 2);
      for (let sample = -warmups; sample < samples; sample++) {
        const buffer = new TextBuffer(text);
        const layer = buffer.addMarkerLayer({ maintainHistory: history });
        for (let index = 0; index < count; index++) {
          const start = singleRow ? [0, (index + 1) * 4] : [index + 1, 0];
          layer.markRange([start, [start[0], start[1] + 2]], { invalidate: "never" });
        }
        // A checkpoint models history that already retains a prior generation.
        // Its creation, native oracle and fixture allocation are not timed.
        buffer.createCheckpoint();
        const position = operation === "replace-touched" && count ? [1, 0] : [0, 0];
        const replacement = operation.startsWith("replace");
        const inserted = operation === "newline-before" ? "x\n" : "x";
        const range = [position, [position[0], position[1] + (replacement ? 1 : 0)]];
        global.gc();
        let snapshot;
        const started = performance.now();
        if (operation === "snapshot") snapshot = layer.createSnapshot();
        else buffer.setTextInRange(range, inserted);
        const elapsed = performance.now() - started;
        if (sample >= 0) samplesMs.push(elapsed);
        if (snapshot) {
          assert.equal(Object.keys(MarkerLayer.materializeSnapshot(snapshot)).length, count);
        } else {
          const offset = singleRow ? position[1] : position[0] * 5 + position[1];
          assert.equal(
            buffer.getText(),
            text.slice(0, offset) + inserted + text.slice(offset + (replacement ? 1 : 0)),
          );
          if (history) layer.verifyHistorySnapshot(layer.createSnapshot());
          assert.equal(buffer.undo(), true);
          assert.equal(buffer.getText(), text);
          if (history) layer.verifyHistorySnapshot(layer.createSnapshot());
        }
        buffer.destroy();
      }
      const sorted = samplesMs.slice().sort((a, b) => a - b);
      results.push({
        id,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        samplesMs,
      });
    }
  }
}

if (process.argv.includes("--models")) {
  const TextEditor = require(path.join(source, "src/text-editor"));
  globalThis.requestIdleCallback = () => 1;
  globalThis.cancelIdleCallback = () => {};
  TextEditor.setClipboard({ readWithMetadata: () => ({ text: "" }) });
  for (const count of [1, 100, 1000]) {
    for (const kind of ["cursors", "folds"]) {
      const id = `editor/${kind}/${count}`;
      if (!filter.test(id)) continue;
      const samplesMs = [];
      const text = "abcdef\n".repeat(count * 3 + 5);
      for (let sample = -warmups; sample < samples; sample++) {
        const buffer = new TextBuffer(text);
        const editor = new TextEditor({
          buffer,
          autoIndent: false,
          softWrapped: false,
          undoGroupingInterval: 0,
        });
        if (kind === "cursors") {
          editor.setSelectedBufferRanges(
            Array.from({ length: count }, (_, index) => [
              [index * 3 + 1, 1],
              [index * 3 + 1, 1],
            ]),
          );
        } else {
          for (let index = 0; index < count; index++)
            editor.foldBufferRange([
              [index * 3 + 1, 1],
              [index * 3 + 2, 3],
            ]);
        }
        editor.getScreenLineCount();
        const selectionBefore = editor.getSelectedBufferRanges().map((range) => range.serialize());
        global.gc();
        const started = performance.now();
        editor.insertText("x");
        const elapsed = performance.now() - started;
        if (sample >= 0) samplesMs.push(elapsed);
        assert.equal(buffer.getLength(), text.length + (kind === "cursors" ? count : 1));
        editor.undo();
        assert.equal(buffer.getText(), text);
        assert.deepEqual(
          editor.getSelectedBufferRanges().map((range) => range.serialize()),
          selectionBefore,
        );
        assert.equal(
          editor.displayLayer.foldsMarkerLayer.getMarkerCount(),
          kind === "folds" ? count : 0,
        );
        editor.destroy();
        if (!buffer.isDestroyed()) buffer.destroy();
      }
      const sorted = samplesMs.slice().sort((a, b) => a - b);
      results.push({
        id,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        samplesMs,
      });
    }
  }
}

const retainedHistory = [];
const memoryEdits = Number(option("memory-edits", 0));
assert(Number.isInteger(memoryEdits) && memoryEdits >= 0);
if (memoryEdits) {
  for (const count of counts) {
    for (const inserted of ["x", "x\n"]) {
      const buffer = new TextBuffer("abcd\n".repeat(count + 2));
      const layer = buffer.addMarkerLayer({ maintainHistory: true });
      for (let row = 1; row <= count; row++) {
        layer.markRange(
          [
            [row, 0],
            [row, 2],
          ],
          { invalidate: "never" },
        );
      }
      global.gc();
      const before = process.memoryUsage();
      for (let edit = 0; edit < memoryEdits; edit++) buffer.insert([0, 0], inserted);
      global.gc();
      const after = process.memoryUsage();
      retainedHistory.push({
        count,
        inserted,
        edits: memoryEdits,
        heapDeltaBytes: after.heapUsed - before.heapUsed,
        externalDeltaBytes: after.external - before.external,
      });
      for (let edit = 0; edit < memoryEdits; edit++) assert.equal(buffer.undo(), true);
      assert.equal(buffer.getText(), "abcd\n".repeat(count + 2));
      layer.verifyHistorySnapshot(layer.createSnapshot());
      buffer.destroy();
    }
  }
}

const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const native = Object.keys(require.cache).find((file) => file.endsWith("superstring.node"));
const sourceHashes = Object.fromEntries(
  [
    "text-buffer.js",
    "marker-layer.js",
    "marker.js",
    "default-history-provider.js",
    "marker-history-map.js",
  ]
    .filter((name) => fs.existsSync(path.join(source, "src", name)))
    .map((name) => [name, hash(path.join(source, "src", name))]),
);
const report = {
  schemaVersion: 1,
  node: process.version,
  platform: process.platform,
  cpu: os.cpus()[0].model,
  source,
  sourceHashes,
  benchmarkSha256: hash(__filename),
  nativeSha256: hash(native),
  samples,
  warmups,
  results,
  retainedHistory,
};
const json = JSON.stringify(report, null, 2);
if (option("output")) fs.writeFileSync(path.resolve(option("output")), json);
console.log(json);
