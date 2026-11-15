const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { definitions, fixture, hash, burstStates } = require("./helpers/multicursor-input-fixture");

// LUMINE_SYNTAX_EXECUTION=worker npm run test:only -- benchmark/multicursor-input-benchmark-spec.js
// Prefer script/benchmark-multicursor-input.js for an isolated profile and revision checks.
// LUMINE_MULTICURSOR_INPUT_BENCH_CONFIG accepts {caseIds, samples, warmups,
// operationTimeoutMs, sourcePath, sourceRevision, output}. Case ids are public
// fixtures such as python-500-chain-128 and ipython-500-independent-128.
// First Enter, publication, command completion and parent settlement stay separate.
const config = JSON.parse(process.env.LUMINE_MULTICURSOR_INPUT_BENCH_CONFIG || "{}");
const defaultCases = ["python", "ipython"].flatMap((language) => [
  `${language}-50-chain-1`,
  `${language}-500-chain-128`,
  `${language}-500-independent-128`,
  `${language}-500-noop-128`,
]);
const caseIds = config.caseIds ?? defaultCases;
const samples = config.samples ?? 3;
const warmups = config.warmups ?? 1;
const operationTimeoutMs = config.operationTimeoutMs ?? 30000;
const inputMode = config.mode ?? "newline";
const cycles = config.cycles ?? 1;
const intervalMs = config.intervalMs ?? 0;
assert.ok(["newline", "burst"].includes(inputMode));
const sourcePath = path.resolve(
  config.sourcePath ?? process.env.LUMINE_RESOURCE_PATH ?? path.join(__dirname, ".."),
);
for (const [name, value, minimum] of [
  ["samples", samples, 1],
  ["warmups", warmups, 0],
  ["operationTimeoutMs", operationTimeoutMs, 1],
  ["cycles", cycles, 1],
  ["intervalMs", intervalMs, 0],
])
  assert.ok(Number.isSafeInteger(value) && value >= minimum, `Invalid ${name}`);
