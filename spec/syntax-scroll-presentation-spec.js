const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const { Point, Range } = require("../src/text-buffer");

describe("Scrolling while syntax is unavailable", () => {
  let service, editor, mode, element, component, snapshots, stamp;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    service = new Service(lumine.grammars);
    editor = lumine.workspace.buildTextEditor({
      autoHeight: false,
      softWrapped: false,
      wheelScrollMultiplier: 1,
      wheelScrollDuration: 120,
    });
    editor.setText(("const value = 1; // " + "details ".repeat(60) + "\n").repeat(300));
    mode = new WorkerMode({
      buffer: editor.getBuffer(),
      service,
      grammar: lumine.grammars.grammarForScopeName("source.js"),
    });
    editor.getBuffer().setLanguageMode(mode);
    element = editor.getElement();
    element.style.cssText = "height:200px;width:800px";
    await mode.ready;
    editor.update({
      softWrapped: false,
      maxScreenLineLength: Infinity,
      wheelScrollMultiplier: 1,
      wheelScrollDuration: 120,
    });
    const owner = {};
    const copy = (first, last) =>
      mode.cache.captureRange(new Point(first, 0), new Point(last, 0), new Point(first, 0), []);
    snapshots = {};
    for (const [name, first, last] of [
      ["initial", 0, 40],
      ["first", 80, 150],
      ["last", 180, 260],
    ]) {
      mode.requestHighlighting(owner, [[first, last - 1]], false, { priority: 0, prefetch: false });
      await mode.refresh();
      expect(mode.scopeDescriptorForPosition([first + 10, 14]).scopes).toContain(
        "constant.numeric.js",
      );
      snapshots[name] = copy(first, last);
    }
    stamp = {
      revision: editor.getBuffer().getTextRevision(),
      generation: mode.session.generation,
      presentation: mode.presentationVersion,
    };
    // Keep real parser-produced colors, then prevent any more worker work.
    // Navigation must finish even if no syntax reply ever arrives.
    spyOn(mode, "schedule");
    clearTimeout(mode.timer);
    mode.timer = null;
    mode.requestHighlighting(owner, [], false);
    mode.cache.clear();
    jasmine.attachToDOM(element);
    element.setUpdatedSynchronously(true);
    component = element.component;
    component.scrollAnimator.raf = () => 0;
    component.scrollAnimator.caf = () => {};
    component.updateSync();
  });

  afterEach(async () => {
    editor?.destroy();
    element?.remove();
    await service?.dispose();
  });

  function finishAnimation() {
    let frames = 0;
    while (component.scrollAnimator.isAnimating() && frames++ < 100)
      component.scrollAnimator.advance(1000 / 60);
    expect(component.scrollAnimator.isAnimating()).toBeFalse();
  }

  function expectVisible(row) {
    expect(editor.getFirstVisibleScreenRow()).toBeLessThanOrEqual(row);
    expect(editor.getLastVisibleScreenRow()).toBeGreaterThanOrEqual(row);
    expect(component.renderedScreenLinesStartRow).toBeLessThanOrEqual(row);
    expect(
      component.renderedScreenLinesStartRow + component.renderedScreenLines.length,
    ).toBeGreaterThan(row);
    const request = mode.requestsByOwner.get(editor.displayLayer);
    expect(request.priority).toBe(0);
    expect(request.ranges.some(([first, last]) => first <= row && last >= row)).toBeTrue();
  }

  function publish(name, first, last) {
    mode.cache.replace(snapshots[name], stamp);
    mode.emitter.emit("did-change-highlighting", new Range([first, 0], [last, 0]));
    component.updateSync();
  }

  for (const smooth of [false, true])
    it(`moves both wheel axes without syntax replies (smooth=${smooth})`, async () => {
      editor.update({ smoothScrolling: smooth });
      const top = 100 * component.getLineHeight();
      const preventDefault = jasmine.createSpy("preventDefault");
      const updated = component.getNextUpdatePromise();
      const transform = component.refs.content.style.transform;
      component.didMouseWheel({ deltaX: 300, deltaY: top, deltaMode: 0, preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      if (smooth) {
        component.scrollAnimator.advance(1000 / 60);
        expect(component.getScrollTop()).toBeGreaterThan(0);
        expect(component.getScrollLeft()).toBeGreaterThan(0);
        expect(component.refs.content.style.transform).not.toBe(transform);
        finishAnimation();
      }
      expect(component.getScrollTop()).toBe(top);
      expect(component.getScrollLeft()).toBe(300);
      expectVisible(100);
      expect(mode.cache.snapshots.length).toBe(0);
      await updated;
    });

  it("lets thumb drags and track clicks take over both axes before colors arrive", () => {
    const height = component.getLineHeight();
    component.scrollAnimator.scrollBy({ x: 100, y: height * 10, duration: 120 });
    component.scrollAnimator.advance(1000 / 60);
    expect(component.scrollAnimator.isAnimating()).toBeTrue();
    const rail = component.refs.verticalScrollbar.element;
    const thumb = rail.querySelector(".scrollbar-thumb");
    const rect = thumb.getBoundingClientRect();
    const pointer = {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    thumb.dispatchEvent(new PointerEvent("pointerdown", pointer));
    expect(component.scrollAnimator.isAnimating()).toBeFalse();
    rail.dispatchEvent(new PointerEvent("pointerup", pointer));
    component.didScrollScrollbar({ orientation: "vertical", position: 100 * height });
    expect(component.getScrollTop()).toBe(100 * height);
    expectVisible(100);
    component.didScrollScrollbar({ orientation: "horizontal", position: 250 });
    expect(component.getScrollLeft()).toBe(250);
    component.scrollAnimator.scrollBy({ x: 100, y: height * 10, duration: 120 });
    component.didScrollScrollbar({ orientation: "vertical", position: 200 * height, jump: true });
    component.didScrollScrollbar({ orientation: "horizontal", position: 500, jump: true });
    expect(component.scrollAnimator.isAnimating()).toBeFalse();
    expect(component.getScrollTop()).toBe(200 * height);
    expect(component.getScrollLeft()).toBe(500);
    expect(component.refs.verticalScrollbar.props.scrollTop).toBe(200 * height);
    expect(component.refs.horizontalScrollbar.props.scrollLeft).toBe(500);
    expectVisible(200);
    expect(mode.cache.snapshots.length).toBe(0);
  });

  it("reveals search selections and programmatic destinations without colors", async () => {
    // Buffer search preserves its selection, then reveals the result through
    // this separate scroll request.
    const updated = component.getNextUpdatePromise();
    editor.setSelectedBufferRange(
      [
        [100, 6],
        [100, 11],
      ],
      { autoscroll: false },
    );
    editor.scrollToCursorPosition({ mode: "center" });
    component.updateSync();
    expect(editor.getSelectedText()).toBe("value");
    expectVisible(100);
    editor.setCursorBufferPosition([200, 0], { autoscroll: true });
    component.updateSync();
    expectVisible(200);
    editor.scrollToBufferPosition([120, 0], { mode: "center" });
    component.updateSync();
    expectVisible(120);
    element.setScrollTop(220 * component.getLineHeight());
    element.setScrollLeft(400);
    component.updateSync();
    expect(component.getScrollTop()).toBe(220 * component.getLineHeight());
    expect(component.getScrollLeft()).toBe(400);
    expectVisible(220);
    expect(mode.cache.snapshots.length).toBe(0);
    await updated;
  });

  it("schedules rendered updates for bottom and right API destinations", async () => {
    const top = 100 * component.getLineHeight();
    const updated = component.getNextUpdatePromise();
    const schedule = spyOn(component, "scheduleUpdate").and.callThrough();
    expect(element.setScrollBottom(top + component.getScrollContainerClientHeight())).toBeTrue();
    expect(element.setScrollRight(300 + component.getScrollContainerClientWidth())).toBeTrue();
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(component.getScrollTop()).toBe(top);
    expect(component.getScrollLeft()).toBe(300);
    expectVisible(100);
    await updated;
    schedule.calls.reset();
    expect(element.setScrollBottom(element.getScrollBottom())).toBeFalse();
    expect(element.setScrollRight(element.getScrollRight())).toBeFalse();
    expect(schedule).not.toHaveBeenCalled();
    expect(mode.cache.snapshots.length).toBe(0);
  });

  it("recolors the mounted destination without replaying obsolete navigation", async () => {
    const height = component.getLineHeight();
    const updated = component.getNextUpdatePromise();
    component.didScrollScrollbar({ orientation: "vertical", position: 100 * height });
    component.didScrollScrollbar({ orientation: "vertical", position: 200 * height });
    expectVisible(200);
    expect(element.querySelectorAll(".syntax--constant").length).toBe(0);
    await updated;
    const mounted = component.mountedTileStartRow;
    const transform = component.refs.lineTiles.style.transform;
    publish("first", 80, 150);
    expect(component.getScrollTop()).toBe(200 * height);
    expect(element.querySelectorAll(".syntax--constant").length).toBe(0);
    publish("last", 180, 260);
    expect(component.getScrollTop()).toBe(200 * height);
    expect(component.mountedTileStartRow).toBe(mounted);
    expect(component.refs.lineTiles.style.transform).toBe(transform);
    expect(element.querySelectorAll(".syntax--constant").length).toBeGreaterThan(0);
    publish("initial", 0, 40);
    expect(component.getScrollTop()).toBe(200 * height);
    expectVisible(200);
  });

  it("keeps the accepted destination when hidden and revealed before syntax is ready", () => {
    editor.update({ smoothScrolling: true });
    const top = 200 * component.getLineHeight();
    component.didMouseWheel({ deltaY: top, preventDefault() {} });
    component.scrollAnimator.advance(1000 / 60);
    component.didHide();
    expect(component.scrollAnimator.isAnimating()).toBeFalse();
    expect(component.getScrollTop()).toBe(top);
    publish("first", 80, 150);
    component.didShow();
    component.updateSync();
    expect(component.getScrollTop()).toBe(top);
    expectVisible(200);
    publish("last", 180, 260);
    expect(component.getScrollTop()).toBe(top);
    expect(element.querySelectorAll(".syntax--constant").length).toBeGreaterThan(0);
  });
});
