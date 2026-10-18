const fs = require("node:fs");
const crypto = require("node:crypto");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

const config = JSON.parse(process.env.LUMINE_DOCUMENT_BENCH_CONFIG || "{}");
const samples = config.samples ?? 9;
const warmups = config.warmups ?? 3;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const hash = (value) => crypto.createHash("sha256").update(value, "utf16le").digest("hex");
const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: values,
  };
};

describe("JavaScript document editor integration performance", () => {
  it("compares real editor commands, syntax settlement and DOM layout", async () => {
    jasmine.useRealClock();
    lumine.config.set("editor.tabLength", 4);
    lumine.config.set("whitespace.ignoreWhitespaceOnCurrentLine", false);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-ipython");
    for (const name of config.packages ?? []) await lumine.packages.activatePackage(name);
    // Binary/query loading is setup, outside the edit benchmark. Preloading
    // also avoids the historical native loader's parallel file-read limit.
    for (const scope of [
      "source.js",
      "source.css",
      "text.html.basic",
      "source.python",
      "source.python.ipy",
      "source.json",
      "source.gfm",
    ])
      await lumine.grammars.grammarForScopeName(scope)?.getLanguage?.();
    if (config.packages?.length) {
      const workspace = lumine.workspace.getElement();
      workspace.style.width = "1000px";
      workspace.style.height = "800px";
      jasmine.attachToDOM(workspace);
    }
    const cases = [
      { id: "plain-1m-markers", units: 1000000, markers: 10000 },
      { id: "plain-8m-markers", units: 8000000, markers: 10000 },
      { id: "plain-32m-markers", units: 32000000, markers: 10000 },
      { id: "soft-wrap-long-lines", units: 1000000, markers: 1000, wrapped: true, long: true },
      { id: "single-line-1m", units: 1000000, singleLine: true },
      { id: "multicursor-1000", units: 1000000, cursors: 1000 },
      { id: "paste-1m", units: 1000000, paste: true },
      { id: "javascript-1m", units: 1000000, scope: "source.js" },
      { id: "ipython-injections", scope: "source.python.ipy" },
      ...(config.packageCases
        ? [
            { id: "sort-lines-10000", command: "sort-lines:sort", rows: 10000 },
            {
              id: "autocomplete-popup",
              units: 300000,
              completion: true,
              line: "banana bandana ban_ana bandaid band bNa\n",
            },
            {
              id: "whitespace-trim-5000",
              command: "whitespace:remove-trailing-whitespace",
              rows: 5000,
            },
            {
              id: "whitespace-tabs-5000",
              command: "whitespace:convert-tabs-to-spaces",
              rows: 5000,
            },
            {
              id: "python-crlf-1m",
              units: 1000000,
              scope: "source.python",
              line: 'value = "😀終"\r\n',
            },
            {
              id: "html-injections-1m",
              units: 1000000,
              scope: "text.html.basic",
              html: true,
            },
            {
              id: "html-1000-injections",
              repetitions: 1000,
              scope: "text.html.basic",
              line: "<script>var value = 1;</script><p>Text 終</p>\n",
            },
            {
              id: "json-minified-20000-records",
              units: 1000000,
              scope: "source.json",
              singleLine: true,
              json: true,
            },
          ]
        : []),
    ].filter((item) => !config.filter || new RegExp(config.filter).test(item.id));
    const report = {
      schemaVersion: 1,
      date: new Date().toISOString(),
      runtime: process.versions,
      platform: process.platform,
      arch: process.arch,
      samples,
      warmups,
      packages: config.packages ?? [],
      driverHash: crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
      timing:
        "Synchronous command, grammar settlement, explicit DOM/layout update and timer turn delay. Excludes fixture setup, verification, clipboard IPC and physical frame paint.",
      results: [],
    };
    for (const item of cases) {
      const line =
        item.line ??
        (item.singleLine
          ? "abcdefghijklmnopqrstuvwxyz 終"
          : item.long
            ? `${"abcdefghijklmnopqrstuvwxyz ".repeat(180)}終\n`
            : 'const value = "text 終"; // sample\n');
      const original = item.command
        ? Array.from({ length: item.rows }, (_, i) =>
            item.id.startsWith("sort-")
              ? `line ${String(item.rows - i).padStart(5, "0")}\n`
              : item.id.includes("trim")
                ? `line ${i}  \t\n`
                : `\tline ${i}\n`,
          ).join("")
        : item.completion
          ? "\n" + line.repeat(Math.ceil(item.units / line.length))
          : item.html
            ? "<html><style>.sample { color: red }</style><body><script>" +
              "var value = 1;\n".repeat(20000) +
              "</script>" +
              '<p class="sample">Text 終</p>\n'.repeat(25000) +
              "</body></html>"
            : item.json
              ? JSON.stringify(
                  Array.from({ length: 20000 }, (_, i) => ({
                    id: i,
                    name: "value 終",
                    enabled: true,
                  })),
                )
              : item.id === "ipython-injections"
                ? Array.from(
                    { length: 120 },
                    (_, i) =>
                      `# %%\nvalue_${i} = ${i}\n# %% [markdown]\n# Heading ${i}\n# Some **text** and a [link](https://example.test/${i}).\n`,
                  ).join("")
                : item.repetitions
                  ? line.repeat(item.repetitions)
                  : item.scope
                    ? line.repeat(Math.floor(item.units / line.length))
                    : line.repeat(Math.ceil(item.units / line.length)).slice(0, item.units);
      const pasteLine = 'const pasted = "value";\n';
      const paste = pasteLine.repeat(Math.ceil(1000000 / pasteLine.length)).slice(0, 1000000);
      const buffer = new TextBuffer({ text: original });
      let editor, component;
      const timings = Object.fromEntries(
        ["edit", "undo", "redo"].map((name) => [
          name,
          {
            command: [],
            settled: [],
            layout: [],
            complete: [],
            timerDelay: [],
            ...(config.packages?.length ? { twoFrames: [] } : {}),
          },
        ]),
      );
      let events = 0;
      const subscription = buffer.onDidChangeText(() => events++);
      try {
        editor = new TextEditor({
          buffer,
          autoHeight: false,
          autoWidth: false,
          lineNumberGutterVisible: true,
          showLineNumbers: true,
          softWrapped: Boolean(item.wrapped),
          softWrapColumn: 90,
          undoGroupingInterval: 0,
          autoIndent: false,
          softTabs: true,
          tabLength: 4,
        });
        if (config.packages?.length) {
          const pane = lumine.workspace.getActivePane();
          pane.addItem(editor);
          pane.activateItem(editor);
          component = lumine.views.getView(editor).getComponent();
        } else component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
        component.element.style.width = "1000px";
        component.element.style.height = "800px";
        if (!config.packages?.length) jasmine.attachToDOM(component.element);
        if (item.completion) component.element.focus();
        if (config.packages?.includes("minimap")) {
          await tick();
          expect(
            lumine.packages.getActivePackage("minimap").mainModule.editorsMinimaps.has(editor),
          ).toBe(true);
        }
        if (item.scope) {
          expect(lumine.grammars.assignLanguageMode(buffer, item.scope)).toBe(true);
          await editor.whenGrammarSettled();
        }
        editor.setSoftWrapped(Boolean(item.wrapped));
        expect(editor.isSoftWrapped()).toBe(Boolean(item.wrapped));
        expect(editor.getTabLength()).toBe(4);
        const markerLayer = buffer.addMarkerLayer({ maintainHistory: true });
        const stride = Math.max(1, Math.floor(buffer.getLineCount() / (item.markers || 1)));
        const markers = [];
        for (let index = 0; index < (item.markers || 0); index++) {
          const row = Math.min(buffer.getLastRow(), index * stride);
          markers.push(
            markerLayer.markRange(
              [
                [row, 0],
                [row, Math.min(8, buffer.lineLengthForRow(row))],
              ],
              { invalidate: "never", exclusive: true },
            ),
          );
        }
        const selections = item.cursors
          ? Array.from({ length: item.cursors }, (_, i) => [
              [i * 3, 0],
              [i * 3, 0],
            ])
          : [
              [
                [0, 0],
                [0, 0],
              ],
            ];
        editor.setSelectedBufferRanges(selections);
        editor.getScreenLineCount();
        component.updateSync();
        await editor.whenGrammarSettled();
        component.updateSync();
        const expected = item.command
          ? item.id.startsWith("sort-")
            ? Array.from(
                { length: item.rows },
                (_, i) => `line ${String(i + 1).padStart(5, "0")}\n`,
              ).join("")
            : item.id.includes("trim")
              ? original.replace(/[ \t]+\n/g, "\n")
              : original.replace(/^\t/gm, "    ")
          : item.cursors
            ? original
                .split("\n")
                .map((value, row) =>
                  row % 3 === 0 && row / 3 < item.cursors ? ` ${value}` : value,
                )
                .join("\n")
            : (item.paste ? paste : item.completion ? "bna" : " ") + original;
        const originalHash = hash(original),
          editedHash = hash(expected);
        const markerBaseline = markers.map((marker) => marker.getRange().serialize());
        const mode = buffer.getLanguageMode();
        let editedSyntax, originalSyntax, editedScreenLines;
        const verify = (textHash, restored) => {
          expect(hash(buffer.getText()))
            .withContext(
              `${item.id}, restored=${restored}, prefix=${JSON.stringify(
                buffer.getTextInRange([
                  [0, 0],
                  [0, 50],
                ]),
              )}`,
            )
            .toBe(textHash);
          expect(component.element.querySelectorAll(".line").length).toBeGreaterThan(0);
          if (item.scope) {
            expect(mode.tree.revision).toBe(buffer.getTextRevision());
            expect(mode.tree.input).toBe(buffer.getText());
            const layers = mode.getAllLanguageLayers();
            if (item.id.includes("injections")) expect(layers.length).toBeGreaterThan(1);
            const signature = hash(
              JSON.stringify(
                layers.map((layer) => [layer.grammar.scopeName, layer.tree.rootNode.toString()]),
              ),
            );
            if (restored) originalSyntax = signature;
            else editedSyntax = signature;
          }
          if (restored) {
            expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(
              selections,
            );
            expect(markers.map((marker) => marker.getRange().serialize())).toEqual(markerBaseline);
          } else editedScreenLines = editor.getScreenLineCount();
        };
        const measure = async (name, operation, textHash, restored, record) => {
          await tick();
          const timerStart = performance.now();
          let delay;
          const timer = new Promise((resolve) =>
            setTimeout(() => {
              delay = performance.now() - timerStart;
              resolve();
            }, 0),
          );
          const start = performance.now();
          const result = operation();
          const commanded = performance.now();
          if (result?.then) await result;
          await editor.whenGrammarSettled();
          const settled = performance.now();
          component.updateSync();
          const rendered = performance.now();
          await timer;
          let frames;
          if (config.packages?.length) {
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            frames = performance.now() - start;
          }
          if (record) {
            const row = timings[name];
            row.command.push(commanded - start);
            row.settled.push(settled - start);
            row.layout.push(rendered - settled);
            row.complete.push(rendered - start);
            row.timerDelay.push(delay);
            if (frames !== undefined) row.twoFrames.push(frames);
          }
          verify(textHash, restored);
        };
        for (let sample = 0; sample < samples + warmups; sample++) {
          const record = sample >= warmups;
          editor.setSelectedBufferRanges(selections);
          events = 0;
          await measure(
            "edit",
            () =>
              item.completion
                ? (async () => {
                    editor.insertText("bna", { autoIndent: false });
                    lumine.commands.dispatch(component.element, "autocomplete:activate");
                    const manager =
                      lumine.packages.getActivePackage("autocomplete").mainModule
                        .autocompleteManager;
                    const deadline = performance.now() + 10000;
                    while (!manager.suggestionList?.items?.some((item) => item.text === "banana")) {
                      if (performance.now() > deadline)
                        throw new Error("Autocomplete did not publish expected suggestions");
                      await tick();
                    }
                  })()
                : item.command
                  ? lumine.commands.dispatch(component.element, item.command)
                  : item.paste
                    ? editor.pasteText({
                        clipboard: { readWithMetadata: () => ({ text: paste }) },
                        autoIndent: false,
                      })
                    : editor.insertText(" ", { autoIndent: false }),
            editedHash,
            false,
            record,
          );
          expect(events).toBe(1);
          await measure("undo", () => editor.undo(), originalHash, true, record);
          await measure("redo", () => editor.redo(), editedHash, false, record);
          editor.undo();
          await editor.whenGrammarSettled();
          component.updateSync();
          verify(originalHash, true);
          buffer.clearUndoStack();
          buffer.emitDidStopChangingEvent();
          await tick();
        }
        report.results.push({
          id: item.id,
          units: original.length,
          lines: buffer.getLineCount(),
          markers: markers.length,
          cursors: selections.length,
          scope: item.scope ?? null,
          languageLayers: item.scope
            ? mode.getAllLanguageLayers().map((layer) => layer.grammar.scopeName)
            : [],
          wrapped: Boolean(item.wrapped),
          softWrapColumn: editor.displayLayer.softWrapColumn,
          inputHash: originalHash,
          outputHash: editedHash,
          originalSyntax,
          editedSyntax,
          editedScreenLines,
          metrics: Object.fromEntries(
            Object.entries(timings).map(([name, values]) => [
              name,
              Object.fromEntries(
                Object.entries(values).map(([key, values]) => [key, stats(values)]),
              ),
            ]),
          ),
          memory: process.memoryUsage(),
        });
      } finally {
        subscription.dispose();
        component?.element.remove();
        editor?.destroy();
        if (!buffer.isDestroyed()) buffer.destroy();
      }
      await tick();
    }
    const nativeModules = Object.keys(require.cache).filter((name) =>
      /superstring[\\/]/.test(name),
    );
    report.superstringLoaded = nativeModules.length > 0;
    const output = process.env.LUMINE_DOCUMENT_BENCH_OUTPUT;
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`DOCUMENT_BENCHMARK_COMPLETE=${report.results.length}`);
  }, 600000);
});
