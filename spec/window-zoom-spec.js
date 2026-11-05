const { conditionPromise } = require("./helpers/async-spec-helpers");

describe("Window zoom", () => {
  let main;
  let originalFontSize;

  beforeEach(async () => {
    jasmine.useRealClock();
    main = lumine.workspace.getMainWindow();
    originalFontSize = lumine.config.get("editor.fontSize");
    jasmine.attachToDOM(main.getElement());
    await main.resetZoom();
  });

  afterEach(async () => {
    await main.resetZoom();
    await lumine.workspace.discardEditorWindows();
    lumine.config.set("editor.fontSize", originalFontSize);
  });

  it("scales the page through commands while preserving the configured editor font", async () => {
    lumine.config.set("editor.fontSize", 21);
    const editor = await lumine.workspace.open();
    const initialPixelRatio = window.devicePixelRatio;

    await lumine.commands.dispatch(editor.getElement(), "window:zoom-in");
    expect(await main.getZoomFactor()).toBeCloseTo(1.05, 8);
    await conditionPromise(
      () => Math.abs(window.devicePixelRatio / initialPixelRatio - 1.05) < 0.001,
      "the page scale to update",
    );
    expect(lumine.config.get("editor.fontSize")).toBe(21);
    expect(parseFloat(getComputedStyle(editor.getElement()).fontSize)).toBe(21);

    await lumine.commands.dispatch(editor.getElement(), "window:zoom-out");
    expect(await main.getZoomFactor()).toBeCloseTo(1, 8);
    await main.zoomIn();
    await lumine.commands.dispatch(editor.getElement(), "window:reset-zoom");
    expect(await main.getZoomFactor()).toBeCloseTo(1, 8);
    expect(lumine.config.get("editor.fontSize")).toBe(21);
  });

  it("routes each command to its own presentation without changing another window", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    expect(await extra.getZoomFactor()).toBeCloseTo(1, 8);

    await lumine.commands.dispatch(extra.getElement(), "window:zoom-in");
    expect(await extra.getZoomFactor()).toBeCloseTo(1.05, 8);
    expect(await main.getZoomFactor()).toBeCloseTo(1, 8);

    await lumine.commands.dispatch(main.getElement(), "window:zoom-out");
    expect(await main.getZoomFactor()).toBeCloseTo(0.95, 8);
    expect(await extra.getZoomFactor()).toBeCloseTo(1.05, 8);

    await lumine.commands.dispatch(extra.getElement(), "window:reset-zoom");
    expect(await extra.getZoomFactor()).toBeCloseTo(1, 8);
    expect(await main.getZoomFactor()).toBeCloseTo(0.95, 8);
  });

  it("reports zoom changes only to the affected presentation and supports disposal", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const mainChanges = [];
    const extraChanges = [];
    const mainSubscription = main.onDidChangeZoomFactor((factor) => mainChanges.push(factor));
    const extraSubscription = extra.onDidChangeZoomFactor((factor) => extraChanges.push(factor));
    try {
      await lumine.commands.dispatch(main.getElement(), "window:zoom-in");
      await lumine.commands.dispatch(extra.getElement(), "window:zoom-out");
      await conditionPromise(
        () => mainChanges.length === 1 && extraChanges.length === 1,
        "both presentations to report their own zoom changes",
      );
      expect(mainChanges).toEqual([1.05]);
      expect(extraChanges).toEqual([0.95]);

      await extra.resetZoom();
      await conditionPromise(() => extraChanges.length === 2, "the reset zoom notification");
      expect(extraChanges).toEqual([0.95, 1]);
      await extra.resetZoom();
      await extra.getZoomFactor();
      expect(extraChanges).toEqual([0.95, 1]);

      mainSubscription.dispose();
      extraSubscription.dispose();
      await main.resetZoom();
      await extra.zoomIn();
      await extra.getZoomFactor();
      expect(mainChanges).toEqual([1.05]);
      expect(extraChanges).toEqual([0.95, 1]);
    } finally {
      mainSubscription.dispose();
      extraSubscription.dispose();
    }
  });

  it("snapshots and observes applied zoom state independently for each presentation", async () => {
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    expect(await main.getZoomState()).toEqual({ factor: 1, defaultFactor: 1 });
    expect(await extra.getZoomState()).toEqual({ factor: 1, defaultFactor: 1 });
    const mainChanges = [];
    const extraChanges = [];
    const mainSubscription = main.onDidChangeZoomState((state) => mainChanges.push(state));
    const extraSubscription = extra.onDidChangeZoomState((state) => extraChanges.push(state));
    try {
      await main.zoomIn();
      await extra.zoomOut();
      await conditionPromise(
        () => mainChanges.length === 1 && extraChanges.length === 1,
        "both presentations to report their own applied zoom state",
      );
      expect(mainChanges).toEqual([{ factor: 1.05, defaultFactor: 1 }]);
      expect(extraChanges).toEqual([{ factor: 0.95, defaultFactor: 1 }]);
      expect(await main.getZoomState()).toEqual({ factor: 1.05, defaultFactor: 1 });
      expect(await extra.getZoomState()).toEqual({ factor: 0.95, defaultFactor: 1 });
      mainSubscription.dispose();
      extraSubscription.dispose();
      await main.resetZoom();
      await extra.resetZoom();
      await extra.getZoomState();
      expect(mainChanges).toEqual([{ factor: 1.05, defaultFactor: 1 }]);
      expect(extraChanges).toEqual([{ factor: 0.95, defaultFactor: 1 }]);
    } finally {
      mainSubscription.dispose();
      extraSubscription.dispose();
    }
  });

  it("opens and reopens presentations at 100 percent while another window is zoomed", async () => {
    await main.zoomIn();
    const first = await lumine.workspace.openEditorWindow({ show: false });
    const persistentId = first.persistentId;
    expect(await first.getZoomFactor()).toBeCloseTo(1, 8);
    await first.zoomOut();
    expect(await first.getZoomFactor()).toBeCloseTo(0.95, 8);
    await lumine.workspace.closeEditorWindow(first);

    const reopened = await lumine.workspace.openEditorWindow({ show: false, persistentId });
    expect(await reopened.getZoomFactor()).toBeCloseTo(1, 8);
    expect(await main.getZoomFactor()).toBeCloseTo(1.05, 8);
  });
});
