const EditorWindow = require("../src/editor-window");
const { Disposable } = require("lumine");

describe("EditorWindow", () => {
  it("binds the main presentation to its document container and docks", () => {
    const workspace = lumine.workspace;
    const main = workspace.getMainWindow();
    expect(main.isMain()).toBeTrue();
    expect(main.getWorkspace()).toBe(workspace);
    expect(main.getEditorContainer()).toBe(workspace.getCenter().paneContainer);
    expect(main.getDocument()).toBe(document);
    expect(main.getElement()).toBe(workspace.getElement());
    expect(workspace.getLeftDock().paneContainer.getWindow()).toBe(main);
    expect(workspace.getRightDock().paneContainer.getWindow()).toBe(main);
    expect(workspace.getBottomDock().paneContainer.getWindow()).toBe(main);
  });

  it("observes future windows and removes them without destroying their documents", () => {
    const workspace = lumine.workspace;
    const seen = [];
    const observation = workspace.observeWindows((editorWindow) => seen.push(editorWindow));
    const container = { editorWindow: null };
    const presentation = new EditorWindow({
      workspace,
      editorContainer: container,
      windowService: { getId: () => 123 },
    });
    workspace.registerEditorWindow(presentation);
    expect(seen).toEqual([workspace.getMainWindow(), presentation]);
    expect(workspace.getWindows()).toContain(presentation);
    presentation.destroy();
    expect(workspace.getWindows()).not.toContain(presentation);
    expect(workspace.getWindows()).toEqual([workspace.getMainWindow()]);
    observation.dispose();
  });

  it("completes presentation cleanup when a client fails during teardown", () => {
    const container = { editorWindow: null };
    const presentation = new EditorWindow({
      workspace: lumine.workspace,
      editorContainer: container,
      windowService: {},
    });
    presentation.setPresentation(window, document.createElement("div"));
    const released = jasmine.createSpy("released");
    const destroyed = jasmine.createSpy("destroyed");
    presentation.subscriptions.add(new Disposable(released));
    presentation.onWillDestroy(() => {
      throw new Error("client teardown failed");
    });
    presentation.onDidDestroy(destroyed);
    expect(() => presentation.destroy()).toThrowError("client teardown failed");
    expect(released).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(presentation.getDocument()).toBeNull();
    expect(presentation.getElement()).toBeNull();
    presentation.destroy();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("attaches open dialogs to the addressed presentation and returns its result", async () => {
    const options = { title: "Open", properties: ["openFile"] };
    const selected = { canceled: false, filePaths: ["chosen.txt"] };
    const canceled = { canceled: true, filePaths: [] };
    const services = [
      { showOpenDialog: jasmine.createSpy("main dialog").and.resolveTo(selected) },
      { showOpenDialog: jasmine.createSpy("auxiliary dialog").and.resolveTo(canceled) },
    ];
    const presentations = services.map(
      (windowService) =>
        new EditorWindow({
          workspace: lumine.workspace,
          editorContainer: { editorWindow: null },
          windowService,
        }),
    );
    try {
      expect(await presentations[0].showOpenDialog(options)).toBe(selected);
      expect(await presentations[1].showOpenDialog()).toBe(canceled);
      expect(services[0].showOpenDialog).toHaveBeenCalledOnceWith(options);
      expect(services[1].showOpenDialog).toHaveBeenCalledOnceWith({});
    } finally {
      for (const presentation of presentations) presentation.destroy();
    }
  });

  for (const main of [true, false]) {
    it(`subscribes to applied zoom state in its ${main ? "main" : "detached"} presentation`, () => {
      const subscription = new Disposable();
      const windowService = {
        onDidChangeZoomState: jasmine
          .createSpy("onDidChangeZoomState")
          .and.returnValue(subscription),
      };
      const presentation = new EditorWindow({
        workspace: lumine.workspace,
        editorContainer: { editorWindow: null },
        windowService,
        main,
      });
      try {
        const callback = jasmine.createSpy("zoom state changed");
        expect(presentation.onDidChangeZoomState(callback)).toBe(subscription);
        expect(windowService.onDidChangeZoomState).toHaveBeenCalledOnceWith(callback);
      } finally {
        presentation.destroy();
        subscription.dispose();
      }
    });

    it(`subscribes to zoom changes in its ${main ? "main" : "detached"} native presentation`, () => {
      const subscription = new Disposable();
      const windowService = {
        onDidChangeZoomFactor: jasmine
          .createSpy("onDidChangeZoomFactor")
          .and.returnValue(subscription),
      };
      const presentation = new EditorWindow({
        workspace: lumine.workspace,
        editorContainer: { editorWindow: null },
        windowService,
        main,
      });
      try {
        const callback = jasmine.createSpy("zoom changed");
        expect(presentation.onDidChangeZoomFactor(callback)).toBe(subscription);
        expect(windowService.onDidChangeZoomFactor).toHaveBeenCalledOnceWith(callback);
      } finally {
        presentation.destroy();
        subscription.dispose();
      }
    });

    it(`returns zoom results from its ${main ? "main" : "detached"} native presentation`, async () => {
      const windowService = {
        getZoomFactor: jasmine.createSpy("getZoomFactor").and.resolveTo(1.2),
        getZoomState: jasmine
          .createSpy("getZoomState")
          .and.resolveTo({ factor: 1.2, defaultFactor: 1.1 }),
        zoomIn: jasmine.createSpy("zoomIn").and.resolveTo(1.3),
        zoomOut: jasmine.createSpy("zoomOut").and.resolveTo(1.2),
        resetZoom: jasmine.createSpy("resetZoom").and.resolveTo(1.1),
      };
      const presentation = new EditorWindow({
        workspace: lumine.workspace,
        editorContainer: { editorWindow: null },
        windowService,
        main,
      });
      try {
        expect(await presentation.getZoomFactor()).toBe(1.2);
        expect(await presentation.getZoomState()).toEqual({ factor: 1.2, defaultFactor: 1.1 });
        expect(await presentation.zoomIn()).toBe(1.3);
        expect(await presentation.zoomOut()).toBe(1.2);
        expect(await presentation.resetZoom()).toBe(1.1);
        for (const method of Object.values(windowService)) {
          expect(method).toHaveBeenCalledOnceWith();
        }
      } finally {
        presentation.destroy();
      }
    });
  }
});
