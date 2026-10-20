// Measure JavaScript editor models in separate processes:
// npm run benchmark:text-model -- --samples 9 --warmups 2
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");

const args = process.argv.slice(2);
const valueOptions = new Set([
  "--source",
  "--samples",
  "--warmups",
  "--units",
  "--filter",
  "--output",
]);
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--gc-after-setup") continue;
  assert(valueOptions.has(args[index]), `Unknown option: ${args[index]}`);
  assert(args[index + 1] && !args[index + 1].startsWith("--"), `${args[index]} requires a value`);
  index++;
}
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  assert(value && !value.startsWith("--"), `--${name} requires a value`);
  return value;
}

const source = path.resolve(option("source", path.join(__dirname, "..")));
assert(
  fs.existsSync(path.join(source, "src", "text-model.js")),
  "The benchmark requires a JavaScript text-model source",
);
const samples = Number(option("samples", 9));
const warmups = Number(option("warmups", 2));
const units = option("units", "1000000,8000000").split(",").map(Number);
const filter = option("filter") ? new RegExp(option("filter")) : null;
const gcAfterSetup = args.includes("--gc-after-setup");
assert(Number.isInteger(samples) && samples >= 7, "--samples must be at least 7");
assert(Number.isInteger(warmups) && warmups >= 1, "--warmups must be at least 1");
assert(
  units.every((count) => Number.isInteger(count) && count > 0),
  "Invalid --units",
);

const editorRequire = Module.createRequire(path.join(source, "package.json"));

const TextBuffer = editorRequire(path.join(source, "src", "text-buffer"));
const TextEditor = editorRequire(path.join(source, "src", "text-editor"));
const oldIdleCallback = globalThis.requestIdleCallback;
const oldCancelIdleCallback = globalThis.cancelIdleCallback;
// Standalone model measurements explicitly drive spatial indexing, while idle
// work is held outside the measured edit. No DOM component is constructed.
globalThis.requestIdleCallback = () => 1;
globalThis.cancelIdleCallback = () => {};
TextEditor.setClipboard({ readWithMetadata: () => ({ text: "" }) });

const cases = [];
function add(id, workload, setup, run, verify) {
  if (!filter || filter.test(id)) cases.push({ id, workload, setup, run, verify });
}

function flattened(text) {
  return Buffer.from(text, "utf16le").toString("utf16le");
}

function extent(text) {
  const lastNewline = text.lastIndexOf("\n");
  return [text.split("\n").length - 1, text.length - lastNewline - 1];
}

function createState(text, withEditor) {
  const buffer = new TextBuffer({ text });
  const state = { buffer, editor: null, changes: 0 };
  const subscription = buffer.onDidChangeText(() => state.changes++);
  if (withEditor) {
    state.editor = new TextEditor({
      buffer,
      autoHeight: false,
      autoWidth: false,
      autoIndent: false,
      autoIndentOnPaste: false,
      softWrapped: false,
      maxScreenLineLength: 500,
      undoGroupingInterval: 0,
    });
    // Populate the spatial index before editing, as for an already-open file.
    state.editor.getScreenLineCount();
  }
  state.destroy = () => {
    subscription.dispose();
    state.editor?.destroy();
    if (!buffer.isDestroyed()) buffer.destroy();
  };
  return state;
}

// Measure the public TextBuffer facade with and without retained parser snapshots.
for (const size of [1000000, 8000000, 32000000, 128000000]) {
  const line = 'const value = "text 終"; // sample\n';
  let input;
  const getInput = () =>
    (input ??= flattened(line.repeat(Math.ceil(size / line.length)).slice(0, size)));
  const setup = () => createState(getInput(), false);
  add(
    `document/create/${size}`,
    { utf16Units: size, operations: 1 },
    () => ({
      text: getInput(),
      destroy() {
        this.buffer?.destroy();
      },
    }),
    (state) => {
      state.buffer = new TextBuffer({ text: state.text });
      return state;
    },
    (state) => {
      assert.equal(state.buffer.getLength(), size);
      assert.equal(state.buffer.getText(), input);
      return size;
    },
  );
  for (const snapshot of [false, true]) {
    add(
      `document/${snapshot ? "edit-snapshot" : "edit"}/${size}`,
      { utf16Units: size, operations: 1, snapshot },
      setup,
      (state) => {
        state.buffer.setTextInRange(
          [
            [0, 0],
            [0, 1],
          ],
          "X",
        );
        if (snapshot) state.snapshot = state.buffer.getTextSnapshot();
        return state;
      },
      (state) => {
        assert.equal(
          state.buffer.getTextInRange([
            [0, 0],
            [0, 5],
          ]),
          "Xonst",
        );
        assert.equal(state.buffer.getLength(), size);
        assert.equal(state.changes, 1);
        if (snapshot) assert.equal(state.snapshot.length, size);
        state.buffer.undo();
        assert.equal(state.buffer.getText(), input);
        return size;
      },
    );
  }
}

