const fs = require("node:fs");
const crypto = require("node:crypto");
const config = JSON.parse(process.env.LUMINE_INDENT_BENCH_CONFIG || "{}");
const packages = config.packages ?? [
  "language-javascript",
  "language-python",
  "language-html",
  "whitespace",
];
const hash = (value) => crypto.createHash("sha256").update(value, "utf16le").digest("hex");
const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: values,
  };
};

describe("Auto-indent integration performance", () => {
  it("measures real indentation with active packages and verifies text and history", async () => {
    jasmine.useRealClock();
    if (config.scalar) {
      const TextEditor = require("../src/text-editor");
      // Same corrected plan and grammar in both variants. This control keeps
      // the previous per-row application strategy, including unchanged rows.
      spyOn(TextEditor.prototype, "applyIndentationLevels").and.callFake(
        function (indents, options) {
          if (!indents) return false;
          return this.transact(() => {
            for (const [row, indent] of indents) {
              if (Number.isInteger(row) && Number.isFinite(indent) && indent >= 0)
                this.setIndentationForBufferRow(row, indent, options);
            }
          });
        },
      );
    }
    for (const name of packages) await lumine.packages.activatePackage(name);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("whitespace.ignoreWhitespaceOnCurrentLine", false);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1000px";
    workspace.style.height = "800px";
    jasmine.attachToDOM(workspace);
    const cases = [
      {
        id: "javascript-2100-rows",
        scope: "source.js",
        count: 300,
        source: "function work() {\nconst x = [\n1,\n2,\n];\nreturn x;\n}\n",
        expected:
          "function work() {\n    const x = [\n        1,\n        2,\n    ];\n    return x;\n}\n",
      },
      {
        id: "python-1800-rows",
        scope: "source.python",
        count: 300,
        source: "def work():\n    value = [\n1,\n2,\n]\n    return value\n",
        expected: "def work():\n    value = [\n        1,\n        2,\n    ]\n    return value\n",
      },
      {
        id: "html-100-injections",
        scope: "text.html.basic",
        count: 100,
        source: "<div>\n<script>\nfunction work() {\nrun();\n}\n</script>\n</div>\n",
        expected:
          "<div>\n    <script>\n        function work() {\n            run();\n        }\n    </script>\n</div>\n",
      },
      {
        id: "python-enter-300",
        scope: "source.python",
        count: 300,
        enter: true,
        source: "def work():\n    return 1\n",
        expected: "def work():\n    \n    return 1\n",
      },
    ];
    const report = {
      runtime: process.versions,
      scalar: Boolean(config.scalar),
      packages,
      samples: config.samples ?? 7,
      warmups: config.warmups ?? 2,
      results: [],
    };
    for (const fixture of cases) {
      const source = fixture.source.repeat(fixture.count),
        expected = fixture.expected.repeat(fixture.count);
      const editor = await lumine.workspace.open();
      try {
        editor.update({ tabLength: 4, softTabs: true, autoIndent: true });
        editor.setText(source);
        expect(lumine.grammars.assignLanguageMode(editor.getBuffer(), fixture.scope)).toBe(true);
        await editor.whenGrammarSettled();
        const component = editor.getElement().component;
        const selections = fixture.enter
          ? Array.from({ length: fixture.count }, (_, i) => [
              [i * 2, 11],
              [i * 2, 11],
            ])
          : [editor.getBuffer().getRange().serialize()];
        editor.setSelectedBufferRanges(selections);
        component.updateSync();
        editor.getBuffer().clearUndoStack();
        const metrics = { edit: [], undo: [], redo: [] },
          layouts = [];
        const buffer = editor.getBuffer();
        const update = buffer.updateDisplayLayersForChange.bind(buffer);
        let layoutCount = 0;
        spyOn(buffer, "updateDisplayLayersForChange").and.callFake((...args) => {
          layoutCount++;
          return update(...args);
        });
        for (let sample = -report.warmups; sample < report.samples; sample++) {
          editor.setSelectedBufferRanges(selections);
          for (const action of ["edit", "undo", "redo"]) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            layoutCount = 0;
            const start = performance.now();
            if (action === "edit") {
              if (fixture.enter) editor.insertNewline();
              else editor.autoIndentSelectedRows();
            } else editor[action]();
            await editor.whenGrammarSettled();
            component.updateSync();
            const elapsed = performance.now() - start;
            expect(editor.getText())
              .withContext(`${fixture.id}/${action}`)
              .toBe(action === "undo" ? source : expected);
            if (action === "undo")
              expect(editor.getSelectedBufferRanges().map((r) => r.serialize())).toEqual(
                selections,
              );
            expect(buffer.getLanguageMode().tree.input).toBe(editor.getText());
            if (sample >= 0) {
              metrics[action].push(elapsed);
              if (action === "edit") layouts.push(layoutCount);
            }
          }
          editor.undo();
          await editor.whenGrammarSettled();
        }
        report.results.push({
          id: fixture.id,
          inputHash: hash(source),
          outputHash: hash(expected),
          layouts,
          metrics: Object.fromEntries(
            Object.entries(metrics).map(([name, values]) => [name, stats(values)]),
          ),
        });
      } finally {
        editor.destroy();
      }
    }
    fs.writeFileSync(process.env.LUMINE_INDENT_BENCH_OUTPUT, JSON.stringify(report, null, 2));
  }, 600000);
});
