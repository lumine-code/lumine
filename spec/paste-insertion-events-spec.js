const TextEditor = require("../src/text-editor");

describe("Paste insertion notifications", () => {
  let editor, mode, release, fail, gate, events;
  beforeEach(() => {
    editor = new TextEditor({ autoIndent: true });
    editor.setText("\n\n");
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 0],
      ],
      [
        [1, 0],
        [1, 0],
      ],
    ]);
    mode = editor.getBuffer().getLanguageMode();
    mode.atTransactionEnd = () => Promise.resolve();
    gate = new Promise((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    mode.suggestedIndentForBufferRows = () => gate;
    events = [];
    editor.onDidInsertText((event) =>
      events.push({
        text: event.text,
        range: event.range.serialize(),
        observed: editor.getTextInBufferRange(event.range),
      }),
    );
  });
  afterEach(() => {
    release(new Map());
    editor.destroy();
  });
  const paste = () =>
    editor.pasteText({
      autoIndent: true,
      clipboard: { readWithMetadata: () => ({ text: "foo();\nbar();" }) },
    });

  for (const action of ["settle", "edit", "grammar", "failure"]) {
    it(`notifies every insertion before correction and preserves it after ${action}`, async () => {
      const pending = paste();
      expect(events.length).toBe(2);
      expect(
        events.every((event) => event.text === event.observed && event.text === "foo();\nbar();"),
      ).toBe(true);
      if (action === "edit") editor.getBuffer().append("// later");
      if (action === "grammar") editor.getBuffer().setLanguageMode(null);
      if (action === "failure") {
        spyOn(console, "error");
        // Let the correction enter the provider before rejecting its response.
        await Promise.resolve();
        const error = new Error("Indent query failed");
        fail(error);
        await expectAsync(pending).toBeRejectedWith(error);
      } else {
        release(
          new Map([
            [0, 1],
            [1, 1],
            [3, 1],
            [4, 1],
          ]),
        );
        await pending;
      }
      expect(events.length).toBe(2);
    });
  }

  it("delivers later insertions when an earlier insertion observer edits the buffer", async () => {
    let inserted = false;
    editor.onDidInsertText(() => {
      if (!inserted) {
        inserted = true;
        editor.getBuffer().append("// observer");
      }
    });
    const pending = paste();
    release(new Map());
    await pending;
    expect(events.length).toBe(2);
    expect(editor.getText().endsWith("// observer")).toBe(true);
  });
});

describe("Whitespace-only paste with the whitespace package", () => {
  it("does not recreate whitespace removed by its insertion observer", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("whitespace");
    lumine.config.set("whitespace.removeTrailingWhitespace", true);
    lumine.config.set("whitespace.ignoreWhitespaceOnlyLines", false);
    const editor = await lumine.workspace.open();
    try {
      editor.setText("function work() {\n    \n}\n");
      editor.update({ tabLength: 4, softTabs: true });
      lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.js");
      await editor.whenGrammarSettled();
      editor.setCursorBufferPosition([1, 4]);
      const mode = editor.getBuffer().getLanguageMode();
      const plan = spyOn(mode, "suggestedIndentForPastedRanges").and.callThrough();
      const events = [];
      editor.onDidInsertText((event) => events.push(event.text));
      await editor.pasteText({
        autoIndent: true,
        clipboard: { readWithMetadata: () => ({ text: "\n" }) },
      });
      await editor.whenGrammarSettled();
      expect(editor.getText()).toBe("function work() {\n\n\n}\n");
      expect(plan).not.toHaveBeenCalled();
      expect(events).toEqual(["\n"]);
    } finally {
      editor.destroy();
    }
  });
});