add(
  "document/fragmented-5000-edits",
  { utf16Units: 8000000, setupEdits: 5000, operations: 100 },
  () => {
    const state = createState("0123456789abcdef\n".repeat(470589).slice(0, 8000000), false);
    for (let i = 0; i < 5000; i++) {
      const row = (i * 7919) % 470000;
      state.buffer.setTextInRange(
        [
          [row, 0],
          [row, 1],
        ],
        "X",
      );
    }
    state.buffer.clearUndoStack();
    state.before = state.buffer.getText();
    state.changes = 0;
    return state;
  },
  (state) => {
    for (let i = 0; i < 100; i++) {
      state.buffer.insert([0, 0], " ");
      state.buffer.undo();
    }
    return state;
  },
  (state) => {
    assert.equal(state.buffer.getText(), state.before);
    assert.equal(state.changes, 200);
    return state.buffer.getLength();
  },
);

{
  const line = "line value 終\n";
  const text = line.repeat(Math.ceil(8000000 / line.length)).slice(0, 8000000);
  add(
    "document/read-lines/8000000",
    {
      utf16Units: text.length,
      operations: 1,
      read: "snapshot line iterator",
    },
    () => createState(text, false),
    (state) => {
      state.total = 0;
      const snapshot = state.buffer.getTextSnapshot();
      for (const value of snapshot.lines()) state.total += value.length;
      return state;
    },
    (state) => {
      assert.equal(state.total, text.length - Math.floor(text.length / line.length));
      return state.total;
    },
  );
  const edits = Array.from({ length: 1000 }, (_, i) => ({
    range: [
      [i * 500, 0],
      [i * 500, 4],
    ],
    text: "changed",
  }));
  add(
    "document/batch-1000/8000000",
    { utf16Units: text.length, operations: 1000, surface: "indexed editor model" },
    () => createState(text, true),
    (state) => {
      state.buffer.setTextInIndependentRanges(edits);
      return state;
    },
    (state) => {
      assert.equal(state.changes, 1);
      assert.equal(state.buffer.lineForRow(0), "changed value 終");
      assert.equal(state.buffer.lineForRow(499500), "changed value 終");
      state.editor.undo();
      assert.equal(state.buffer.getText(), text);
      return state.buffer.getLength();
    },
  );
}

for (const size of [1000000, 8000000]) {
  const line = "first needle last\n";
  const text = line.repeat(Math.ceil(size / line.length)).slice(0, size);
  add(
    `search/regex/${size}`,
    { utf16Units: size, operations: 1 },
    () => createState(text, false),
    (state) => state.buffer.findAll(/needle/g),
    (ranges) => {
      assert.equal(ranges.length, Math.floor((size - 12) / line.length) + 1);
      assert.deepEqual(ranges[0], { start: { row: 0, column: 6 }, end: { row: 0, column: 12 } });
      return ranges.length;
    },
  );
}

add(
  "document/retain-21-snapshots/8000000",
  { utf16Units: 8000000, operations: 20, retainedSnapshots: 21 },
  () => {
    const state = createState("a終".repeat(4000000), false);
    state.snapshots = [state.buffer.getTextSnapshot()];
    if (global.gc) global.gc();
    state.memoryBefore = process.memoryUsage();
    return state;
  },
  (state) => {
    for (let i = 0; i < 20; i++) {
      state.buffer.setTextInRange(
        [
          [0, i],
          [0, i + 1],
        ],
        "X",
      );
      state.snapshots.push(state.buffer.getTextSnapshot());
    }
    if (global.gc) global.gc();
    const after = process.memoryUsage();
    state.retainedMemory = Object.fromEntries(
      Object.keys(after).map((key) => [key, after[key] - state.memoryBefore[key]]),
    );
    return state;
  },
  (state) => {
    for (let i = 0; i <= 20; i++) {
      assert.equal(state.snapshots[i].length, 8000000);
      assert.equal(state.snapshots[i].slice(0, i), "X".repeat(i));
    }
    return state.snapshots.length;
  },
);

