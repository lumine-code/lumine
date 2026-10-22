const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");

describe("Tab indentation with worker syntax", () => {
  let service, editor, mode;
  const source = "if (outer) {\n    if (inner) {\nvalue();\n    }\n}\n";
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    service = new Service(lumine.grammars);
    editor = lumine.workspace.buildTextEditor({ autoIndent: true, tabLength: 4, softTabs: true });
    editor.setText(source);
    mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    await mode.ready;
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    editor.setCursorBufferPosition([2, 0]);
    editor.getBuffer().clearUndoStack();
    // The previous implementation dropped this promise. Observe its rejection
    // so the semantic regression fails without an unrelated unhandled error.
    const suggest = mode.suggestedIndentForBufferRow.bind(mode);
    spyOn(mode, "suggestedIndentForBufferRow").and.callFake((...args) => {
      const result = suggest(...args);
      result.catch(() => {});
      return result;
    });
  });
  afterEach(() => {
    editor.destroy();
    service.dispose();
  });

  it("uses the suggested indentation instead of subtracting a promise from the cursor column", async () => {
    await editor.indent({ autoIndent: true });
    await editor.whenGrammarSettled();
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
    expect(editor.getCursorBufferPosition()).toEqual([2, 8]);
    editor.undo();
    expect(editor.getText()).toBe(source);
  });

  it("does not request syntax for a manual Tab", () => {
    editor.indent({ autoIndent: false });
    expect(editor.lineTextForBufferRow(2)).toBe("    value();");
    expect(mode.suggestedIndentForBufferRow).not.toHaveBeenCalled();
  });

  it("inserts a literal tab stop inside text synchronously without requesting syntax", () => {
    editor.setCursorBufferPosition([2, 1]);
    const plan = spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callThrough();
    editor.indent({ autoIndent: true });
    expect(editor.lineTextForBufferRow(2)).toBe("v   alue();");
    expect(editor.getCursorBufferPosition()).toEqual([2, 4]);
    expect(plan).not.toHaveBeenCalled();
    expect(mode.suggestedIndentForBufferRow).not.toHaveBeenCalled();
  });

  it("plans multiple cursors in one request and keeps one undo entry", async () => {
    editor.setText(source.repeat(2));
    await editor.whenGrammarSettled();
    editor.setSelectedBufferRanges([
      [
        [2, 0],
        [2, 0],
      ],
      [
        [7, 0],
        [7, 0],
      ],
    ]);
    editor.getBuffer().clearUndoStack();
    const plan = spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callThrough();
    await editor.indent({ autoIndent: true });
    await editor.whenGrammarSettled();
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
    expect(editor.lineTextForBufferRow(7)).toBe("        value();");
    expect(plan).toHaveBeenCalledTimes(1);
    expect(mode.suggestedIndentForBufferRow).not.toHaveBeenCalled();
    editor.undo();
    expect(editor.getText()).toBe(source.repeat(2));
  });

  it("supports the direct Selection.indent API", async () => {
    await editor.getLastSelection().indent({ autoIndent: true });
    await editor.whenGrammarSettled();
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
  });

  it("awaits scalar-only asynchronous language modes for every cursor", async () => {
    const NullMode = require("../src/null-language-mode");
    editor.setText(source.repeat(2));
    const scalar = new NullMode({ buffer: editor.getBuffer() });
    scalar.suggestedIndentForBufferRow = () => ({
      then(resolve) {
        resolve(2);
      },
    });
    editor.getBuffer().setLanguageMode(scalar);
    editor.setSelectedBufferRanges([
      [
        [2, 0],
        [2, 0],
      ],
      [
        [7, 0],
        [7, 0],
      ],
    ]);
    await editor.indent({ autoIndent: true });
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
    expect(editor.lineTextForBufferRow(7)).toBe("        value();");
  });

  it("reindents disjoint selections from one revision instead of invalidating later requests", async () => {
    editor.setText(source.repeat(2));
    await editor.whenGrammarSettled();
    editor.setSelectedBufferRanges([
      [
        [2, 0],
        [2, 8],
      ],
      [
        [7, 0],
        [7, 8],
      ],
    ]);
    editor.getBuffer().clearUndoStack();
    const plan = spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callThrough();
    await editor.autoIndentSelectedRows();
    await editor.whenGrammarSettled();
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
    expect(editor.lineTextForBufferRow(7)).toBe("        value();");
    expect(plan).toHaveBeenCalledTimes(1);
    editor.undo();
    expect(editor.getText()).toBe(source.repeat(2));
  });

  it("does not reindent an editor that becomes read-only while its plan is pending", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.returnValue(gate);
    const pending = editor.autoIndentBufferRowsAtRows([2]);
    editor.setReadOnly(true);
    release(new Map([[2, 2]]));
    await pending;
    expect(editor.getText()).toBe(source);
  });

  it("honors an explicit read-only bypass for selected-row indentation", async () => {
    editor.setReadOnly(true);
    await editor.autoIndentSelectedRows({ bypassReadOnly: true });
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
  });

  it("coalesces repeated pending Tabs without losing their indentation or undo grouping", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const plan = spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.returnValue(gate);
    const first = editor.indent({ autoIndent: true });
    const second = editor.indent({ autoIndent: true });
    expect(editor.getText()).toBe(source);
    expect(editor.getCursorBufferPosition()).toEqual([2, 0]);
    expect(plan).toHaveBeenCalledTimes(1);
    release(new Map([[2, 2]]));
    await Promise.all([first, second]);
    expect(editor.lineTextForBufferRow(2)).toBe("            value();");
    editor.undo();
    expect(editor.getText()).toBe(source);
  });

  it("uses hard tabs for the planned indentation", async () => {
    editor.setSoftTabs(false);
    await editor.indent({ autoIndent: true });
    expect(editor.lineTextForBufferRow(2)).toBe("\t\tvalue();");
    expect(editor.getCursorBufferPosition()).toEqual([2, 2]);
  });

  it("releases a superseded Tab without waiting for its provider and keeps the new intent", async () => {
    const releases = [];
    spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.callFake(
      () => new Promise((resolve) => releases.push(resolve)),
    );
    const first = editor.indent({ autoIndent: true });
    const second = editor.indent({ autoIndent: true, bypassReadOnly: true });
    let finished = false;
    first.then(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toBe(true);
    releases[1](new Map([[2, 2]]));
    releases[0](new Map([[2, 0]]));
    await Promise.all([first, second]);
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
  });

  it("awaits automatic indentation through the editor command and preserves undo", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.workspace.open(editor);
    editor.setCursorBufferPosition([2, 0]);
    editor.update({ autoIndent: true, tabLength: 4, softTabs: true });
    expect(editor.getGrammar().scopeName).toBe("source.js");
    await lumine.commands.dispatch(editor.getElement(), "editor:indent");
    expect(editor.lineTextForBufferRow(2)).toBe("        value();");
    editor.undo();
    expect(editor.getText()).toBe(source);
  });

  for (const action of ["typing", "cursor", "grammar", "destroy", "tabLength", "readOnly"]) {
    it(`does not apply a late Tab after ${action}`, async () => {
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      spyOn(mode, "suggestedIndentForBufferRowsAtRows").and.returnValue(gate);
      const pending = editor.indent({ autoIndent: true });
      if (action === "typing") editor.insertText("typed");
      if (action === "cursor") editor.setCursorBufferPosition([0, 0]);
      if (action === "grammar") editor.setGrammar(lumine.grammars.nullGrammar);
      if (action === "tabLength") editor.setTabLength(2);
      if (action === "readOnly") editor.setReadOnly(true);
      const expected = editor.getText();
      if (action === "destroy") editor.destroy();
      // Closing a view, changing grammar, typing or moving the cursor must
      // release the editor's pending operation even if a provider never replies.
      if (["typing", "cursor", "grammar", "destroy"].includes(action)) await pending;
      release(new Map([[2, 2]]));
      await pending;
      if (action !== "destroy") expect(editor.getText()).toBe(expected);
      expect(editor.pendingTabIndentIntent).toBeNull();
      expect(editor.pendingIndentationPromises.size).toBe(0);
    });
  }
});
