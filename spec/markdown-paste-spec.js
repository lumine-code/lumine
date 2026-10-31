const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

for (const worker of [false, true])
  describe(`Pasting preserves source whitespace (${worker ? "worker" : "inline"})`, () => {
    let editor, service;
    const contributing =
      "## Contributing\n\nGot ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!";

    beforeEach(async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-gfm");
      editor = await lumine.workspace.open();
      editor.update({ tabLength: 2, softTabs: true, autoIndent: true });
      service = worker ? new Service(lumine.grammars) : null;
    });

    afterEach(async () => {
      editor?.destroy();
      await service?.dispose();
    });

    async function start(text, scope = "source.gfm") {
      editor.setText(text);
      if (worker)
        editor.getBuffer().setLanguageMode(
          new WorkerMode({
            buffer: editor.getBuffer(),
            grammar: lumine.grammars.grammarForScopeName(scope),
            service,
          }),
        );
      else lumine.grammars.assignLanguageMode(editor.getBuffer(), scope);
      await editor.whenGrammarSettled();
      editor.getBuffer().clearUndoStack();
    }

    const paste = (text) => editor.pasteText({ clipboard: { readWithMetadata: () => ({ text }) } });

    for (const fenced of [false, true]) {
      it(`pastes the contributing section ${fenced ? "in a C# fence" : "as prose"}`, async () => {
        const original = fenced ? "```csharp\n\n```\n" : "# Package\n\n";
        const row = fenced ? 1 : 2;
        await start(original);
        editor.setCursorBufferPosition([row, 0]);
        await paste(contributing);
        expect(editor.getText()).toBe(
          fenced ? "```csharp\n" + contributing + "\n```\n" : original + contributing,
        );
        editor.undo();
        expect(editor.getText()).toBe(original);
        editor.redo();
        expect(editor.getText()).toContain(contributing);
      });
    }

    for (const [name, scope] of [
      ["gfm", "source.gfm"],
      ["csv", "source.csv"],
      ["diff", "source.diff"],
      ["sql", "source.sql"],
      ["toml", "source.toml"],
      ["javascript", "source.js"],
      ["python", "source.python"],
    ]) {
      it(`preserves relative whitespace in language-${name}, including hard tabs and blank rows`, async () => {
        await lumine.packages.activatePackage(`language-${name}`);
        const text = "first\n\t  nested\n \t\n  last";
        await start("", scope);
        await paste(text);
        expect(editor.getText()).toBe(text);
        editor.undo();
        expect(editor.getText()).toBe("");
        editor.redo();
        expect(editor.getText()).toBe(text);
      });
    }

    it("publishes multiple Markdown replacements and their insertion events in one undo operation", async () => {
      const original = "old\n\nold\n";
      await start(original);
      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 3],
        ],
        [
          [2, 0],
          [2, 3],
        ],
      ]);
      const events = [],
        publications = [];
      editor.onDidInsertText((event) => events.push(editor.getTextInBufferRange(event.range)));
      editor.getBuffer().onDidApplyChanges(() => publications.push(editor.getText()));
      await paste(contributing);
      const expected = contributing + "\n\n" + contributing + "\n";
      expect(editor.getText()).toBe(expected);
      expect(publications).toEqual([expected]);
      expect(events).toEqual([contributing, contributing]);
      editor.undo();
      expect(editor.getText()).toBe(original);
      editor.redo();
      expect(editor.getText()).toBe(expected);
    });

    it("still applies injected JavaScript indentation inside Markdown", async () => {
      await lumine.packages.activatePackage("language-javascript");
      const original = "```js\nfunction work() {\n\n}\n```\n";
      await start(original);
      editor.setCursorBufferPosition([2, 0]);
      await paste("first();\nnext();");
      expect(editor.getText()).toBe("```js\nfunction work() {\n  first();\n  next();\n}\n```\n");
      editor.undo();
      expect(editor.getText()).toBe(original);
    });

    it("plans prose and injected code independently in the same paste", async () => {
      await lumine.packages.activatePackage("language-javascript");
      const original = "\n\n```js\nfunction work() {\n\n}\n```\n";
      await start(original);
      editor.setSelectedBufferRanges([
        [
          [0, 0],
          [0, 0],
        ],
        [
          [4, 0],
          [4, 0],
        ],
      ]);
      await paste("first();\nnext();");
      expect(editor.getText()).toBe(
        "first();\nnext();\n\n```js\nfunction work() {\n  first();\n  next();\n}\n```\n",
      );
      editor.undo();
      expect(editor.getText()).toBe(original);
    });
  });
