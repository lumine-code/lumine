describe("snapshot scheduling in editor windows", () => {
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });
  it("schedules a snapshot from auxiliary input independently of the opener's idle queue", async () => {
    const interval = lumine.saveStateDebounceInterval;
    lumine.saveStateDebounceInterval = 10;
    try {
      const extra = await lumine.workspace.openEditorWindow({ show: true });
      const save = spyOn(lumine, "saveState").and.resolveTo();
      const idle = spyOn(window, "requestIdleCallback");
      const nativeWindow = extra.getDocument().defaultView;
      extra
        .getElement()
        .dispatchEvent(new nativeWindow.KeyboardEvent("keydown", { bubbles: true, key: "a" }));
      await conditionPromise(() => save.calls.count() > 0);
      expect(save).toHaveBeenCalledWith({ isUnloading: false });
      expect(idle).not.toHaveBeenCalled();
    } finally {
      lumine.saveStateDebounceInterval = interval;
    }
  });
});
