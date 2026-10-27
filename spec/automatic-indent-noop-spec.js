const TextEditor = require("../src/text-editor");

describe("Automatic indentation identity changes", () => {
  let editor;
  beforeEach(() => {
    editor = new TextEditor({ tabLength: 2, softTabs: true });
  });
  afterEach(() => editor.destroy());

  for (const preserveLeadingWhitespace of [false, true])
    it(`skips an identical replaced prefix with preserveLeadingWhitespace=${preserveLeadingWhitespace}`, () => {
      editor.setText("  value\n");
      editor.getBuffer().clearUndoStack();
      const buffer = editor.getBuffer(),
        revision = buffer.getTextRevision();
      const marker = buffer.markRange(
        [
          [0, 0],
          [0, 2],
        ],
        { invalidate: "touch" },
      );
      let changes = 0,
        markers = 0;
      buffer.onDidApplyChanges(() => changes++);
      marker.onDidChange(() => markers++);
      const range = editor.setIndentationForBufferRow(0, preserveLeadingWhitespace ? 0 : 1, {
        preserveLeadingWhitespace,
      });
      expect(range.serialize()).toEqual([
        [0, 0],
        [0, preserveLeadingWhitespace ? 0 : 2],
      ]);
      expect(buffer.getTextRevision()).toBe(revision);
      expect(changes).toBe(0);
      expect(markers).toBe(0);
      expect(marker.isValid()).toBe(true);
      expect(buffer.undo()).toBe(false);
    });

  it("lets an explicit setter normalize tabs and preserves additive leading whitespace", () => {
    editor.setText("\tvalue");
    editor.getBuffer().clearUndoStack();
    editor.setIndentationForBufferRow(0, 1);
    expect(editor.getText()).toBe("  value");
    editor.setIndentationForBufferRow(0, 1, { preserveLeadingWhitespace: true });
    expect(editor.getText()).toBe("    value");
    editor.undo();
    expect(editor.getText()).toBe("  value");
    editor.undo();
    expect(editor.getText()).toBe("\tvalue");
  });

  for (const asynchronous of [false, true])
    for (const prefix of ["  ", "\t"])
      it(`does not normalize equal indentation during typing (async=${asynchronous}, prefix=${JSON.stringify(prefix)})`, async () => {
        editor.setText(prefix + "word");
        editor.getBuffer().clearUndoStack();
        const mode = editor.getBuffer().getLanguageMode();
        mode.suggestedIndentForEditedBufferRow = () => (asynchronous ? Promise.resolve(1) : 1);
        const buffer = editor.getBuffer(),
          revision = buffer.getTextRevision();
        let changes = 0;
        buffer.onDidApplyChanges(() => changes++);
        await editor.autoDecreaseIndentForBufferRow(0);
        expect(editor.getText()).toBe(prefix + "word");
        expect(changes).toBe(0);
        expect(buffer.getTextRevision()).toBe(revision);
      });

  it("still performs a real dedent and rejects hints for obsolete tab settings", async () => {
    editor.setText("    }");
    editor.getBuffer().clearUndoStack();
    const mode = editor.getBuffer().getLanguageMode();
    mode.suggestedIndentForEditedBufferRow = () => Promise.resolve(1);
    await editor.autoDecreaseIndentForBufferRow(0);
    expect(editor.getText()).toBe("  }");
    editor.undo();
    expect(editor.getText()).toBe("    }");
    let release;
    mode.suggestedIndentForEditedBufferRow = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = editor.autoDecreaseIndentForBufferRow(0);
    editor.setTabLength(4);
    release(0);
    await pending;
    expect(editor.getText()).toBe("    }");
  });
});
