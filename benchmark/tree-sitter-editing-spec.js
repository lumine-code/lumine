const fs = require("node:fs");
const crypto = require("node:crypto");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const samples = Number(process.env.TREE_SITTER_EDIT_SAMPLES || 5);
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
    samples: values,
  };
};

describe("Tree-sitter editing performance", () => {
  let editor;
  let restore = [];
  afterEach(() => {
    for (const callback of restore.splice(0)) callback();
    editor?.destroy();
  });
  it("measures command blocking and complete highlighting separately", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-ipython");
    const input = process.env.TREE_SITTER_EDIT_FILE;
    const text = input
      ? fs.readFileSync(input, "utf8")
      : Array.from(
          { length: 300 },
          (_, i) =>
            `def work_${i}(value):\n    if value:\n        return value + ${i}\n    return 0\n\n`,
        ).join("");
    const scope = input?.endsWith(".ipy") ? "source.python.ipy" : "source.python";
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, softTabs: true, tabLength: 4, undoGroupingInterval: 0 });
    editor.setText(text);
    lumine.grammars.assignLanguageMode(editor.getBuffer(), scope);
    async function settle() {
      for (let attempt = 0; attempt < 20; attempt++) {
        await editor.whenGrammarSettled();
        if (editor.autoIndentAtTransactionEndPromise)
          await editor.autoIndentAtTransactionEndPromise;
        await tick();
        const mode = editor.getBuffer().getLanguageMode();
        if (
          !mode.publicationPending &&
          !mode.resolveNextTransaction &&
          !editor.autoIndentAtTransactionEndPromise
        )
          return;
      }
      throw new Error("Editor did not settle");
    }
    await settle();
    const mode = editor.getBuffer().getLanguageMode();
    mode.ensureQueriesForLayersSync("indentsQuery");
    mode.ensureQueriesForLayersSync("foldsQuery");
    await settle();
    const middle = Math.floor(editor.getLastBufferRow() / 2);
    const screen = () =>
      editor.displayLayer.getScreenLines(
        middle,
        Math.min(middle + 80, editor.getScreenLineCount()),
      );
    screen();
    await settle();
    screen();
    let parses = 0,
      queries = 0;
    function instrument(object, name, count) {
      const original = object[name];
      object[name] = function (...args) {
        count();
        return original.apply(this, args);
      };
      restore.push(() => {
        object[name] = original;
      });
    }
    for (const name of ["parse", "parseAsync"]) instrument(mode, name, () => parses++);
    const prototypes = new Set();
    for (const layer of mode.getAllLanguageLayers()) {
      for (const query of Object.values(layer.queries)) {
        if (query?.captures) prototypes.add(Object.getPrototypeOf(query));
      }
    }
    for (const prototype of prototypes)
      for (const name of ["captures", "matches"])
        if (typeof prototype[name] === "function") instrument(prototype, name, () => queries++);
    const report = {
      createdAt: new Date().toISOString(),
      variant: process.env.TREE_SITTER_EDIT_VARIANT || "current",
      sourceHash: crypto.createHash("sha256").update(text).digest("hex"),
      utf16Units: text.length,
      rows: editor.getLineCount(),
      runtime: process.versions,
      scope,
      units: "ms",
      samples,
      scenarios: {},
      notes: [
        "Real TextEditor operations and grammar settlement; visible screen-line construction included. GPU frame presentation is not measured.",
        "Event-loop delay includes the synchronous command and interim screen-line construction.",
        "Task-delay probes sample the renderer event loop every 4 ms; they approximate scheduling latency, not hardware keyboard-to-photon latency.",
        "Parse requests and uncached query executions are counts, not milliseconds. Native snapshots and WASM may have different query implementations.",
      ],
    };
    async function measure(action) {
      await tick();
      parses = queries = 0;
      const start = performance.now();
      const delays = [];
      let lastProbe = start;
      const interval = setInterval(() => {
        const now = performance.now();
        delays.push(Math.max(0, now - lastProbe - 4));
        lastProbe = now;
      }, 4);
      const probe = new Promise((resolve) =>
        setImmediate(() => resolve(performance.now() - start)),
      );
      action();
      const returned = performance.now();
      screen();
      const interim = performance.now();
      await settle();
      const ready = performance.now();
      screen();
      const end = performance.now();
      clearInterval(interval);
      delays.push(Math.max(0, end - lastProbe - 4));
      const eventLoop = await probe;
      expect(mode.tree.revision).toBe(editor.getBuffer().getTextRevision());
      expect(mode.tree.input).toBe(editor.getText());
      return {
        command: returned - start,
        interimPaint: interim - returned,
        ready: ready - start,
        finalPaint: end - ready,
        total: end - start,
        eventLoop,
        taskDelayP95: stats(delays).p95,
        maxTaskDelay: Math.max(...delays),
        parseRequests: parses,
        queryExecutions: queries,
      };
    }
    const scenarios = [
      {
        name: "comment-all",
        reverse: "uncomment-all",
        prepare() {
          editor.selectAll();
        },
        forward() {
          editor.toggleLineCommentsInSelection();
        },
        backward() {
          editor.toggleLineCommentsInSelection();
        },
      },
      {
        name: "eight-cursor-newline",
        reverse: "undo-eight-cursor-newline",
        prepare() {
          editor.setSelectedBufferRanges(
            Array.from({ length: 8 }, (_, i) => {
              const row = Math.floor(((i + 1) * editor.getLastBufferRow()) / 9);
              const col = editor.lineTextForBufferRow(row).length;
              return [
                [row, col],
                [row, col],
              ];
            }),
          );
        },
        forward() {
          editor.insertNewline();
        },
        backward() {
          editor.undo();
        },
      },
      {
        name: "insert-character",
        reverse: "undo-character",
        prepare() {
          editor.setCursorBufferPosition([middle, 0]);
        },
        forward() {
          editor.insertText("x", {
            autoIndent: false,
            autoDecreaseIndent: false,
            groupUndo: false,
          });
        },
        backward() {
          editor.undo();
        },
      },
    ];
    for (const scenario of scenarios) {
      const forward = [],
        reverse = [];
      for (let run = -2; run < samples; run++) {
        scenario.prepare();
        const a = await measure(() => scenario.forward());
        const b = await measure(() => scenario.backward());
        expect(editor.getText()).withContext(scenario.name).toBe(text);
        if (run >= 0) {
          forward.push(a);
          reverse.push(b);
        }
      }
      for (const [name, records] of [
        [scenario.name, forward],
        [scenario.reverse, reverse],
      ]) {
        report.scenarios[name] = Object.fromEntries(
          Object.keys(records[0]).map((key) => [key, stats(records.map((record) => record[key]))]),
        );
      }
      if (process.env.TREE_SITTER_EDIT_OUTPUT)
        fs.writeFileSync(process.env.TREE_SITTER_EDIT_OUTPUT, JSON.stringify(report, null, 2));
    }
    console.log("TREE_SITTER_EDITING", JSON.stringify(report));
  }, 300000);
});
