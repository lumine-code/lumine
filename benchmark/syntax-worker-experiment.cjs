// Isolated ownership experiment, not an editor benchmark or production worker.
// node benchmark/syntax-worker-experiment.cjs INPUT GRAMMAR_JSON OUTPUT
// Source is read into memory only. Output contains timings and hashes.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { Parser, Language } = require("web-tree-sitter");
const { DocumentCore } = require("../src/document-core");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const yieldTask = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function actor(grammarPath) {
  await Parser.init();
  const grammar = require("@lumine-code/season").readFileSync(grammarPath);
  const language = await Language.load(
    fs.readFileSync(path.resolve(path.dirname(grammarPath), grammar.treeSitter.grammar)),
  );
  const parser = new Parser();
  parser.setLanguage(language);
  let document, tree;
  let edits = [];
  let spans = {};
  function measure(name, fn) {
    const start = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - start;
      const entry = (spans[name] ??= { count: 0, totalMs: 0, maxMs: 0 });
      entry.count++;
      entry.totalMs += ms;
      entry.maxMs = Math.max(entry.maxMs, ms);
    }
  }
  async function parse(previous = null) {
    const input = document.getTextSnapshot().reader(4096);
    let result;
    do {
      const deadline = performance.now() + 4;
      result = measure("parseSlice", () =>
        parser.parse(input, previous, {
          progressCallback: () => performance.now() >= deadline,
        }),
      );
      if (!result) {
        // Match the core's recovery safeguard when a sliced old error tree
        // would otherwise resume with different recovery semantics.
        if (previous?.rootNode.hasError) {
          parser.reset();
          previous = null;
        }
        await yieldTask();
      }
    } while (!result);
    return result;
  }
  return async function dispatch(message) {
    if (message.type === "open") {
      assert(!tree);
      spans = {};
      document = new DocumentCore(message.text);
      edits = [];
      tree = await parse();
    } else if (message.type === "edit") {
      assert.equal(message.beforeRevision, document.getTextRevision());
      const before = document.getTextSnapshot();
      const { start, end, text } = message;
      const startPosition = before.positionAt(start);
      const oldEndPosition = before.positionAt(end);
      document.transact((draft) => draft.replace(start, end, text));
      edits.push({
        startIndex: start,
        oldEndIndex: end,
        newEndIndex: start + text.length,
        startPosition,
        oldEndPosition,
        newEndPosition: document.getTextSnapshot().positionAt(start + text.length),
      });
      return { revision: document.getTextRevision() };
    } else if (message.type === "flush") {
      const edited = measure("copy", () => tree.copy());
      for (const edit of edits) edited.edit(edit);
      const next = await parse(edited);
      measure("getChangedRanges", () => edited.getChangedRanges(next));
      measure("delete", () => edited.delete());
      measure("delete", () => tree.delete());
      tree = next;
      edits = [];
    } else if (message.type === "validate") {
      assert.equal(edits.length, 0);
      const actual = hash(tree.rootNode.toString());
      // An independent, uninterrupted fresh parse is the correctness oracle.
      const referenceParser = new Parser();
      referenceParser.setLanguage(language);
      const reference = referenceParser.parse(document.getTextSnapshot().reader(4096));
      try {
        assert.equal(actual, hash(reference.rootNode.toString()));
        assert.equal(tree.rootNode.endIndex, document.getTextSnapshot().length);
        return {
          revision: document.getTextRevision(),
          textHash: hash(document.getTextSnapshot().toString()),
          syntaxHash: actual,
          hasError: tree.rootNode.hasError,
        };
      } finally {
        reference.delete();
        referenceParser.delete();
      }
    } else if (message.type === "close") {
      measure("delete", () => tree.delete());
      tree = null;
      document = null;
    } else if (message.type === "dispose") {
      assert(!tree);
      parser.delete();
    } else {
      throw new Error("Unknown operation");
    }
    return { spans: structuredClone(spans) };
  };
}

