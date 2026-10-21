const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("Initial editor highlighting", () => {
  beforeEach(() => jasmine.useRealClock());

  it("does not delay background openings for paint preparation", async () => {
    const workspace = lumine.workspace;
    const previous = await workspace.open();
    const factory = workspace.textEditorFactory;
    const build = factory.build.bind(factory);
    const prepare = jasmine
      .createSpy("prepareInitialHighlighting")
      .and.returnValue(new Promise(() => {}));
    spyOn(factory, "build").and.callFake((params) => {
      const editor = build(params);
      editor.getBuffer().getLanguageMode().prepareInitialHighlighting = prepare;
      return editor;
    });
    const editor = await workspace.open("background-highlight-fixture.js", { activateItem: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(workspace.getActivePaneItem()).toBe(previous);
    editor.destroy();
    previous.destroy();
  });

  for (const cancel of [false, true]) {
    it(
      cancel
        ? "disposes an opening cancelled during paint preparation"
        : "keeps the previous item visible until prepared text is available",
      async () => {
        const workspace = lumine.workspace;
        const previous = await workspace.open();
        const factory = workspace.textEditorFactory;
        const build = factory.build.bind(factory);
        let candidate, release;
        const prepared = new Promise((resolve) => {
          release = resolve;
        });
        spyOn(factory, "build").and.callFake((params) => {
          candidate = build(params);
          candidate.getBuffer().getLanguageMode().prepareInitialHighlighting = () => prepared;
          return candidate;
        });
        const controller = new AbortController();
        const opening = workspace.open("initial-highlight-fixture.js", {
          signal: controller.signal,
        });
        await conditionPromise(() => candidate);
        expect(workspace.getActivePaneItem()).toBe(previous);
        expect(workspace.paneForItem(candidate)).toBeUndefined();
        if (cancel) controller.abort();
        release();
        const result = await opening;
        if (cancel) {
          expect(result).toBeUndefined();
          expect(candidate.isDestroyed()).toBeTrue();
          expect(workspace.getActivePaneItem()).toBe(previous);
        } else {
          expect(result).toBe(candidate);
          expect(workspace.getActivePaneItem()).toBe(candidate);
          candidate.destroy();
        }
        previous.destroy();
      },
    );
  }
});
