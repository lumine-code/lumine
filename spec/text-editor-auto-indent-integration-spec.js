const { autoIndentRanges } = require("../src/text-editor-auto-indent");
const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

describe("Streamed editor grammar indentation", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
  });
  for (const worker of [false, true]) {
    it(`publishes one exact undo step from ${worker ? "worker" : "inline"} grammar batches`, async () => {
      const service = worker ? new Service(lumine.grammars) : null;
      const editor = lumine.workspace.buildTextEditor({
        autoHeight: false,
        tabLength: 2,
        softTabs: true,
      });
      const original = "function work() {\nif (ready) {\n" + "value();\n".repeat(40) + "}\n}\n";
      const expected =
        "function work() {\n  if (ready) {\n" + "    value();\n".repeat(40) + "  }\n}\n";
      try {
        editor.setText(original);
        const buffer = editor.getBuffer();
        if (worker)
          buffer.setLanguageMode(
            new WorkerMode({
              buffer,
              grammar: lumine.grammars.grammarForScopeName("source.js"),
              service,
            }),
          );
        else lumine.grammars.assignLanguageMode(buffer, "source.js");
        await editor.whenGrammarSettled();
        buffer.clearUndoStack();
        const changes = jasmine.createSpy("change");
        const subscription = buffer.onDidChange(changes);
        const result = await autoIndentRanges(editor, [[0, buffer.getLastRow()]]);
        subscription.dispose();
        expect(result.changed).toBe(true);
        expect(editor.getText()).toBe(expected);
        expect(changes.calls.count()).toBe(1);
        editor.undo();
        expect(editor.getText()).toBe(original);
        expect(buffer.undo()).toBe(false);
        editor.redo();
        expect(editor.getText()).toBe(expected);
      } finally {
        editor.destroy();
        await service?.dispose();
      }
    });
  }
});
