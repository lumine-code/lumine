const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { definitions, fixture, hash } = require("./helpers/multicursor-input-fixture");

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
const sourcePath = path.resolve(
  config.sourcePath ?? process.env.LUMINE_RESOURCE_PATH ?? path.join(__dirname, ".."),
);
for (const [name, value, minimum] of [
  ["samples", samples, 1],
  ["warmups", warmups, 0],
  ["operationTimeoutMs", operationTimeoutMs, 1],
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

describe("Multicursor input worker performance", () => {
  it(
    "checks atomic output and history while measuring publication separately from settlement",
    async () => {
      jasmine.useRealClock();
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
      jasmine.attachToDOM(workspace);
      const report = {
        schema: 1,
        sourcePath,
        sourceRevision: config.sourceRevision ?? null,
        backend: {
          requested: process.env.LUMINE_SYNTAX_EXECUTION,
          registry: lumine.grammars.syntaxExecution,
        },
        runtime: process.versions,
        samples,
        warmups,
        operationTimeoutMs,
        startedAt: new Date().toISOString(),
        sourceFingerprint: sourceBefore,
        grammarFingerprint: grammarBefore,
        fixtureGeneratorSha256: fileHash(require.resolve("./helpers/multicursor-input-fixture")),
        benchmarkSha256: fileHash(__filename),
        results: [],
        failures: [],
        complete: false,
        timingDefinition: {
          first: "First Enter after initial grammar settlement; not app startup or cold OS cache",
          published: "insertNewline invocation to first onDidApplyChanges",
          complete: "insertNewline invocation to command promise resolution",
          grammarSettled: "insertNewline invocation to authoritative parent grammar settlement",
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
        const result = {
          id,
          fixture: input.metadata,
          first: [],
          measured: [],
          events: [],
          checks: { exactText: 0, cursors: 0, onePublication: 0, undo: 0, redo: 0 },
        };
        report.results.push(result);
        const editor = await lumine.workspace.open();
        let events, closed;
        try {
          editor.setText(input.source);
          assert.equal(
            lumine.grammars.assignLanguageMode(editor.getBuffer(), input.metadata.grammarScope),
            true,
          );
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
          for (let trial = -warmups; trial < samples; trial++) {
            assert.equal(editor.getText(), input.source);
            editor.setSelectedBufferRanges(input.points.map((point) => [point, point]));
            const beforeSelections = editor
              .getSelectedBufferRanges()
              .map((range) => range.serialize());
            const buffer = editor.getBuffer();
            buffer.clearUndoStack();
            editor.getElement().component.updateSync();
            await new Promise(requestAnimationFrame);
            const controller = new AbortController();
            let published,
              publications = 0,
              timer;
            const started = performance.now();
            const subscription = buffer.onDidApplyChanges(() => {
              published ??= performance.now() - started;
              publications++;
            });
            const sample = { trial };
            let outcome;
            try {
              const pending = editor.insertNewline({ signal: controller.signal });
              sample.commandReturn = performance.now() - started;
              assert.equal(typeof pending?.then, "function", "Worker input must return a promise");
              const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error(`${id} trial ${trial} timed out`));
                }, operationTimeoutMs);
              });
              outcome = await Promise.race([pending, timeout]);
              sample.complete = performance.now() - started;
              await Promise.race([editor.whenGrammarSettled(), timeout]);
              sample.grammarSettled = performance.now() - started;
            } finally {
              clearTimeout(timer);
              subscription.dispose();
            }
            sample.published = published ?? null;
            sample.publications = publications;
            sample.cancelled = outcome === false;
            (trial < 0 ? result.first : result.measured).push(sample);
            const currentMode = buffer.getLanguageMode();
            result.lastOutcome = {
              trial,
              cancelled: outcome === false,
              publications,
              actualEqualsSource: editor.getText() === input.source,
              currentMode: currentMode.constructor.name,
              failure: currentMode.syntaxAvailability?.failure ?? mode.session?.failure ?? null,
            };
            save();
            assert.notEqual(outcome, false, `${id} input unexpectedly cancelled`);
            assert.ok(editor.getText() === input.expected, `${id} exact final text`);
            result.checks.exactText++;
            assert.deepEqual(
              editor.getCursorBufferPositions().map((point) => point.serialize()),
              input.expectedPositions,
            );
            result.checks.cursors++;
            assert.equal(publications, 1);
            result.checks.onePublication++;
            await editor.undo();
            await editor.whenGrammarSettled();
            assert.equal(editor.getText(), input.source);
            assert.deepEqual(
              editor.getSelectedBufferRanges().map((range) => range.serialize()),
              beforeSelections,
            );
            result.checks.undo++;
            await editor.redo();
            await editor.whenGrammarSettled();
            assert.equal(editor.getText(), input.expected);
            assert.deepEqual(
              editor.getCursorBufferPositions().map((point) => point.serialize()),
              input.expectedPositions,
            );
            result.checks.redo++;
            await editor.undo();
            await editor.whenGrammarSettled();
            assert.equal(editor.getText(), input.source);
            save();
          }
          result.metrics = Object.fromEntries(
            ["commandReturn", "published", "complete", "grammarSettled"].map((field) => [
              field,
              stats(result.measured.map((sample) => sample[field])),
            ]),
          );
          result.successful = true;
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
          };
          report.failures.push({ id, ...result.failure });
        } finally {
          events?.dispose();
          closed?.dispose();
          editor.destroy();
          save();
        }
      }
      assert.deepEqual(
        sourceFingerprint(),
        sourceBefore,
        "Runtime source changed during measurement",
      );
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
    },
    30 * 60 * 1000,
  );
});
