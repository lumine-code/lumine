const Environment = require("../src/environment");
const EditorWindow = require("../src/editor-window");
const PaneContainer = require("../src/pane-container");

describe("workspace destruction after presentation failures", () => {
  it("finishes every other window and the workspace models before reporting the failure", () => {
    const environment = new Environment({ applicationDelegate: lumine.applicationDelegate });
    environment.configDirPath = lumine.getConfigDirPath();
    environment.workspace.initialize({ configDirPath: environment.configDirPath });
    const workspace = environment.workspace;
    const main = workspace.getMainWindow();
    const container = new PaneContainer(workspace.getCenter().params);
    const extra = new EditorWindow({
      workspace,
      editorContainer: container,
      windowService: environment.window,
    });
    const failure = new Error("Presentation disposal failed");
    extra.onWillDestroy(() => {
      throw failure;
    });
    spyOn(workspace, "getWindows").and.returnValue([extra, main]);
    const destroyMain = spyOn(main, "destroy").and.callThrough();
    const destroyCenter = spyOn(workspace.paneContainers.center, "destroy").and.callThrough();
    const closeStore = spyOn(workspace, "closeStateStore").and.callThrough();
    try {
      expect(() => workspace.destroy()).toThrow(failure);
      expect(destroyMain).toHaveBeenCalledTimes(1);
      expect(destroyCenter).toHaveBeenCalledTimes(1);
      expect(closeStore).toHaveBeenCalledTimes(1);
    } finally {
      main.destroy();
      container.destroy();
      environment.destroy();
    }
  });
});
