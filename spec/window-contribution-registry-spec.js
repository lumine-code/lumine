const WindowContributionRegistry = require("../src/window-contribution-registry");
const EditorWindow = require("../src/editor-window");

describe("WindowContributionRegistry", () => {
  let registry, windows;
  beforeEach(() => {
    windows = [];
  });
  afterEach(() => {
    registry?.dispose();
    for (const presentation of windows) presentation.destroy();
  });

  function addWindow() {
    const presentation = new EditorWindow({
      workspace: lumine.workspace,
      editorContainer: {},
      windowService: { getId: () => 100 + windows.length },
    });
    presentation.setPresentation(window, document.createElement("div"));
    windows.push(presentation);
    lumine.workspace.registerEditorWindow(presentation);
    return presentation;
  }

  it("defaults to main and gives all-window factories independent current and future instances", () => {
    const mounted = [];
    registry = new WindowContributionRegistry({
      workspace: lumine.workspace,
      mount: (presentation, options) => {
        mounted.push({ presentation, element: options.item });
        return { destroy() {} };
      },
    });
    registry.add({
      create: ({ document }) => ({ element: document.createElement("div"), dispose() {} }),
    });
    const defaultMounts = mounted.length;
    addWindow();
    expect(mounted.length).toBe(defaultMounts);
    registry.add({
      windows: "all",
      create: ({ document }) => ({ element: document.createElement("span"), dispose() {} }),
    });
    const future = addWindow();
    expect(mounted.filter(({ presentation }) => presentation === future).length).toBe(1);
    expect(new Set(mounted.map(({ element }) => element)).size).toBe(mounted.length);
  });

  it("disposes only the closed window instance and then stops future mounts on registration disposal", () => {
    const releases = [];
    registry = new WindowContributionRegistry({
      workspace: lumine.workspace,
      mount: () => ({ destroy() {} }),
    });
    const registration = registry.add({
      windows: "all",
      create: ({ window, document }) => ({
        element: document.createElement("div"),
        dispose: () => releases.push(window),
      }),
    });
    const extra = addWindow();
    extra.destroy();
    expect(releases).toEqual([extra]);
    registration.dispose();
    expect(releases).toEqual([extra, lumine.workspace.getMainWindow()]);
    addWindow();
    expect(releases.length).toBe(2);
  });

  it("cleans every factory instance even when a closed window client throws", () => {
    const released = jasmine.createSpy("released");
    registry = new WindowContributionRegistry({
      workspace: lumine.workspace,
      mount: () => ({ destroy() {} }),
    });
    registry.add({
      windows: "all",
      create: ({ document }) => ({
        element: document.createElement("div"),
        dispose() {
          throw new Error("cleanup failed");
        },
      }),
    });
    registry.add({
      windows: "all",
      create: ({ document }) => ({
        element: document.createElement("span"),
        dispose: released,
      }),
    });
    const extra = addWindow();
    expect(() => extra.destroy()).toThrowError(AggregateError);
    expect(released).toHaveBeenCalledTimes(1);
    expect(lumine.workspace.getWindows()).not.toContain(extra);
    expect(() => registry.dispose()).toThrowError(AggregateError);
    expect(released).toHaveBeenCalledTimes(2);
  });
});
