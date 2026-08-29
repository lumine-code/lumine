const TextEditor = require("../src/text-editor");

describe("WorkspaceCenter", () => {
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

    it("continues to expose a detached editor without observing it a second time", () => {
      const workspaceCenter = lumine.workspace.getCenter();
      const tiledPane = workspaceCenter.getActiveTiledPane();
      const editor = new TextEditor();
      tiledPane.activateItem(editor);
      const observed = [];
      workspaceCenter.observeTextEditors((candidate) => observed.push(candidate));

      const detachedPane = workspaceCenter.detachPaneItem(editor);

      expect(observed).toEqual([editor]);
      expect(workspaceCenter.getPaneItems()).toContain(editor);
      expect(workspaceCenter.getTextEditors()).toContain(editor);
      expect(workspaceCenter.paneForItem(editor)).toBe(detachedPane);
      expect(workspaceCenter.getTiledPanes()).toEqual([tiledPane]);
      expect(workspaceCenter.getDetachedPanes()).toEqual([detachedPane]);
      expect(workspaceCenter.getActivePane()).toBe(detachedPane);
      expect(workspaceCenter.getActiveTiledPane()).toBe(tiledPane);
    });
  });
});
