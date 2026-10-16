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
