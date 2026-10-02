// Compare saved native builds in separate processes, using the same editor code:
// node --expose-gc benchmark/editor-superstring-benchmark.js --binding FILE.node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");
const { compileFunction } = require("node:vm");

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  assert(value && !value.startsWith("--"), `--${name} requires a value`);
  return value;
}

const source = path.resolve(option("source", path.join(__dirname, "..")));
const samples = Number(option("samples", 9));
const warmups = Number(option("warmups", 2));
const units = option("units", "1000000,8000000").split(",").map(Number);
const filter = option("filter") ? new RegExp(option("filter")) : null;
assert(Number.isInteger(samples) && samples >= 7, "--samples must be at least 7");
assert(Number.isInteger(warmups) && warmups >= 1, "--warmups must be at least 1");
assert(
  units.every((count) => Number.isInteger(count) && count > 0),
  "Invalid --units",
);

// Route every editor consumer (text storage, history, display layers, markers)
// to one native build before importing any editor module. Compare builds in
// separate processes to keep addon initialization and module caches independent.
const editorRequire = Module.createRequire(path.join(source, "package.json"));
const superstringEntry = editorRequire.resolve("@lumine-code/superstring");
const bindingOption = option("binding", process.env.LUMINE_SUPERSTRING_BENCH_BINDING);
let bindingPath;
if (bindingOption) {
  bindingPath = path.resolve(bindingOption);
  assert(!require.cache[superstringEntry], "superstring was loaded before the binding override");
  const binding = require(bindingPath);
  const nativeRequire = Module.createRequire(superstringEntry);
  const wrapperRequire = (request) => {
    if (
      request === "./build/Release/superstring.node" ||
      request === "./build/Debug/superstring.node"
    ) {
      return binding;
    }
    return nativeRequire(request);
  };
  const wrapper = new Module(superstringEntry);
  wrapper.filename = superstringEntry;
  const execute = compileFunction(
    fs.readFileSync(superstringEntry, "utf8"),
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: superstringEntry },
  );
  execute.call(
    wrapper.exports,
    wrapper.exports,
    wrapperRequire,
    wrapper,
    superstringEntry,
    path.dirname(superstringEntry),
  );
  wrapper.loaded = true;
  require.cache[superstringEntry] = wrapper;
} else {
  editorRequire("@lumine-code/superstring");
  bindingPath = Object.keys(require.cache).find(
    (filename) => filename.startsWith(path.dirname(superstringEntry)) && filename.endsWith(".node"),
  );
}

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
const duplicateText = flattened("banana bandana ban_ana bandaid band bNa\n".repeat(duplicateRows));
const uniqueWords = Array.from({ length: 7000 }, (_, i) => `candidate_word_${i}`);
const uniqueText = flattened(uniqueWords.join("\n"));
const uniqueWordSet = new Set(uniqueWords.slice(500, 6500));
const oversizedUnits = Math.max(...units);
const oversizedText = flattened("a".repeat(oversizedUnits) + "\nbanana");
const autocompleteCases = [
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
      binding: bindingPath,
      bindingSha256: bindingPath
        ? crypto.createHash("sha256").update(fs.readFileSync(bindingPath)).digest("hex")
        : undefined,
      gcBetweenSamples: typeof global.gc === "function",
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
      comparison: "One native build per process; alternate serial process runs to limit drift",
    },
    results: [],
    checksum: 0,
  };
  for (const testCase of cases) {
    const samplesMs = [];
    for (let sample = -warmups; sample < samples; sample++) {
      if (global.gc) global.gc();
      const state = testCase.setup();
      try {
        const started = performance.now();
        let result = testCase.run(state);
        if (result && typeof result.then === "function") result = await result;
        const elapsedMs = performance.now() - started;
        report.checksum = (report.checksum + testCase.verify(result)) % 0x100000000;
        if (sample >= 0) samplesMs.push(elapsedMs);
      } finally {
        state.destroy();
      }
    }
    report.results.push({ id: testCase.id, workload: testCase.workload, ...summarize(samplesMs) });
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