const prefix = "prefix\n";
const suffix = "\nsuffix";
for (const unitCount of units) {
  for (const shape of ["flat", "multiline"]) {
    const fragment = shape === "flat" ? "n" : "const next_value = source_value; // benchmark\n";
    const oldFragment = shape === "flat" ? "o" : "const old_value = previous_value; // benchmark\n";
    const payload = flattened(
      fragment.repeat(Math.ceil(unitCount / fragment.length)).slice(0, unitCount),
    );
    const oldPayload = flattened(
      oldFragment.repeat(Math.ceil(unitCount / oldFragment.length)).slice(0, unitCount),
    );
    const payloadExtent = extent(payload);
    const oldExtent = extent(oldPayload);
    const insertedEnd = [1 + payloadExtent[0], payloadExtent[1]];
    const afterText = flattened(prefix + payload + suffix);
    const workload = {
      utf16Units: payload.length,
      shape,
      payloadRows: payloadExtent[0] + 1,
      operations: 1,
    };

    for (const surface of ["buffer", "editor-model"]) {
      for (const operation of ["insert", "replace", "undo", "redo"]) {
        const replacing = operation === "replace";
        const beforeText = replacing ? flattened(prefix + oldPayload + suffix) : prefix + suffix;
        const selection = [[1, 0], replacing ? [1 + oldExtent[0], oldExtent[1]] : [1, 0]];
        const paste = (state) => {
          if (state.editor) {
            return state.editor.pasteText({
              clipboard: { readWithMetadata: () => ({ text: payload }) },
              autoIndent: false,
            });
          }
          return state.buffer.setTextInRange(selection, payload);
        };
        add(
          `${surface}/${operation}/${shape}/${unitCount} UTF-16 units`,
          workload,
          () => {
            const state = createState(beforeText, surface === "editor-model");
            if (state.editor) state.editor.setSelectedBufferRange(selection);
            if (operation === "undo" || operation === "redo") {
              paste(state);
              assert.equal(state.buffer.getText(), afterText);
              if (operation === "redo") {
                if (state.editor) state.editor.undo();
                else assert.equal(state.buffer.undo(), true);
                assert.equal(state.buffer.getText(), beforeText);
              }
            }
            state.changes = 0;
            return state;
          },
          (state) => {
            if (operation === "undo" || operation === "redo") {
              if (state.editor) state.editor[operation]();
              else state.historyResult = state.buffer[operation]();
            } else paste(state);
            return state;
          },
          (state) => {
            assert.equal(state.buffer.getText(), operation === "undo" ? beforeText : afterText);
            assert.equal(state.changes, 1);
            if (!state.editor && (operation === "undo" || operation === "redo")) {
              assert.equal(state.historyResult, true);
            }
            if (state.editor) {
              const expectedSelection =
                operation === "undo"
                  ? [
                      [1, 0],
                      [1, 0],
                    ]
                  : [insertedEnd, insertedEnd];
              assert.deepEqual(
                state.editor.getSelectedBufferRange().serialize(),
                expectedSelection,
              );
            }
            return state.buffer.getLength();
          },
        );
      }
    }
  }
}

const duplicateRows = 6000;
const singleLineWords = "banana bandana ban_ana bandaid band bNa ";
const duplicateText = flattened("banana bandana ban_ana bandaid band bNa\n".repeat(duplicateRows));
const uniqueWords = Array.from({ length: 7000 }, (_, i) => `candidate_word_${i}`);
const uniqueText = flattened(uniqueWords.join("\n"));
const uniqueWordSet = new Set(uniqueWords.slice(500, 6500));
const oversizedUnits = Math.max(...units);
const oversizedText = flattened("a".repeat(oversizedUnits) + "\nbanana");
const autocompleteCases = [
  {
    id: "single-line-words",
    text: flattened(singleLineWords.repeat(duplicateRows)),
    query: "bna",
    verify(result) {
      assert.deepEqual(
        result.map((match) => match.word),
        ["bNa", "ban_ana", "banana", "bandana", "bandaid"],
      );
      for (const match of result) {
        assert.equal(match.positions.length, duplicateRows);
        assert.deepEqual(match.positions.at(-1), {
          row: 0,
          column:
            (duplicateRows - 1) * singleLineWords.length + singleLineWords.indexOf(match.word),
        });
      }
      return result.reduce((sum, match) => sum + match.positions.length, 0);
    },
  },
  {
    id: "duplicate-words",
    text: duplicateText,
    query: "bna",
    verify(result) {
      assert.deepEqual(
        result.map((match) => match.word),
        ["bNa", "ban_ana", "banana", "bandana", "bandaid"],
      );
      for (const match of result) assert.equal(match.positions.length, duplicateRows);
      return result.reduce((sum, match) => sum + match.positions.length, 0);
    },
  },
  {
    id: "unique-words-max20",
    text: uniqueText,
    query: "caw",
    range: { start: { row: 500, column: 0 }, end: { row: 6500, column: 0 } },
    verify(result) {
      assert.equal(result.length, 20);
      for (const match of result) {
        assert(uniqueWordSet.has(match.word));
        assert.equal(match.positions.length, 1);
      }
      return result.length;
    },
  },
  {
    id: "oversized-word",
    text: oversizedText,
    query: "bna",
    verify(result) {
      assert.equal(result.length, 1);
      assert.equal(result[0].word, "banana");
      assert.deepEqual(result[0].positions, [{ row: 1, column: 0 }]);
      return result[0].word.length;
    },
  },
];
for (const testCase of autocompleteCases) {
  add(
    `autocomplete/${testCase.id}`,
    {
      utf16Units: testCase.text.length,
      maxCount: 20,
      operations: 1,
      rowWindow: testCase.range ?? "whole buffer",
    },
    () => createState(testCase.text, false),
    (state) =>
      state.buffer.findWordsWithSubsequenceInRange(
        testCase.query,
        "_",
        20,
        testCase.range ?? state.buffer.getRange(),
      ),
    testCase.verify,
  );
}