if (!isMainThread) {
  const ready = actor(workerData.grammar);
  let queue = ready;
  parentPort.on("message", ({ id, message }) => {
    queue = queue.then(async () => {
      try {
        parentPort.postMessage({ id, result: await (await ready)(message) });
      } catch (error) {
        parentPort.postMessage({ id, error: error.stack });
      }
    });
  });
} else {
  (async () => {
    const [inputPath, grammarArg, output] = process.argv.slice(2);
    assert(inputPath && grammarArg && output, "Expected INPUT GRAMMAR_JSON OUTPUT");
    const canonical = (file) => {
      const absolute = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
      return process.platform === "win32" ? absolute.toLowerCase() : absolute;
    };
    assert.notEqual(canonical(inputPath), canonical(output), "Output must not overwrite input");
    const grammar = path.resolve(grammarArg);
    const text = fs.readFileSync(inputPath, "utf8");
    const report = { inputHash: hash(text), units: text.length, runs: [] };
    for (const variant of ["inline", "worker", "worker", "inline"]) {
      const startup = performance.now();
      let dispatch, worker;
      if (variant === "inline") dispatch = await actor(grammar);
      else {
        worker = new Worker(__filename, { workerData: { grammar } });
        let id = 0;
        const pending = new Map();
        worker.on("message", ({ id, result, error }) => {
          const entry = pending.get(id);
          pending.delete(id);
          if (error) entry.reject(new Error(error));
          else entry.resolve(result);
        });
        worker.on("error", (error) => {
          for (const entry of pending.values()) entry.reject(error);
          pending.clear();
        });
        dispatch = (message) =>
          new Promise((resolve, reject) => {
            pending.set(++id, { resolve, reject });
            worker.postMessage({ id, message });
          });
      }
      const run = { variant, setupMs: performance.now() - startup, cases: [] };
      try {
        for (let cycle = 0; cycle < 2; cycle++) {
          const phases = {};
          let phase = "open";
          let last = performance.now();
          const timer = setInterval(() => {
            const now = performance.now();
            const entry = (phases[phase] ??= { samples: 0, maxHeartbeatDelayMs: 0 });
            entry.samples++;
            entry.maxHeartbeatDelayMs = Math.max(entry.maxHeartbeatDelayMs, now - last - 8);
            last = now;
          }, 8);
          const result = {
            cycle,
            phases,
            initialTextUnitsSent: text.length,
            deltaTextUnitsSent: 0,
          };
          try {
            const start = performance.now();
            await dispatch({ type: "open", text });
            await sleep(16);
            result.openMs = performance.now() - start;
            phase = "edits";
            const offset = cycle ? text.length : Math.floor(text.length / 2);
            const editStart = performance.now();
            for (let index = 0; index < 120; index++) {
              const inserted = index % 12 === 11 ? "\n" : "a";
              await dispatch({
                type: "edit",
                beforeRevision: index,
                start: offset + index,
                end: offset + index,
                text: inserted,
              });
              result.deltaTextUnitsSent += inserted.length;
              await sleep(1);
            }
            await dispatch({ type: "flush" });
            await sleep(16);
            result.editAndFlushMs = performance.now() - editStart;
            phase = "validation";
            result.validation = await dispatch({ type: "validate" });
            await sleep(16);
            const reference = report.runs[0]?.cases[cycle]?.validation;
            if (reference) assert.deepEqual(result.validation, reference);
            phase = "close";
            const closeStart = performance.now();
            result.native = await dispatch({ type: "close" });
            await sleep(16);
            result.closeMs = performance.now() - closeStart;
          } finally {
            clearInterval(timer);
          }
          run.cases.push(result);
        }
        await dispatch({ type: "dispose" });
      } finally {
        await worker?.terminate();
      }
      report.runs.push(run);
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(
        variant,
        run.cases.map((entry) => entry.phases),
      );
    }
    assert.equal(hash(fs.readFileSync(inputPath, "utf8")), report.inputHash);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
