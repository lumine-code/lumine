// Compare the current editor buffer with the JS document kernel, not two
// parser runtimes. No DOM, marker population, disk I/O or syntax work is timed.
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const samples = Number(option("samples", 9));
const warmups = Number(option("warmups", 3));
const units = option("units", "1000000,8000000,32000000").split(",").map(Number);
const worker = option("worker", null);
const nativeSource = option("native-source", null);
assert(
  nativeSource,
  "This historical kernel benchmark needs --native-source pointing to an archived native editor. Use benchmark:document-integration for the current editor comparison.",
);
const quantile = (values, fraction) =>
  values.slice().sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
const summary = (values) => ({
  median: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  samples: values,
});

function adapter(backend, source) {
  const Reader = require("../src/tree-sitter-document");
  if (backend === "javascript") {
    const { DocumentCore } = require("../src/document-core");
    const document = new DocumentCore(source);
    const reader = new Reader(document);
    return {
      capture: (previous) => reader.capture(previous && { revision: previous.revision }),
      edit: (start, end, text) => document.transact((draft) => draft.replace(start, end, text)),
      batch: (edits) => document.transact((draft) => draft.replaceAll(edits)),
      undo: () => document.undo(),
      redo: () => document.redo(),
      readLines: (row, count) => {
        const text = document.getTextSnapshot();
        return text.slice(text.lineStart(row), text.lineStart(row + count));
      },
      stats: () => document.getTextSnapshot().inspect(),
      close: () => {
        reader.close();
        document.clearHistory();
      },
    };
  }
  const nativeFile = path.join(path.resolve(nativeSource), "src", "text-buffer.js");
  assert(
    fs.readFileSync(nativeFile, "utf8").includes('require("@lumine-code/superstring")'),
    "The native reference must actually use Superstring",
  );
  const TextBuffer = require(nativeFile);
  const document = new TextBuffer(source);
  const reader = new Reader(document);
  return {
    capture: (previous) => reader.capture(previous && { revision: previous.revision }),
    edit: (start, end, text) =>
      document.setTextInRange(
        [document.positionForCharacterIndex(start), document.positionForCharacterIndex(end)],
        text,
        { normalizeLineEndings: false },
      ),
    batch: (edits) =>
      document.transact(() => {
        for (const { start, end, text } of edits.slice().sort((a, b) => b.start - a.start))
          document.setTextInRange(
            [document.positionForCharacterIndex(start), document.positionForCharacterIndex(end)],
            text,
            { normalizeLineEndings: false },
          );
      }),
    undo: () => document.undo(),
    redo: () => document.redo(),
    readLines: (row, count) =>
      document.getTextInRange([
        [row, 0],
        [row + count, 0],
      ]),
    stats: () => null,
    close: () => {
      reader.close();
      document.destroy();
    },
  };
}

function run(backend) {
  const output = [];
  // A non-ASCII code unit forces a fair two-byte text payload in both models.
  const line = 'const value = "終";\n';
  for (const length of units) {
    const source = line.repeat(Math.ceil(length / line.length)).slice(0, length);
    const document = adapter(backend, source);
    let snapshot = document.capture();
    const metrics = {
      edit: [],
      snapshot: [],
      editAndSnapshot: [],
      viewportRead: [],
      batch64: [],
      undo: [],
      redo: [],
    };
    for (let sample = 0; sample < samples + warmups; sample++) {
      global.gc?.();
      const value = sample % 2 ? "x" : "y";
      const start = performance.now();
      document.edit(6, 7, value);
      const edited = performance.now();
      snapshot = document.capture(snapshot);
      const captured = performance.now();
      const view = document.readLines(10, 80);
      const read = performance.now();
      assert.equal(snapshot.text.length, length);
      assert.equal(snapshot.text.slice(6, 7), value);
      assert.equal(view, source.slice(line.length * 10, line.length * 90));
      if (sample >= warmups) {
        metrics.edit.push(edited - start);
        metrics.snapshot.push(captured - edited);
        metrics.editAndSnapshot.push(captured - start);
        metrics.viewportRead.push(read - captured);
      }
    }
    for (let sample = 0; sample < samples + warmups; sample++) {
      const edits = Array.from({ length: 64 }, (_, row) => ({
        start: (row + 100) * line.length,
        end: (row + 100) * line.length,
        text: "// ",
      }));
      global.gc?.();
      const start = performance.now();
      document.batch(edits);
      const edited = performance.now();
      const changed = document.capture(snapshot);
      assert.equal(changed.text.length, length + 192);
      const undoStart = performance.now();
      document.undo();
      const undone = performance.now();
      assert.equal(document.capture().text.length, length);
      const redoStart = performance.now();
      document.redo();
      const redone = performance.now();
      assert.equal(document.capture().text.slice(line.length * 100, line.length * 100 + 3), "// ");
      if (sample >= warmups) {
        metrics.batch64.push(edited - start);
        metrics.undo.push(undone - undoStart);
        metrics.redo.push(redone - redoStart);
      }
      document.undo();
      snapshot = document.capture();
    }
    output.push({
      units: length,
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([name, values]) => [name, summary(values)]),
      ),
      structure: document.stats(),
    });
    document.close();
  }
  // Retain exactly the same number of source versions, with no parser trees.
  // Report both RSS and heap: neither alone is a native live-allocation count.
  global.gc?.();
  const before = process.memoryUsage();
  const source = "x終\n".repeat(Math.ceil(8000000 / 3)).slice(0, 8000000);
  const document = adapter(backend, source);
  const retained = [document.capture()];
  for (let index = 0; index < 20; index++) {
    document.edit(0, 1, index % 2 ? "x" : "y");
    retained.push(document.capture(retained.at(-1)));
  }
  global.gc?.();
  const after = process.memoryUsage();
  assert.equal(retained[0].text.slice(0, 1), "x");
  assert.equal(retained[1].text.slice(0, 1), "y");
  const memory = {
    retainedSnapshots: retained.length,
    units: source.length,
    rssDelta: after.rss - before.rss,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external - before.external,
  };
  document.close();
  return { backend, timings: output, memory };
}

