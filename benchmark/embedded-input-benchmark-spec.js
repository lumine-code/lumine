const fs = require("node:fs");
const crypto = require("node:crypto");

// Run with npm run test:only -- benchmark/embedded-input-benchmark-spec.js.
// Optional LUMINE_EMBEDDED_INPUT_BENCH_CONFIG:
// {sizes:[100,300], samples:5, warmups:1, cases:["ipython"], modes:["single"]}.
// LUMINE_EMBEDDED_INPUT_BENCH_OUTPUT writes JSON; otherwise the report is logged.
// Fixtures are public synthetic source. No user files or timing thresholds.
const config = JSON.parse(process.env.LUMINE_EMBEDDED_INPUT_BENCH_CONFIG || "{}");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
    max: sorted.at(-1) ?? null,
    samples: values,
  };
};
const packages = [
  "language-ipython",
  "language-python",
  "language-html",
  "language-javascript",
  "language-css",
  "language-gfm",
];
const definitions = [
  { id: "python", scope: "source.python" },
  { id: "ipython", scope: "source.python.ipy" },
  { id: "html", scope: "text.html.basic" },
  { id: "markdown", scope: "source.gfm" },
];

function fixture(definition, size) {
  const middle = Math.floor(size / 2);
  let insertionIndex;
  const blocks = Array.from({ length: size }, (_, index) => {
    const name = `Example${String(index).padStart(5, "0")}`;
    if (definition.id === "python" || definition.id === "ipython") {
      const prefix = definition.id === "ipython" ? "# %%\r\n" : "";
      const fields = Array.from(
        { length: 8 },
        (_, field) =>
          `        ("field_${field}", scalar, dict(default=${field}.0, units="m", optional=False)),`,
      ).join("\r\n");
      return `${prefix}class ${name}:\r\n    """Public synthetic record with nested descriptors and multiline calls."""\r\n    fields = (\r\n${fields}\r\n    )\r\n    defaults = dict(\r\n        vector=(1.0, 2.0, 3.0),\r\n        metadata={"label": "example", "enabled": True},\r\n    )\r\n\r\n`;
    }
    const source = `<section>\n<script>\nclass ${name} {\n    run() {\n        return css\`\n.demo { color: red; }\n\`;\n    }\n}\n</script>\n</section>\n`;
    return definition.id === "markdown" ? `\`\`\`html\n${source}\`\`\`\n\n` : source;
  });
  const source = blocks.join("");
  const target = source.indexOf(`class Example${String(middle).padStart(5, "0")}`);
  const python = definition.id === "python" || definition.id === "ipython";
  insertionIndex = python
    ? source.indexOf(":", target) + 1
    : source.indexOf("    run() {", target) + "    run() {".length;
  const newline = python ? "\r\n" : "\n";
  const indent = python ? "    " : "        ";
  const inserted = newline + indent;
  const expected = source.slice(0, insertionIndex) + inserted + source.slice(insertionIndex);
  return { source, insertionIndex, newline, expected, inserted };
}

