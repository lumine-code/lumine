const fs = require("node:fs");
const crypto = require("node:crypto");
const config = JSON.parse(process.env.HOT_EDIT_CONFIG || "{}");
const hash = (text) => crypto.createHash("sha256").update(text, "utf16le").digest("hex");
const stats = (samples) => {
  const sorted = samples.slice().sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], samples };
};

describe("Repeated hot editor operations", () => {
  it("measures complete successive keystrokes with active packages", async () => {
    jasmine.useRealClock();
    for (const name of config.packages) await lumine.packages.activatePackage(name);
    lumine.config.set("autocomplete.enableAutoActivation", false);
    lumine.config.set("whitespace.ignoreWhitespaceOnCurrentLine", false);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1000px";
    workspace.style.height = "800px";
    jasmine.attachToDOM(workspace);
    const report = { config, runtime: process.versions, results: [] };
    for (const fixture of [
      { id: "type-small-100", rows: 200, keys: 100, text: "x" },
      { id: "type-large-100", rows: 32000, keys: 100, text: "x" },
      { id: "newline-large-30", rows: 32000, keys: 30, text: "\n" },
      { id: "python-indented-enter-30", python: true, keys: 30, text: "\n" },
    ]) {
      const original = fixture.python
        ? "def work():\n    value = 1\n    return value\n"
        : 'const value = "text 終"; // sample\n'.repeat(fixture.rows);
      const position = fixture.python ? [1, 13] : [Math.floor(fixture.rows / 2), 10];
      const timings = [];
      let outputHash;
      for (let sample = -config.warmups; sample < config.samples; sample++) {
        const editor = await lumine.workspace.open();
        // Jasmine defaults to rendering synchronously after every model event.
        // Use production scheduling and flush once per measured keystroke.
        editor.getElement().setUpdatedSynchronously(false);
        expect(editor.getElement().isUpdatedSynchronously()).toBe(false);
        editor.update({
          autoIndent: Boolean(fixture.python),
          softTabs: true,
          tabLength: 4,
          softWrapped: false,
          undoGroupingInterval: 0,
        });
        editor.setText(original);
        if (fixture.python) lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python");
        await editor.whenGrammarSettled();
        editor.setCursorBufferPosition(position);
        const component = lumine.views.getView(editor).getComponent();
        editor.scrollToCursorPosition();
        component.updateSync();
        editor.getBuffer().clearUndoStack();
        const offset = editor.getBuffer().characterIndexForPosition(position);
        const expected = fixture.python
          ? "def work():\n    value = 1\n" +
            "\n".repeat(fixture.keys - 1) +
            "    \n    return value\n"
          : original.slice(0, offset) + fixture.text.repeat(fixture.keys) + original.slice(offset);
        const start = performance.now();
        for (let key = 0; key < fixture.keys; key++) {
          editor.insertText(
            fixture.text,
            fixture.python
              ? {}
              : { autoIndent: false, autoIndentNewline: false, autoDecreaseIndent: false },
          );
          await editor.whenGrammarSettled();
          component.updateSync();
        }
        if (sample >= 0) timings.push(performance.now() - start);
        expect(editor.getText()).withContext(fixture.id).toBe(expected);
        outputHash = hash(editor.getText());
        for (let key = 0; key < fixture.keys; key++) editor.undo();
        await editor.whenGrammarSettled();
        expect(editor.getText())
          .withContext(fixture.id + " undo")
          .toBe(original);
        expect(editor.getCursorBufferPosition().serialize()).toEqual(position);
        editor.destroy();
      }
      report.results.push({
        id: fixture.id,
        keys: fixture.keys,
        units: original.length,
        inputHash: hash(original),
        outputHash,
        total: stats(timings),
      });
    }
    fs.writeFileSync(process.env.HOT_EDIT_OUTPUT, JSON.stringify(report, null, 2));
  }, 600000);
});