function summarize(samplesMs) {
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    samplesMs,
  };
}

async function main() {
  assert(cases.length > 0, "No cases matched --filter");
  const report = {
    environment: {
      node: process.version,
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      source,
      documentBackend: "javascript",
      gcBetweenSamples: typeof global.gc === "function",
      gcAfterSetup: gcAfterSetup && typeof global.gc === "function",
    },
    methodology: {
      samples,
      warmups,
      unit: "ms per operation",
      freshSetupPerSample: true,
      setupTimed: false,
      grammar: "plain text / NullLanguageMode",
      autoIndent: false,
      spatialIndexPopulatedBeforeEdit: true,
      includes:
        "TextBuffer transactions/history and TextEditor model selections/display-layer notifications",
      excludes:
        "DOM updates, rendering, idle indexing, native clipboard transfer, paste providers, syntax parsing",
      comparison: "One editor source snapshot per process; alternate serial runs to limit drift",
      yieldsBetweenSamples: true,
    },
    sourceHashes: Object.fromEntries(
      [
        "text-buffer.js",
        "default-history-provider.js",
        "helpers.js",
        "text-editor.js",
        "display-layer.js",
        "document-core.js",
        "piece-tree.js",
        "change-tree.js",
        "text-store.js",
        "text-store-search.js",
        "text-patch.js",
        "marker-index.js",
        "text-model.js",
      ]
        .filter((file) => fs.existsSync(path.join(source, "src", file)))
        .map((file) => [
          file,
          crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(source, "src", file)))
            .digest("hex"),
        ]),
    ),
    benchmarkSha256: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
    results: [],
    checksum: 0,
  };
  for (const testCase of cases) {
    const samplesMs = [];
    const timerDelays = [];
    const retainedMemory = [];
    for (let sample = -warmups; sample < samples; sample++) {
      if (global.gc) global.gc();
      const state = testCase.setup();
      try {
        if (gcAfterSetup && global.gc) global.gc();
        const started = performance.now();
        let timerDelay;
        const timer = new Promise((resolve) =>
          setTimeout(() => {
            timerDelay = performance.now() - started;
            resolve();
          }, 0),
        );
        let result = testCase.run(state);
        if (result && typeof result.then === "function") result = await result;
        const elapsedMs = performance.now() - started;
        await timer;
        report.checksum = (report.checksum + testCase.verify(result)) % 0x100000000;
        if (sample >= 0) {
          samplesMs.push(elapsedMs);
          timerDelays.push(timerDelay);
          if (state.retainedMemory) retainedMemory.push(state.retainedMemory);
        }
      } finally {
        state.destroy();
      }
      // Let pending debounce timers release destroyed fixture buffers. A fully
      // synchronous sweep otherwise retains their change strings until every
      // case finishes, even with explicit GC, and can exhaust the baseline heap.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    report.results.push({
      id: testCase.id,
      workload: testCase.workload,
      ...summarize(samplesMs),
      timerDelay: summarize(timerDelays),
      ...(retainedMemory.length
        ? {
            retainedMemory,
            memoryNote:
              "GC-delimited process deltas with 21 source snapshots retained; includes forced GC in this case's elapsed time. RSS is allocator-dependent.",
          }
        : {}),
    });
  }
  const json = JSON.stringify(report, null, 2);
  const output = option("output");
  if (output) fs.writeFileSync(path.resolve(output), json);
  console.log(json);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (oldIdleCallback) globalThis.requestIdleCallback = oldIdleCallback;
    else delete globalThis.requestIdleCallback;
    if (oldCancelIdleCallback) globalThis.cancelIdleCallback = oldCancelIdleCallback;
    else delete globalThis.cancelIdleCallback;
  });