describe("Embedded syntax input performance", () => {
  it("measures edit-to-publication separately from grammar settlement and checks history", async () => {
    jasmine.useRealClock();
    for (const name of packages) await lumine.packages.activatePackage(name);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1100px";
    workspace.style.height = "800px";
    jasmine.attachToDOM(workspace);
    const report = {
      runtime: process.versions,
      packages,
      samples: config.samples ?? 5,
      warmups: config.warmups ?? 1,
      results: [],
    };
    const competitor = await lumine.workspace.open();
    try {
      competitor.update({
        autoIndent: true,
        tabLength: 4,
        softTabs: true,
        undoGroupingInterval: 0,
      });
      const competition = fixture(definitions[1], Math.max(...(config.sizes ?? [100, 300])) * 3);
      competitor.setText(competition.source);
      expect(lumine.grammars.assignLanguageMode(competitor.getBuffer(), "source.python.ipy")).toBe(
        true,
      );
      await competitor.whenGrammarSettled();
      let competitionRevision = 0;
      for (const definition of definitions.filter(
        (entry) => !config.cases || config.cases.includes(entry.id),
      )) {
        for (const size of config.sizes ?? [100, 300]) {
          const input = fixture(definition, size);
          for (const mode of config.modes ?? ["single", "queued-input", "competing-document"]) {
            const expected =
              mode === "queued-input"
                ? input.expected.slice(0, input.insertionIndex + input.inserted.length) +
                  "work()" +
                  input.expected.slice(input.insertionIndex + input.inserted.length)
                : input.expected;
            const editor = await lumine.workspace.open();
            try {
              editor.update({
                autoIndent: true,
                tabLength: 4,
                softTabs: true,
                undoGroupingInterval: 0,
              });
              editor.setText(input.source);
              expect(lumine.grammars.assignLanguageMode(editor.getBuffer(), definition.scope)).toBe(
                true,
              );
              await editor.whenGrammarSettled();
              const metrics = {
                commandReturn: [],
                firstPublish: [],
                finalPublish: [],
                complete: [],
                layout: [],
                settle: [],
                competitorSettle: [],
              };
              const publicationCounts = [];
              for (let sample = -report.warmups; sample < report.samples; sample++) {
                const buffer = editor.getBuffer();
                const position = buffer.positionForCharacterIndex(input.insertionIndex);
                editor.setCursorBufferPosition(position);
                editor.scrollToCursorPosition({ mode: "center" });
                editor.getElement().component.updateSync();
                buffer.clearUndoStack();
                await new Promise(requestAnimationFrame);
                const publications = [];
                let started;
                const subscription = buffer.onDidApplyChanges(() =>
                  publications.push({ ms: performance.now() - started, text: editor.getText() }),
                );
                let competing, competitorSource;
                if (mode === "competing-document") {
                  // A second document replaces its source and receives input while
                  // the foreground command prepares indentation on the same worker.
                  competitorSource = `${competition.source}# revision ${competitionRevision++}\r\n`;
                  competitor.setText(competitorSource);
                  competitor.getBuffer().clearUndoStack();
                  competitor.setCursorBufferPosition([0, 0]);
                  competing = competitor.insertText("# concurrent input\r\n", {
                    autoIndent: false,
                  });
                }
                started = performance.now();
                let complete, layout, settle, competitorSettle, commandReturn;
                try {
                  const newline = editor.insertNewline();
                  const queued = mode === "queued-input" ? editor.insertText("work()") : null;
                  commandReturn = performance.now() - started;
                  await newline;
                  await queued;
                  complete = performance.now() - started;
                  editor.getElement().component.updateSync();
                  layout = performance.now() - started;
                  await editor.whenGrammarSettled();
                  settle = performance.now() - started;
                  await competing;
                  await competitor.whenGrammarSettled();
                  competitorSettle = performance.now() - started;
                } finally {
                  subscription.dispose();
                }
                const context = `${definition.id}/${size}/${mode}/${sample}`;
                expect(editor.getText()).withContext(context).toBe(expected);
                expect(publications.map((entry) => entry.text))
                  .withContext(context)
                  .toEqual(mode === "queued-input" ? [input.expected, expected] : [expected]);
                expect(buffer.getLanguageMode().tree.revision)
                  .withContext(context)
                  .toBe(buffer.getTextRevision());
                if (mode === "competing-document") {
                  expect(competitor.getText())
                    .withContext(`${context}/competing input`)
                    .toBe("# concurrent input\r\n" + competitorSource);
                  await competitor.undo();
                  expect(competitor.getText())
                    .withContext(`${context}/competing undo`)
                    .toBe(competitorSource);
                  await competitor.whenGrammarSettled();
                }
                if (sample >= 0) {
                  const values = {
                    commandReturn,
                    firstPublish: publications[0].ms,
                    finalPublish: publications.at(-1).ms,
                    complete,
                    layout,
                    settle,
                    competitorSettle,
                  };
                  for (const [key, value] of Object.entries(values)) metrics[key].push(value);
                  publicationCounts.push(publications.length);
                }
                await editor.undo();
                if (mode === "queued-input") {
                  expect(editor.getText())
                    .withContext(`${context}/undo input`)
                    .toBe(input.expected);
                  await editor.undo();
                }
                expect(editor.getText()).withContext(`${context}/undo Enter`).toBe(input.source);
                expect(editor.getCursorBufferPosition())
                  .withContext(`${context}/undo cursor`)
                  .toEqual(position);
                await editor.whenGrammarSettled();
              }
              report.results.push({
                id: definition.id,
                scope: definition.scope,
                size,
                mode,
                bytes: Buffer.byteLength(input.source),
                rows: editor.getLineCount(),
                inputHash: hash(input.source),
                outputHash: hash(expected),
                publicationCounts,
                metrics: Object.fromEntries(
                  Object.entries(metrics).map(([key, values]) => [key, stats(values)]),
                ),
              });
            } finally {
              editor.destroy();
            }
          }
        }
      }
    } finally {
      competitor.destroy();
    }
    const output = process.env.LUMINE_EMBEDDED_INPUT_BENCH_OUTPUT;
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
    else console.log("EMBEDDED_INPUT_BENCHMARK", JSON.stringify(report));
  }, 600000);
});