if (worker) {
  process.stdout.write(JSON.stringify(run(worker)));
} else {
  const hash = (filename) => createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  const sourceFiles = [
    "src/piece-tree.js",
    "src/document-core.js",
    "src/text-buffer.js",
    "src/tree-sitter-document.js",
    "benchmark/javascript-document-benchmark.js",
  ];
  const fingerprint = () =>
    Object.fromEntries(sourceFiles.map((file) => [file, hash(path.join(__dirname, "..", file))]));
  const sources = fingerprint();
  // The historical editor owns its oracle; the current editor has no native
  // text dependency, including in development and lint installations.
  const nativeRequire = require("node:module").createRequire(
    path.join(nativeSource, "package.json"),
  );
  const nativeBinaryPath = path.join(
    path.dirname(nativeRequire.resolve("@lumine-code/superstring")),
    "build",
    "Release",
    "superstring.node",
  );
  const nativeBinary = hash(nativeBinaryPath);
  const runs = [];
  const order = [
    "native",
    "javascript",
    "javascript",
    "native",
    "javascript",
    "native",
    "native",
    "javascript",
  ];
  for (const backend of order) {
    process.stderr.write(`Measuring ${backend} (${runs.length + 1}/${order.length})\n`);
    const env = { ...process.env };
    delete env.CI;
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        __filename,
        "--worker",
        backend,
        "--samples",
        String(samples),
        "--warmups",
        String(warmups),
        "--units",
        units.join(","),
        "--native-source",
        path.resolve(nativeSource),
      ],
      { encoding: "utf8", env, maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || `Benchmark child exited ${result.status}`);
    runs.push(JSON.parse(result.stdout));
    assert.deepEqual(fingerprint(), sources, "Benchmark sources changed during measurement");
    assert.equal(hash(nativeBinaryPath), nativeBinary);
  }
  const report = {
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    method:
      "Eight fresh processes in ABBA BAAB order. UTF-16 code units; two-byte source. GC and assertions outside timings. Existing TextBuffer including empty marker layer and history versus JS document kernel with history; no populated markers, display layers, file I/O or parsing. Snapshot retention measured separately from timings. p95 with nine samples is descriptive, not a tail-latency guarantee.",
    sources,
    nativeBinary,
    runs,
  };
  const output = option("output", null);
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  for (const backend of ["native", "javascript"]) {
    const selected = runs.filter((run) => run.backend === backend);
    for (const length of units) {
      const rows = selected.map((run) => run.timings.find((row) => row.units === length));
      console.log(
        JSON.stringify({
          backend,
          units: length,
          medians: Object.fromEntries(
            Object.keys(rows[0].metrics).map((name) => [
              name,
              quantile(
                rows.map((row) => row.metrics[name].median),
                0.5,
              ),
            ]),
          ),
        }),
      );
    }
    console.log(
      JSON.stringify({
        backend,
        memoryMedian: Object.fromEntries(
          ["rssDelta", "heapUsedDelta", "externalDelta"].map((name) => [
            name,
            quantile(
              selected.map((run) => run.memory[name]),
              0.5,
            ),
          ]),
        ),
      }),
    );
  }
}
