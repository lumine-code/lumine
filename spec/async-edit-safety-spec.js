const TextEditor = require("../src/text-editor");

describe("Delayed editing operations", () => {
  let editor, release, gate;
  beforeEach(() => {
    editor = new TextEditor({ autoIndent: false });
    editor.setText("first\nsecond\n");
    editor.setSelectedBufferRange([
      [0, 0],
      [0, 5],
    ]);
    editor.getBuffer().clearUndoStack();
    gate = new Promise((resolve) => {
      release = resolve;
    });
  });
  afterEach(() => editor.destroy());

  for (const operation of ["selection comment", "row comment", "batch comment", "paste", "cut"])
    for (const change of ["selection", "edit", "readOnly", "destroy"]) {
      if (operation === "row comment" && change === "selection") continue;
      it(`discards ${operation} after ${change} while its result is pending`, async () => {
        const mode = editor.getBuffer().getLanguageMode();
        mode.asynchronousSyntax = true;
        mode.commentStringsForPosition = () => gate;
        mode.commentStringsForRows = () => gate;
        const comments = { commentStartString: "// " };
        let pending;
        if (operation === "selection comment")
          pending = editor.getLastSelection().toggleLineComments();
        if (operation === "row comment") pending = editor.toggleLineCommentsForBufferRows(0, 0);
        if (operation === "batch comment") pending = editor.toggleLineCommentsInSelection();
        if (operation === "paste")
          pending = editor.pasteText({ clipboard: { readWithMetadata: () => gate } });
        if (operation === "cut")
          pending = editor.getLastSelection().cut(false, false, false, { write: () => gate });
        if (change === "selection")
          editor.setSelectedBufferRange([
            [1, 0],
            [1, 6],
          ]);
        if (change === "edit") editor.getBuffer().append("typed");
        if (change === "readOnly") editor.setReadOnly(true);
        const expected = editor.getText();
        if (change === "destroy") editor.destroy();
        release(
          operation === "batch comment"
            ? new Map([[0, comments]])
            : operation === "paste"
              ? { text: "pasted" }
              : comments,
        );
        await pending;
        if (change !== "destroy") expect(editor.getText()).toBe(expected);
      });
    }

  it("cuts every selection into an asynchronous adapter as one undoable operation", async () => {
    editor.addSelectionForBufferRange([
      [1, 0],
      [1, 6],
    ]);
    let data = { text: "previous" };
    const clipboard = {
      readWithMetadata: async () => data,
      write: jasmine.createSpy("write").and.callFake(async (text, metadata) => {
        await gate;
        data = { text, metadata };
      }),
    };
    const pending = editor.cutSelectedText({ clipboard });
    expect(pending?.then).toBeDefined();
    release();
    await pending;
    expect(data.text).toBe("first\nsecond");
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("\n\n");
    editor.undo();
    expect(editor.getText()).toBe("first\nsecond\n");
    editor.redo();
    expect(editor.getText()).toBe("\n\n");
  });

  for (const operation of ["selection comment", "row comment", "batch comment", "paste", "cut"]) {
    for (const bypassReadOnly of [false, true]) {
      it(`applies current ${operation} atomically with read-only bypass ${bypassReadOnly}`, async () => {
        const mode = editor.getBuffer().getLanguageMode();
        mode.asynchronousSyntax = true;
        mode.commentStringsForPosition = () => gate;
        mode.commentStringsForRows = () => gate;
        const options = { bypassReadOnly };
        if (bypassReadOnly) editor.setReadOnly(true);
        let pending;
        if (operation === "selection comment")
          pending = editor.getLastSelection().toggleLineComments(options);
        if (operation === "row comment")
          pending = editor.toggleLineCommentsForBufferRows(0, 0, options);
        if (operation === "batch comment") pending = editor.toggleLineCommentsInSelection(options);
        if (operation === "paste")
          pending = editor.pasteText({ ...options, clipboard: { readWithMetadata: () => gate } });
        if (operation === "cut")
          pending = editor
            .getLastSelection()
            .cut(false, false, bypassReadOnly, { write: () => gate });
        const comments = { commentStartString: "// " };
        release(
          operation === "batch comment"
            ? new Map([[0, comments]])
            : operation === "paste"
              ? { text: "pasted" }
              : comments,
        );
        await pending;
        const expected =
          operation === "paste"
            ? "pasted\nsecond\n"
            : operation === "cut"
              ? "\nsecond\n"
              : "// first\nsecond\n";
        expect(editor.getText()).toBe(expected);
        editor.undo(options);
        expect(editor.getText()).toBe("first\nsecond\n");
        editor.redo(options);
        expect(editor.getText()).toBe(expected);
      });
    }
  }

  for (const operation of ["selection", "rows", "batch"]) {
    for (const change of ["epoch", "grammar"]) {
      it(`discards ${operation} comments after a syntax ${change} change without editing text`, async () => {
        const mode = editor.getBuffer().getLanguageMode();
        mode.asynchronousSyntax = true;
        mode.commentStringsForPosition = () => gate;
        mode.commentStringsForRows = () => gate;
        let epoch = 1;
        mode.getSyntaxRequestEpoch = () => epoch;
        const pending =
          operation === "selection"
            ? editor.getLastSelection().toggleLineComments()
            : operation === "rows"
              ? editor.toggleLineCommentsForBufferRows(0, 0)
              : editor.toggleLineCommentsInSelection();
        if (change === "epoch") epoch++;
        else editor.getBuffer().setLanguageMode(null);
        const comments = { commentStartString: "// " };
        release(operation === "batch" ? new Map([[0, comments]]) : comments);
        await pending;
        expect(editor.getText()).toBe("first\nsecond\n");
      });
    }
  }

  it("keeps explicit row comments independent of cursor movement", async () => {
    const mode = editor.getBuffer().getLanguageMode();
    mode.asynchronousSyntax = true;
    mode.commentStringsForPosition = () => gate;
    const pending = editor.toggleLineCommentsForBufferRows(0, 0);
    editor.setCursorBufferPosition([1, 3]);
    release({ commentStartString: "// " });
    await pending;
    expect(editor.getText()).toBe("// first\nsecond\n");
    expect(editor.getCursorBufferPosition()).toEqual([1, 3]);
  });

  for (const command of [
    "copySelectedText",
    "copyOnlySelectedText",
    "cutSelectedText",
    "cutToEndOfLine",
    "cutToEndOfBufferLine",
  ]) {
    it(`waits for ${command}'s adapter write before flushing and propagates failure`, async () => {
      editor.addSelectionForBufferRange([
        [1, 0],
        [1, 6],
      ]);
      const error = new Error("Clipboard unavailable");
      const clipboard = {
        write: jasmine.createSpy("write").and.returnValue(gate),
        flush: jasmine.createSpy("flush").and.callFake(() => Promise.reject(error)),
      };
      const pending = command.startsWith("copy")
        ? editor[command](clipboard)
        : editor[command]({ clipboard });
      expect(clipboard.write).toHaveBeenCalledTimes(1);
      expect(clipboard.write.calls.first().args[0]).toBe("first\nsecond");
      expect(clipboard.flush).not.toHaveBeenCalled();
      release();
      await expectAsync(pending).toBeRejectedWith(error);
      expect(clipboard.flush).toHaveBeenCalledTimes(1);
    });
  }
});
