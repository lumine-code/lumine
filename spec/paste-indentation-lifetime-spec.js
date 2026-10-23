const TextEditor = require("../src/text-editor");
const { setTimeout, clearTimeout } = require("node:timers");
const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

for (const batched of [false, true])
  describe(`Deferred paste indentation (batch ${batched})`, () => {
    let editor, mode, marker, release, gate;
    beforeEach(() => {
      editor = new TextEditor({ tabLength: 4, softTabs: true });
      editor.setText("first\nsecond\noutside\n");
      mode = editor.getBuffer().getLanguageMode();
      mode.atTransactionEnd = () => Promise.resolve();
      marker = editor.markBufferRange([
        [0, 0],
        [2, 0],
      ]);
      gate = new Promise((resolve) => {
        release = resolve;
      });
      mode.suggestedIndentForBufferRows = () => gate;
      if (batched) mode.suggestedIndentForPastedRanges = () => gate;
    });
    afterEach(() => {
      release(new Map());
      editor.destroy();
    });
    const adjust = () =>
      editor.adjustPastedIndentation([{ marker, options: { isPastedText: true } }], mode);

    for (const change of ["tabLength", "softTabs", "epoch", "readOnly"]) {
      it(`discards hints prepared before ${change} changes`, async () => {
        let epoch = 1;
        mode.getSyntaxRequestEpoch = () => epoch;
        const pending = adjust();
        await Promise.resolve();
        if (change === "tabLength") editor.setTabLength(8);
        if (change === "softTabs") editor.setSoftTabs(false);
        if (change === "epoch") epoch++;
        if (change === "readOnly") editor.setReadOnly(true);
        release(
          new Map([
            [0, 2],
            [1, 2],
          ]),
        );
        await pending;
        expect(editor.getText()).toBe("first\nsecond\noutside\n");
        expect(marker.isDestroyed()).toBe(true);
      });
    }
    it("retains an explicit read-only bypass for the correction", async () => {
      editor.setReadOnly(true);
      const pending = editor.adjustPastedIndentation(
        [{ marker, options: { isPastedText: true, bypassReadOnly: true } }],
        mode,
      );
      release(
        new Map([
          [0, 1],
          [1, 1],
        ]),
      );
      await pending;
      expect(editor.getText()).toBe("    first\n    second\noutside\n");
      expect(marker.isDestroyed()).toBe(true);
    });
    it("does not indent rows outside the pasted range", async () => {
      const pending = adjust();
      release(
        new Map([
          [0, 1],
          [1, 1],
          [2, 9],
        ]),
      );
      await pending;
      expect(editor.getText()).toBe("    first\n    second\noutside\n");
    });

    it("does not absorb an observer's edit into paste undo or continue adjusting later ranges", async () => {
      const second = editor.markBufferRange([
        [2, 0],
        [2, 7],
      ]);
      const group = spyOn(editor.getBuffer(), "groupLastChanges").and.callThrough();
      let edited = false;
      const subscription = editor.getBuffer().onDidApplyChanges(() => {
        if (!edited) {
          edited = true;
          editor.getBuffer().append("typed");
        }
      });
      try {
        const pending = editor.adjustPastedIndentation(
          [
            { marker, options: {} },
            { marker: second, options: {} },
          ],
          mode,
        );
        release(
          new Map([
            [0, 1],
            [1, 1],
            [2, 9],
          ]),
        );
        await pending;
        expect(editor.getText()).toBe(
          "    first\n    second\n" + (batched ? " ".repeat(36) : "") + "outside\ntyped",
        );
        expect(group).not.toHaveBeenCalled();
        expect(second.isDestroyed()).toBe(true);
      } finally {
        subscription.dispose();
        second.destroy();
      }
    });

    it("reports genuine planning errors and still releases its markers", async () => {
      const error = new Error("Indentation query failed");
      mode.suggestedIndentForBufferRows = () => Promise.reject(error);
      if (batched) mode.suggestedIndentForPastedRanges = () => Promise.reject(error);
      spyOn(console, "error");
      await expectAsync(adjust()).toBeRejectedWith(error);
      expect(marker.isDestroyed()).toBe(true);
      expect(editor.hasPendingIndentation()).toBe(false);
    });
    for (const change of ["destroy", "grammar", "edit"]) {
      it(`releases its markers and waiter after ${change} without waiting for hints`, async () => {
        const pending = adjust();
        await Promise.resolve();
        if (change === "destroy") editor.destroy();
        if (change === "grammar") editor.getBuffer().setLanguageMode(null);
        if (change === "edit") editor.getBuffer().append("typed");
        let timer;
        try {
          const result = await Promise.race([
            pending.then(() => true),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 50);
            }),
          ]);
          expect(result).toBe(true);
          expect(marker.isDestroyed()).toBe(true);
          expect(editor.hasPendingIndentation()).toBe(false);
        } finally {
          clearTimeout(timer);
          release(new Map());
          await pending;
        }
      });
    }
  });

describe("Pasting into multiple worker-backed selections", () => {
  it("uses planned indentation from earlier adjacent pasted ranges", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor();
    try {
      editor.setText("if (ready) {\nif (nested) {\nvalue();\n}\n}\n");
      const mode = new WorkerMode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("source.js"),
        service,
      });
      editor.getBuffer().setLanguageMode(mode);
      await editor.whenGrammarSettled();
      const revision = editor.getBuffer().getTextRevision();
      const plan = await mode.suggestedIndentForPastedRanges(
        [3, 2, 1].map((row) => ({ startRow: row, endRow: row })),
        2,
      );
      expect([...plan]).toEqual([
        [1, 1],
        [2, 2],
        [3, 1],
      ]);
      expect(editor.getBuffer().getTextRevision()).toBe(revision);
    } finally {
      editor.destroy();
      await service.dispose();
    }
  });
  for (const count of [1, 8, 128]) {
    it(`indents ${count} pasted ranges and retains one undo/redo step`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-javascript");
      const service = new Service(lumine.grammars);
      const editor = lumine.workspace.buildTextEditor({ tabLength: 2, softTabs: true });
      const original = "function work() {\n\n}\n".repeat(count);
      const expected = "function work() {\n  value();\n  next();\n}\n".repeat(count);
      try {
        editor.setText(original);
        editor.getBuffer().setLanguageMode(
          new WorkerMode({
            buffer: editor.getBuffer(),
            grammar: lumine.grammars.grammarForScopeName("source.js"),
            service,
          }),
        );
        await editor.whenGrammarSettled();
        const mode = editor.getBuffer().getLanguageMode();
        const plans = spyOn(mode, "suggestedIndentForPastedRanges").and.callThrough();
        editor.setSelectedBufferRanges(
          Array.from({ length: count }, (_, i) => [
            [i * 3 + 1, 0],
            [i * 3 + 1, 0],
          ]),
        );
        editor.getBuffer().clearUndoStack();
        await editor.pasteText({
          autoIndent: true,
          clipboard: { readWithMetadata: () => ({ text: "value();\nnext();" }) },
        });
        await editor.whenGrammarSettled();
        const actualLines = editor.getText().split("\n"),
          expectedLines = expected.split("\n");
        const wrong = actualLines.flatMap((line, row) =>
          line === expectedLines[row] ? [] : [row],
        );
        expect(wrong).toEqual([]);
        expect(plans).toHaveBeenCalledTimes(1);
        expect(editor.hasPendingIndentation()).toBe(false);
        editor.undo();
        expect(editor.getText()).toBe(original);
        editor.redo();
        expect(editor.getText()).toBe(expected);
      } finally {
        editor.destroy();
        await service.dispose();
      }
    });
  }
});
