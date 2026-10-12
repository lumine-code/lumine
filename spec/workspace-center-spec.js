const { copyableElement } = require("./helpers/pane-item-fixtures");
const TextEditor = require("../src/text-editor");
const PaneContainer = require("../src/pane-container");

describe("WorkspaceCenter", () => {
  describe("multiple document containers", () => {
    let center, container;

    beforeEach(() => {
      center = lumine.workspace.getCenter();
      container = new PaneContainer(center.params);
    });

    afterEach(() => {
      center.removePaneContainer(container);
      container.destroy();
    });

    it("observes panes and documents in containers created after subscription", () => {
      const panes = [];
      const editors = [];
      const observedPanes = lumine.workspace.observePanes((pane) => panes.push(pane));
      const observedEditors = lumine.workspace.observeTextEditors((editor) => editors.push(editor));
      center.addPaneContainer(container);
      const pane = container.getActivePane();
      const editor = new TextEditor();
      pane.activateItem(editor);

      expect(panes.filter((candidate) => candidate === pane)).toEqual([pane]);
      expect(editors.filter((candidate) => candidate === editor)).toEqual([editor]);
      expect(lumine.workspace.getTextEditors()).toContain(editor);
      expect(lumine.workspace.paneForItem(editor)).toBe(pane);
      observedPanes.dispose();
      observedEditors.dispose();
    });

    it("keeps local active panes while following the last activated container globally", () => {
      const mainPane = center.paneContainer.getActivePane();
      const mainEditor = new TextEditor();
      mainPane.activateItem(mainEditor);
      center.addPaneContainer(container);
      const auxiliaryPane = container.getActivePane();
      const auxiliaryEditor = new TextEditor();
      auxiliaryPane.activateItem(auxiliaryEditor, { activatePane: true });

      expect(center.getActiveTextEditor()).toBe(auxiliaryEditor);
      expect(lumine.workspace.getActiveTextEditor()).toBe(auxiliaryEditor);
      expect(center.paneContainer.getActivePaneItem()).toBe(mainEditor);

      mainPane.activate();
      expect(center.getActiveTextEditor()).toBe(mainEditor);
      expect(container.getActivePaneItem()).toBe(auxiliaryEditor);
    });

    it("does not let a background tab change replace the active document", () => {
      center.addPaneContainer(container);
      const pane = container.getActivePane();
      const first = new TextEditor();
      const second = new TextEditor();
      pane.addItem(first);
      pane.addItem(second);
      const mainPane = center.paneContainer.getActivePane();
      const main = new TextEditor();
      mainPane.activateItem(main);
      const changes = [];
      const subscription = center.onDidChangeActivePaneItem((item) => changes.push(item));
      pane.activateItem(second, { activatePane: false });

      expect(center.getActivePaneItem()).toBe(main);
      expect(changes).toEqual([]);
      subscription.dispose();
    });

    it("removes closed containers from discovery and restores the main context", () => {
      center.addPaneContainer(container);
      const editor = new TextEditor();
      container.getActivePane().activateItem(editor, { activatePane: true });
      center.removePaneContainer(container);

      expect(center.getPaneContainers()).toEqual([center.paneContainer]);
      expect(center.getActivePane()).toBe(center.paneContainer.getActivePane());
      expect(center.getPaneItems()).not.toContain(editor);
    });
  });

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
      const nonEditorItemAddedBeforeRegisteringObserver = copyableElement("div");
      pane.activateItem(editorAddedBeforeRegisteringObserver);
      pane.activateItem(nonEditorItemAddedBeforeRegisteringObserver);

      workspaceCenter.observeTextEditors((editor) => observed.push(editor));

      const editorAddedAfterRegisteringObserver = new TextEditor();
      const nonEditorItemAddedAfterRegisteringObserver = copyableElement("div");
      pane.activateItem(editorAddedAfterRegisteringObserver);
      pane.activateItem(nonEditorItemAddedAfterRegisteringObserver);

      expect(observed).toEqual([
        editorAddedBeforeRegisteringObserver,
        editorAddedAfterRegisteringObserver,
      ]);
    });
  });
});
