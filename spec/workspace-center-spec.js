const TextEditor = require("../src/text-editor");

describe("WorkspaceCenter", () => {
  it("uses plain text for an untitled editor when the grammar is available", async () => {
    await lumine.packages.activatePackage("language-text");

    const editor = await lumine.workspace.open();
    expect(lumine.workspace.getCenter().getActiveTextEditor()).toBe(editor);
    expect(editor.getGrammar().scopeName).toBe("text.plain");
    expect(lumine.grammars.getAssignedLanguageId(editor.getBuffer())).toBeUndefined();
  });

  it("prefers a matching JUnit report over plain text for .txt files", async () => {
    await lumine.packages.activatePackage("language-text");
    await lumine.packages.activatePackage("language-log");

    const editor = await lumine.workspace.open("report.txt");
    editor.setText("Testsuite: com.example.Sample\nTestcase: passes took 0.12 sec\n");
    lumine.grammars.autoAssignLanguageMode(editor.getBuffer());

    expect(editor.getGrammar().scopeName).toBe("text.junit-test-report");
    expect(editor.getGrammar().packageName).toBe("language-log");
  });

  describe(".observeTextEditors()", () => {
    it("invokes the observer with current and future text editors", () => {
      const workspaceCenter = lumine.workspace.getCenter();
      const pane = workspaceCenter.getActivePane();
      const observed = [];

      const editorAddedBeforeRegisteringObserver = new TextEditor();
      const nonEditorItemAddedBeforeRegisteringObserver = document.createElement("div");
      pane.activateItem(editorAddedBeforeRegisteringObserver);
      pane.activateItem(nonEditorItemAddedBeforeRegisteringObserver);

      workspaceCenter.observeTextEditors((editor) => observed.push(editor));

      const editorAddedAfterRegisteringObserver = new TextEditor();
      const nonEditorItemAddedAfterRegisteringObserver = document.createElement("div");
      pane.activateItem(editorAddedAfterRegisteringObserver);
      pane.activateItem(nonEditorItemAddedAfterRegisteringObserver);

      expect(observed).toEqual([
        editorAddedBeforeRegisteringObserver,
        editorAddedAfterRegisteringObserver,
      ]);
    });
  });
});
