describe("command availability follows model state", () => {
  let registrations;
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    registrations = [];
  });
  afterEach(() => registrations.forEach((entry) => entry.dispose()));

  it("keeps Save and Save As disabled without a saveable center item", async () => {
    const workspace = lumine.workspace.getElement();
    expect(lumine.commands.canDispatch(workspace, "core:save")).toBe(false);
    expect(lumine.commands.canDispatch(workspace, "core:save-as")).toBe(false);
    const editor = await lumine.workspace.open();
    editor.setReadOnly(true);
    expect(lumine.commands.canDispatch(editor.getElement(), "core:paste")).toBe(false);
    expect(lumine.commands.canDispatch(workspace, "core:save")).toBe(true);
    expect(lumine.commands.canDispatch(workspace, "core:save-as")).toBe(true);
  });

  it("requires a path for copying and a known repository for Checkout HEAD", async () => {
    const editor = await lumine.workspace.open();
    expect(lumine.commands.canDispatch(editor.getElement(), "editor:copy-path")).toBe(false);
    expect(lumine.commands.canDispatch(editor.getElement(), "editor:checkout-head-revision")).toBe(
      false,
    );
    editor
      .getBuffer()
      .setPath(
        require("path").join(lumine.project.getPaths()[0] || process.cwd(), "availability.txt"),
      );
    expect(lumine.commands.canDispatch(editor.getElement(), "editor:copy-path")).toBe(true);
  });

  it("publishes path, grammar, readonly and selection state without reading text", async () => {
    const editor = await lumine.workspace.open();
    await globalThis.flushMicrotasks();
    const changes = jasmine.createSpy("availability changes");
    registrations.push(lumine.commands.onDidChange(changes));
    const text = spyOn(editor, "getText").and.callThrough();
    editor.setReadOnly(true);
    await globalThis.flushMicrotasks();
    expect(changes).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    changes.calls.reset();
    editor.getBuffer().setPath(require("path").join(process.cwd(), "different-path.txt"));
    await globalThis.flushMicrotasks();
    expect(changes).toHaveBeenCalled();
  });

  it("keeps local changes targeted and leaves registration changes global", () => {
    const changes = jasmine.createSpy("availability changes");
    registrations.push(lumine.commands.onDidChange(changes));
    const target = document.createElement("div");
    lumine.commands.invalidateAvailability({ target });
    expect(changes).toHaveBeenCalledWith({ target });
    changes.calls.reset();
    lumine.commands.invalidateAvailability();
    expect(changes).toHaveBeenCalledWith(undefined);
  });

  it("invalidates Save All when a non-active custom pane item is added", async () => {
    const pane = lumine.workspace.getActivePane();
    await lumine.workspace.open();
    await globalThis.flushMicrotasks();
    const changes = jasmine.createSpy("custom pane item added");
    registrations.push(lumine.commands.onDidChange(changes));
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Custom modified document",
      getURI: () => "custom://modified",
      getFileState: () => "modified",
      save() {},
    };
    pane.addItem(item, { activateItem: false });
    await globalThis.flushMicrotasks();
    expect(changes).toHaveBeenCalled();
    expect(lumine.commands.canDispatch(lumine.workspace.element, "window:save-all")).toBeTrue();
  });

  it("tolerates custom pane items whose optional subscription methods return nothing", () => {
    const item = {
      element: document.createElement("div"),
      getTitle: () => "Custom pane item",
      onDidChangeFileState() {},
      onDidChangeURI() {},
      onDidDestroy() {},
    };
    expect(() => lumine.workspace.commandAvailabilityObserver.observeItem(item)).not.toThrow();
  });

  it("matches the new grammar scope before the next view render", async () => {
    const editor = await lumine.workspace.open();
    const target = editor.getElement();
    registrations.push(
      lumine.commands.add("lumine-text-editor[data-grammar~='availability']", {
        "state-spec:grammar": () => {},
      }),
    );
    expect(lumine.commands.canDispatch(target, "state-spec:grammar")).toBe(false);
    const NullLanguageMode = require("../src/null-language-mode");
    editor.getBuffer().setLanguageMode(
      new NullLanguageMode({
        buffer: editor.getBuffer(),
        grammar: { ...require("../src/null-grammar"), scopeName: "source.availability" },
      }),
    );
    expect(lumine.commands.canDispatch(target, "state-spec:grammar")).toBe(true);
  });
});