assert.ok(Array.isArray(caseIds) && caseIds.length > 0);
for (const id of caseIds)
  assert.ok(
    definitions.some((definition) => definition.id === id),
    `Unknown fixture ${id}`,
  );

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
    min: sorted[0],
    samples: values,
  };
};
const fileHash = (file) => (fs.existsSync(file) ? hash(fs.readFileSync(file)) : null);
const positions = (editor) => editor.getCursorBufferPositions().map((point) => point.serialize());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measureInput(editor, input, plan, probe, trial) {
  const buffer = editor.getBuffer();
  const dispatch = require(path.join(sourcePath, "src/text-editor-input-queue.js"));
  const controller = new AbortController();
  const sample = { trial, actions: [] };
  const publications = [];
  const frames = [];
  let frameHandle, lastFrame, timer, started;
  const frame = (timestamp) => {
    if (lastFrame != null) frames.push(timestamp - lastFrame);
    lastFrame = timestamp;
    frameHandle = requestAnimationFrame(frame);
  };
  frameHandle = requestAnimationFrame(frame);
  const subscription = buffer.onDidApplyChanges(() => {
    publications.push({
      ms: performance.now() - started,
      // Persistent snapshots are O(1); validate their contents outside timings.
      source: buffer.getTextSnapshot(),
    });
  });
  try {
    if (probe)
      await probe.arm({
        revision: trial + warmups + 1,
        expectedText: plan.final.text,
        expectedPositions: plan.final.positions,
        minimumPublications: plan.states.length,
      });
    started = performance.now();
    probe?.start();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${input.id} trial ${trial} timed out`));
      }, operationTimeoutMs);
    });
    const tasks = [];
    for (let index = 0; index < plan.states.length; index++) {
      const state = plan.states[index];
      const scheduled = index * intervalMs;
      if (scheduled > 0) await wait(Math.max(0, started + scheduled - performance.now()));
      const action = {
        operation: state.operation,
        scheduled,
        enqueued: performance.now() - started,
        queuedBehindInput: Boolean(dispatch.pendingFor(editor)),
      };
      sample.actions.push(action);
      const task = dispatch(editor, () => {
        action.invoked = performance.now() - started;
        if (state.operation === "enter") return editor.insertNewline({ signal: controller.signal });
        if (state.operation === "text") return editor.insertText(plan.typingText);
        return editor.backspace();
      });
      if (index === 0)
        assert.equal(typeof task?.then, "function", "Worker Enter must return a promise");
      const completed = Promise.resolve(task).then((outcome) => {
        action.complete = performance.now() - started;
        action.cancelled = outcome === false;
        return outcome;
      });
      // Paced arrivals may still be enqueuing when a command rejects.
      completed.catch(() => {});
      tasks.push(completed);
    }
    sample.commandReturn = performance.now() - started;
    const outcomes = await Promise.race([Promise.all(tasks), timeout]);
    sample.complete = performance.now() - started;
    sample.cancelled = outcomes.some((outcome) => outcome === false);
    const settlement = editor.whenGrammarSettled().then(() => {
      sample.grammarSettled = performance.now() - started;
    });
    const capture = probe?.waitForCapture(operationTimeoutMs).then((frame) => {
      sample.frame = frame;
      sample.invocationToObservedFrame = frame.capture.invocationToObservedFrameMs;
      assert.ok(
        Number.isFinite(sample.invocationToObservedFrame) && sample.invocationToObservedFrame >= 0,
      );
    });
    await Promise.race([Promise.all([settlement, capture]), timeout]);
  } catch (error) {
    error.inputSample = {
      ...sample,
      publications: publications.map(({ ms }) => ms),
      positions: positions(editor),
      finalTextMatches: editor.getText() === plan.final.text,
      probe: probe?.snapshot(),
    };
    throw error;
  } finally {
    clearTimeout(timer);
    cancelAnimationFrame(frameHandle);
    subscription.dispose();
  }
  sample.published = publications[0]?.ms ?? null;
  sample.finalPublished = publications.at(-1)?.ms ?? null;
  sample.publications = publications.length;
  sample.frameIntervals = frames;
  return { sample, publications };
}
const sourceFingerprint = () =>
  Object.fromEntries(
    [
      "src/syntax-worker-host.js",
      "src/syntax-worker-service.js",
      "src/tree-sitter-input-snapshot.js",
      "src/tree-sitter-input-node.js",
      "src/tree-sitter-input-policy.js",
      "src/tree-sitter-input-ownership.js",
      "src/tree-sitter-input-indentation.js",
      "src/tree-sitter-indent-resolver.js",
      "src/tree-sitter-indentation-stream.js",
      "src/tree-sitter-parser.js",
      "src/tree-sitter-tree.js",
      "src/tree-sitter-syntax-snapshot.js",
      "src/tree-sitter-language-mode.js",
      "src/tree-sitter-grammar.js",
      "src/tree-sitter-worker-language-mode.js",
      "src/syntax-worker-protocol.js",
      "src/text-editor.js",
      "src/text-editor-input-queue.js",
      "src/text-editor-prepared-indent.js",
      "package.json",
      "package-lock.json",
    ].map((file) => [file, fileHash(path.join(sourcePath, file))]),
  );
function grammarFingerprint() {
  const result = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:json|cson|scm|wasm|js)$/.test(entry.name)) result[file] = fileHash(file);
    }
  };
  for (const scope of ["source.python", "source.python.ipy"]) {
    const grammarFile = fs.realpathSync(lumine.grammars.grammarForScopeName(scope).grammarFilePath);
    const root = path.dirname(path.dirname(grammarFile));
    result[path.join(root, "package.json")] = fileHash(path.join(root, "package.json"));
    for (const name of ["grammars", "lib", "settings"])
      if (fs.existsSync(path.join(root, name))) visit(path.join(root, name));
  }
  return result;
}

async function runBenchmark() {
  if (typeof jasmine !== "undefined") jasmine.useRealClock();
  assert.equal(
    lumine.grammars.syntaxExecution,
    "worker",
    "Set LUMINE_SYNTAX_EXECUTION=worker; the spec runner defaults to inline",
  );
  const sourceBefore = sourceFingerprint();
  for (const name of ["language-python", "language-ipython"])
    await lumine.packages.activatePackage(name);
  const grammarBefore = grammarFingerprint();
  const workspace = lumine.workspace.getElement();
  workspace.style.width = "1000px";
  workspace.style.height = "800px";
  if (typeof jasmine !== "undefined") jasmine.attachToDOM(workspace);
  else assert.ok(workspace.isConnected, "Visible application workspace must be attached");
  const report = {
    schema: 2,
    sourcePath,
    sourceRevision: config.sourceRevision ?? null,
    backend: {
      requested: process.env.LUMINE_SYNTAX_EXECUTION,
      registry: lumine.grammars.syntaxExecution,
    },
    runtime: process.versions,
    samples,
    warmups,
    inputMode,
    cycles,
    intervalMs,
    capture: Boolean(config.capture),
    operationTimeoutMs,
    startedAt: new Date().toISOString(),
    sourceFingerprint: sourceBefore,
    grammarFingerprint: grammarBefore,
    fixtureGeneratorSha256: fileHash(require.resolve("./helpers/multicursor-input-fixture")),
    benchmarkSha256: fileHash(__filename),
    harnessFingerprint: Object.fromEntries(
      [
        "script/benchmark-multicursor-input.js",
        "benchmark/multicursor-input-main.js",
        "benchmark/helpers/input-frame-probe.js",
        "benchmark/presentation-observer.js",
      ].map((file) => [file, fileHash(path.join(__dirname, "..", file))]),
    ),
    results: [],
    failures: [],
    complete: false,
    timingDefinition: {
      first: "First Enter after initial grammar settlement; not app startup or cold OS cache",
      published: "insertNewline invocation to first onDidApplyChanges",
      complete: "insertNewline invocation to command promise resolution",
      grammarSettled: "insertNewline invocation to authoritative parent grammar settlement",
      queue: "UI input dispatcher; arrivals never await preceding command or syntax settlement",
      finalPublished: "First input invocation to final operation publication in the burst",
      frame:
        "First input invocation to subscription-observed composited frame containing the final DOM acknowledgement; excludes physical monitor scanout and includes capture delay",
      history:
        "Exact undo, redo, undo checks outside the timed operation; sustained cycles include this work",
    },
  };
  const output = config.output ?? process.env.LUMINE_MULTICURSOR_INPUT_BENCH_OUTPUT;
  const save = () => {
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  };
  save();
  for (const id of caseIds) {
    const input = fixture(definitions.find((definition) => definition.id === id));
    const plan =
      inputMode === "burst"
        ? burstStates(input, cycles)
        : {
            states: [
              { operation: "enter", text: input.expected, positions: input.expectedPositions },
            ],
            final: { text: input.expected, positions: input.expectedPositions },
            undo: [{ text: input.source, positions: input.points }],
          };
    const result = {
      id,
      fixture: input.metadata,
      first: [],
      measured: [],
      events: [],
      checks: { exactText: 0, cursors: 0, publications: 0, undo: 0, redo: 0 },
    };
    report.results.push(result);
    const editor = await lumine.workspace.open();
    let events, closed, probe;
    try {
      editor.setText(input.source);
      assert.equal(
        lumine.grammars.assignLanguageMode(editor.getBuffer(), input.metadata.grammarScope),
        true,
      );
      if (input.rootRanges)
        lumine.grammars.setRootLanguageRanges(editor.getBuffer(), input.rootRanges);
      const initialMode = editor.getBuffer().getLanguageMode();
      events = initialMode.service?.client?.onDidReceiveEvent((event) => {
        if (event.failure || /fail|recycle|unavailable/.test(event.event))
          result.events.push({ at: new Date().toISOString(), event });
      });
      closed = initialMode.service?.client?.onDidClose((error) =>
        result.events.push({
          closed: { name: error.name, code: error.code, message: error.message },
        }),
      );
      await editor.whenGrammarSettled();
      editor.update({
        autoIndent: true,
        tabLength: 4,
        softTabs: true,
        undoGroupingInterval: 0,
      });
      const mode = editor.getBuffer().getLanguageMode();
      assert.equal(
        mode.asynchronousSyntax,
        true,
        `Actual worker unavailable: ${JSON.stringify(mode.syntaxAvailability)}`,
      );
      assert.equal(mode.constructor.name, "TreeSitterWorkerLanguageMode");
      const module = Object.values(require.cache).find(
        (entry) => entry.exports === mode.constructor,
      )?.filename;
      assert.ok(module, "Actual language mode module provenance");
      assert.equal(
        fs.realpathSync(module),
        fs.realpathSync(path.join(sourcePath, "src/tree-sitter-worker-language-mode.js")),
      );
      result.backend = {
        mode: mode.constructor.name,
        asynchronousSyntax: mode.asynchronousSyntax,
        module,
        grammarPath: fs.realpathSync(mode.grammar.grammarFilePath),
      };
      if (config.capture) {
        const pane = lumine.workspace.paneForItem(editor);
        assert.ok(pane, "Measured editor must belong to a pane");
        pane.activate();
        pane.activateItem(editor);
        probe = await require("./helpers/input-frame-probe").attach(editor);
      }
      for (let trial = -warmups; trial < samples; trial++) {
        assert.equal(editor.getText(), input.source);
        editor.setSelectedBufferRanges(input.points.map((point) => [point, point]));
        const beforeSelections = editor.getSelectedBufferRanges().map((range) => range.serialize());
        const buffer = editor.getBuffer();
        buffer.clearUndoStack();
        if (probe) {
          editor.scrollToCursorPosition({ mode: "center" });
          editor.getElement().focus();
        }
        editor.getElement().component.updateSync();
        await new Promise(requestAnimationFrame);
        if (probe) {
          const rect = editor.getElement().getBoundingClientRect();
          assert.ok(
            rect.width > 0 && rect.height > 0,
            "Measured editor must be visible before starting the frame sample",
          );
        }
        const { sample, publications } = await measureInput(editor, input, plan, probe, trial);
        (trial < 0 ? result.first : result.measured).push(sample);
        const currentMode = buffer.getLanguageMode();
        result.lastOutcome = {
          trial,
          cancelled: sample.cancelled,
          publications: publications.length,
          actualEqualsSource: editor.getText() === input.source,
          currentMode: currentMode.constructor.name,
          failure: currentMode.syntaxAvailability?.failure ?? mode.session?.failure ?? null,
        };
        save();
        assert.equal(sample.cancelled, false, `${id} input unexpectedly cancelled`);
        assert.ok(editor.getText() === plan.final.text, `${id} exact final text`);
        result.checks.exactText++;
        assert.deepEqual(positions(editor), plan.final.positions);
        result.checks.cursors++;
        assert.equal(publications.length, plan.states.length);
        for (let index = 0; index < publications.length; index++)
          assert.equal(
            publications[index].source.toString(),
            plan.states[index].text,
            `${id} publication ${index} exact text`,
          );
        sample.publicationTrace = publications.map((publication, index) => ({
          ms: publication.ms,
          operation: plan.states[index].operation,
          hash: hash(publication.source.toString()),
          expectedHash: hash(plan.states[index].text),
        }));
        result.checks.publications++;
        for (const state of plan.undo) {
          await editor.undo();
          assert.equal(editor.getText(), state.text);
          assert.deepEqual(positions(editor), state.positions);
          result.checks.undo++;
        }
        assert.deepEqual(
          editor.getSelectedBufferRanges().map((range) => range.serialize()),
          beforeSelections,
        );
        for (const state of plan.states) {
          await editor.redo();
          assert.equal(editor.getText(), state.text);
          assert.deepEqual(positions(editor), state.positions);
          result.checks.redo++;
        }
        for (const state of plan.undo) {
          await editor.undo();
          assert.equal(editor.getText(), state.text);
        }
        await editor.whenGrammarSettled();
        assert.equal(editor.getText(), input.source);
        save();
      }
      result.metrics = Object.fromEntries(
        [
          "commandReturn",
          "published",
          "finalPublished",
          "complete",
          "grammarSettled",
          ...(probe ? ["invocationToObservedFrame"] : []),
        ].map((field) => [field, stats(result.measured.map((sample) => sample[field]))]),
      );
      result.successful = true;
      result.queue = {
        wait: stats(
          result.measured.flatMap((sample) =>
            sample.actions.map((action) => action.invoked - action.enqueued),
          ),
        ),
        latency: stats(
          result.measured.flatMap((sample) =>
            sample.actions.map((action) => action.complete - action.enqueued),
          ),
        ),
        arrivalDelay: stats(
          result.measured.flatMap((sample) =>
            sample.actions.map((action) => action.enqueued - action.scheduled),
          ),
        ),
      };
      if (probe) result.capture = probe.metadata;
      console.log(
        `MULTICURSOR ${id} first=${result.first[0]?.published.toFixed(1) ?? "none"} publish=${result.metrics.published.median.toFixed(1)}/${result.metrics.published.max.toFixed(1)} complete=${result.metrics.complete.median.toFixed(1)} settle=${result.metrics.grammarSettled.median.toFixed(1)} ms`,
      );
    } catch (error) {
      result.successful = false;
      result.failure = {
        name: error.name,
        message: error.message,
        code: error.code,
        reason: error.reason,
        inputSample: error.inputSample,
      };
      report.failures.push({ id, ...result.failure });
    } finally {
      await probe?.dispose();
      events?.dispose();
      closed?.dispose();
      editor.destroy();
      save();
    }
  }
  assert.deepEqual(sourceFingerprint(), sourceBefore, "Runtime source changed during measurement");
  assert.deepEqual(
    grammarFingerprint(),
    grammarBefore,
    "Grammar source changed during measurement",
  );
  report.complete = true;
  report.successful = report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  save();
  if (!output) console.log(JSON.stringify(report));
  assert.equal(
    report.failures.length,
    0,
    "Benchmark has failed correctness/backend/resource checks; inspect its report",
  );
}
if (config.captureStandalone) module.exports = runBenchmark;
else
  describe("Multicursor input worker performance", () => {
    it(
      "checks atomic output and history while measuring publication separately from settlement",
      runBenchmark,
      30 * 60 * 1000,
    );
  });
