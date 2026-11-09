const fs = require("node:fs");
const path = require("node:path");
const { createScrollbarRuntime } = require("../src/overlay-scrollbar");

const hostDocument = document;
const hostWindow = window;
const frameCSS = fs.readFileSync(path.join(__dirname, "../static/core-ui/scrollbars.css"), "utf8");

describe("DOM scrollbar initialization", () => {
  let frame, frameWindow, manager, element, controller, reads, writes, measurements, offsets;

  beforeEach(() => {
    reads = [];
    writes = [];
  });

  afterEach(() => {
    manager?.dispose();
    frame?.remove();
    manager = null;
    frame = null;
  });

  function schedule(queue, callback) {
    const request = { callback, cancelled: false };
    queue.push(request);
    return { dispose: () => (request.cancelled = true) };
  }

  function flush(queue) {
    for (const request of queue.splice(0)) if (!request.cancelled) request.callback();
  }

  function settleGeometry() {
    for (let pass = 0; pass < 10 && (reads.length || writes.length); pass++) {
      flush(reads);
      flush(writes);
    }
    expect(reads.length + writes.length).toBe(0);
    expect(controller.publicGeometry).toBeDefined();
  }

  function scrollport({ top = 0, left = 0, width = 600, direction = "ltr" } = {}) {
    // A separate document isolates discovery and public scroll-event routing
    // from the application's manager. All read/write work remains queued.
    frame = hostDocument.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-1000px;top:0;width:360px;height:240px;border:0";
    jasmine.attachToDOM(frame);
    const document = frame.contentDocument;
    frameWindow = frame.contentWindow;
    spyOn(frameWindow.performance, "now").and.callFake(() => Date.now());
    spyOn(frameWindow, "setTimeout").and.callFake((callback, delay) =>
      hostWindow.setTimeout(callback, delay),
    );
    spyOn(frameWindow, "clearTimeout").and.callFake((id) => hostWindow.clearTimeout(id));
    const style = document.createElement("style");
    style.textContent = `${frameCSS}
      * { box-sizing: border-box; }
      html, body { margin: 0; }
      :root { --scrollbar-size: 10px; }
      #fixture { position: relative; width: 240px; height: 140px; }
      #port { width: 100%; height: 100%; overflow: auto; }
      .lumine-scrollbar { transition: none !important; }
    `;
    document.head.appendChild(style);
    const fixture = document.createElement("section");
    fixture.id = "fixture";
    element = document.createElement("div");
    element.id = "port";
    element.style.direction = direction;
    const content = document.createElement("article");
    content.style.cssText = `width:${width}px;height:900px`;
    element.appendChild(content);
    fixture.appendChild(element);
    document.body.appendChild(fixture);
    element.scrollTop = top;
    element.scrollLeft = left;
    expect(element.scrollTop).toBe(top);
    expect(element.scrollLeft).toBe(left);

    // Native offsets are the permitted initialization baseline. Dimension and
    // rectangle reads must wait for the first shared measurement instead.
    offsets = [
      spyOnProperty(element, "scrollTop", "get").and.callThrough(),
      spyOnProperty(element, "scrollLeft", "get").and.callThrough(),
    ];
    measurements = [
      ...[
        "clientWidth",
        "clientHeight",
        "offsetWidth",
        "offsetHeight",
        "scrollWidth",
        "scrollHeight",
      ].map((property) => spyOnProperty(element, property, "get").and.callThrough()),
      spyOn(element, "getBoundingClientRect").and.callThrough(),
    ];
    manager = new (createScrollbarRuntime().DOMScrollbarManager)({
      document,
      scheduleRead: (callback) => schedule(reads, callback),
      scheduleWrite: (callback) => schedule(writes, callback),
    });
    controller = manager.attach(element, {
      kind: "panel",
      layout: "overlay",
      policy: "hover",
      focusOwner: element,
    });
    expect(controller.publicGeometry).toBeUndefined();
    expect(offsets.map((spy) => spy.calls.count())).toEqual([1, 1]);
    expectMeasurementCount(0);
  }

  function measurementCount() {
    return measurements.reduce((total, spy) => total + spy.calls.count(), 0);
  }

  function expectMeasurementCount(expected) {
    expect(measurementCount()).toBe(expected);
  }

  function scrollEvent() {
    element.dispatchEvent(new frameWindow.Event("scroll"));
  }

  function revealed() {
    return controller.layer.classList.contains("is-revealed");
  }

  function expectThumbPosition(axis) {
    const geometry = controller.publicGeometry;
    const vertical = axis === "vertical";
    const extent = vertical ? geometry.scrollHeight : geometry.scrollWidth;
    const viewport = vertical ? geometry.viewportHeight : geometry.viewportWidth;
    const track = vertical ? geometry.verticalTrackSize : geometry.horizontalTrackSize;
    const bar = vertical ? controller.vertical : controller.horizontal;
    const thumbSize = parseFloat(bar.thumb.style[vertical ? "height" : "width"]);
    const position = vertical
      ? element.scrollTop
      : element.style.direction === "rtl"
        ? extent - viewport + element.scrollLeft
        : element.scrollLeft;
    const actual = parseFloat(bar.thumb.style.transform.replace(/^translate[XY]\(/, ""));
    expect(actual).toBeNear((position / (extent - viewport)) * (track - thumbSize));
  }

  it("does not reveal for initial zero offsets and duplicate scroll events before measurement", () => {
    scrollport();
    scrollEvent();
    scrollEvent();
    advanceClock(100);
    scrollEvent();
    expectMeasurementCount(0);
    settleGeometry();
    expect(revealed()).toBeFalse();
    expect(frameWindow.setTimeout).not.toHaveBeenCalled();
    advanceClock(700);
    expect(revealed()).toBeFalse();
  });

  it("does not treat a restored nonzero offset and its first scroll event as new activity", () => {
    scrollport({ top: 80, left: 50 });
    scrollEvent();
    advanceClock(200);
    scrollEvent();
    expectMeasurementCount(0);
    settleGeometry();
    expect(element.scrollTop).toBe(80);
    expect(element.scrollLeft).toBe(50);
    expect(revealed()).toBeFalse();
    expect(frameWindow.setTimeout).not.toHaveBeenCalled();
    expectThumbPosition("vertical");
    expectThumbPosition("horizontal");
  });

  for (const [axis, direction, property, position] of [
    ["vertical", "ltr", "scrollTop", 60],
    ["horizontal", "ltr", "scrollLeft", 40],
    ["horizontal", "rtl", "scrollLeft", -40],
  ]) {
    it(`retains the original deadline of a real ${direction} ${axis} scroll before first geometry`, () => {
      scrollport({ direction });
      advanceClock(100);
      element[property] = position;
      scrollEvent();
      advanceClock(300);
      scrollEvent();
      expectMeasurementCount(0);
      advanceClock(250);
      settleGeometry();
      expect(revealed()).toBeTrue();
      expectThumbPosition(axis);
      advanceClock(50);
      // A duplicate after publication must not extend the premeasurement
      // activity either: it still ends at t=100+700, not t=650+700.
      scrollEvent();
      advanceClock(99);
      expect(revealed()).toBeTrue();
      advanceClock(1);
      expect(revealed()).toBeFalse();
    });

    it(`publishes the latest ${direction} ${axis} position when scroll arrives between read and write`, () => {
      scrollport({ direction, width: axis === "vertical" ? 100 : 600 });
      flush(reads);
      if (axis === "horizontal") {
        // The first write installs the horizontal rail's end space. Hold the
        // following measurement's write, which will first publish geometry.
        flush(writes);
        flush(reads);
      }
      expect(controller.publicGeometry).toBeUndefined();
      const measured = measurementCount();
      advanceClock(100);
      element[property] = position;
      scrollEvent();
      expectMeasurementCount(measured);
      advanceClock(200);
      flush(writes);
      expect(controller.publicGeometry).toBeDefined();
      expectThumbPosition(axis);
      expect(revealed()).toBeTrue();
      advanceClock(300);
      scrollEvent();
      advanceClock(199);
      expect(revealed()).toBeTrue();
      advanceClock(1);
      expect(revealed()).toBeFalse();
    });
  }

  it("does not flash a fresh pulse when the original activity expired before first geometry", () => {
    scrollport();
    advanceClock(100);
    element.scrollTop = 60;
    scrollEvent();
    advanceClock(701);
    settleGeometry();
    expect(revealed()).toBeFalse();
    expect(frameWindow.setTimeout).not.toHaveBeenCalled();
    expectThumbPosition("vertical");
  });

  it("continues projecting measured scrolls without renewing duplicate activity or geometry", () => {
    scrollport();
    settleGeometry();
    const changedGeometry = jasmine.createSpy("changed geometry");
    controller.callbacks.add(changedGeometry);
    const geometry = controller.publicGeometry;
    const measured = measurementCount();
    advanceClock(100);
    element.scrollTop = 60;
    scrollEvent();
    expectThumbPosition("vertical");
    expect(revealed()).toBeTrue();
    advanceClock(500);
    scrollEvent();
    advanceClock(199);
    expect(revealed()).toBeTrue();
    advanceClock(1);
    expect(revealed()).toBeFalse();
    expect(controller.publicGeometry).toBe(geometry);
    expect(changedGeometry).not.toHaveBeenCalled();
    expectMeasurementCount(measured);
    expect(reads.length + writes.length).toBe(0);
  });
});
