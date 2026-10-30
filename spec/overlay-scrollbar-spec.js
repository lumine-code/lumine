const { OverlayScrollbar } = require("../src/overlay-scrollbar");

describe("Shared overlay scrollbars", () => {
  let components, fixtures;
  beforeEach(() => {
    components = [];
    fixtures = [];
  });
  afterEach(() => {
    for (const component of components) component.destroy();
    for (const fixture of fixtures) fixture.remove();
  });

  function bar(orientation = "vertical", metrics = {}) {
    const onScroll = jasmine.createSpy("scroll");
    const onDragChange = jasmine.createSpy("drag");
    const component = new OverlayScrollbar({ document, orientation, onScroll, onDragChange });
    components.push(component);
    component.update({
      extent: 1000,
      viewport: 100,
      trackSize: 100,
      position: 0,
      thickness: 10,
      ...metrics,
    });
    spyOn(component.element, "getBoundingClientRect").and.returnValue({ top: 10, left: 10 });
    return { component, onScroll, onDragChange };
  }

  function pointer(component, target, position, type = "pointerdown") {
    const event = new PointerEvent(type, {
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      pointerId: 1,
      clientX: position + 10,
      clientY: position + 10,
      bubbles: true,
    });
    target.dispatchEvent(event);
  }

  for (const orientation of ["vertical", "horizontal"]) {
    it(`jumps immediately to the ${orientation} track click with a minimum-size thumb`, () => {
      const { component, onScroll, onDragChange } = bar(orientation);
      pointer(component, component.element, 50);
      expect(component.thumbSize).toBe(20);
      expect(onScroll).toHaveBeenCalledOnceWith(450, { jump: true });
      expect(component.metrics.position).toBe(450);
      expect(onDragChange).toHaveBeenCalledWith(true, 0);
      pointer(component, component.element, 100, "pointermove");
      expect(onScroll).toHaveBeenCalledWith(900, { jump: false });
      pointer(component, component.element, 0, "pointermove");
      expect(onScroll).toHaveBeenCalledWith(0, { jump: false });
      expect(component.element.getBoundingClientRect).toHaveBeenCalledTimes(1);
    });

    it(`claims the ${orientation} thumb without changing its grab offset`, () => {
      const { component, onScroll } = bar(orientation, { position: 450 });
      pointer(component, component.thumb, 45);
      expect(onScroll).toHaveBeenCalledOnceWith(450, { jump: false });
      pointer(component, component.element, 53, "pointermove");
      expect(onScroll).toHaveBeenCalledWith(540, { jump: false });
    });
  }

  it("keeps fractional huge-document offsets out of native scroll dimensions", () => {
    const { component } = bar("vertical", { extent: 1e12, position: 10498244.805 });
    expect(component.metrics.position).toBe(10498244.805);
    expect(component.element.scrollHeight).toBeLessThan(1000);
    const bounds = component.element.getBoundingClientRect;
    component.updatePosition(10498244.825);
    expect(bounds).not.toHaveBeenCalled();
    expect(component.metrics.position).toBe(10498244.825);
    expect(component.element.tabIndex).toBe(-1);
  });

  it("releases an active gesture exactly once on destruction", () => {
    const { component, onDragChange, onScroll } = bar();
    pointer(component, component.element, 50);
    component.destroy();
    component.destroy();
    pointer(component, component.element, 80, "pointermove");
    expect(onDragChange.calls.allArgs()).toEqual([
      [true, 0],
      [false, 450],
    ]);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it("ignores release and cancellation from unrelated or retired pointers", () => {
    const { component, onDragChange } = bar();
    pointer(component, component.element, 50);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      component.element.dispatchEvent(new PointerEvent(type, { pointerId: 2 }));
    expect(component.drag.id).toBe(1);
    expect(onDragChange).toHaveBeenCalledTimes(1);
    component.element.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(component.drag).toBeNull();
    expect(onDragChange).toHaveBeenCalledTimes(2);
  });

  function scrollport(options = {}) {
    const fixture = document.createElement("div");
    fixture.style.cssText = "position:absolute;left:30px;top:30px;width:300px;height:180px;";
    const element = document.createElement("div");
    element.style.cssText = "width:100%;height:100%;overflow:auto";
    const content = document.createElement("div");
    content.style.cssText = "width:900px;height:1000px";
    element.appendChild(content);
    fixture.appendChild(element);
    jasmine.attachToDOM(fixture);
    fixtures.push(fixture);
    const controller = lumine.scrollbars.attach(element, options);
    components.push(controller);
    controller.write(controller.read());
    return { fixture, element, content, controller };
  }

  it("overlays a DOM scrollport without wrapping content or reserving a native gutter", () => {
    const { fixture, element, content, controller } = scrollport();
    expect(element.parentElement).toBe(fixture);
    expect(element.firstElementChild).toBe(content);
    expect(element.offsetWidth).toBe(element.clientWidth);
    expect(controller.layer.parentElement).toBe(fixture);
    expect(controller.layer.getBoundingClientRect().width).toBe(300);
    expect(controller.vertical.element.getBoundingClientRect().right).toBe(
      element.getBoundingClientRect().right,
    );
    expect(controller.horizontal.metrics.trackSize).toBe(290);
  });

  it("updates only the thumb during ordinary DOM scrolling", () => {
    const { element, controller } = scrollport();
    const measure = spyOn(controller, "read").and.callThrough();
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));
    expect(controller.vertical.metrics.position).toBe(100);
    expect(measure).not.toHaveBeenCalled();
    expect(controller.vertical.thumb.style.transform).not.toBe("translateY(0px)");
  });

  it("reveals a panel for keyboard focus without changing viewport dimensions", () => {
    const { element, content, controller } = scrollport({ policy: "auto" });
    const input = document.createElement("input");
    content.appendChild(input);
    const before = [element.clientWidth, element.clientHeight];
    input.focus();
    controller.syncVisibility();
    expect(controller.layer.classList.contains("is-revealed")).toBeTrue();
    expect([element.clientWidth, element.clientHeight]).toEqual(before);
  });

  it("places RTL menu tracks on the left and maps negative native horizontal offsets", () => {
    const { element, controller } = scrollport();
    element.style.direction = "rtl";
    controller.write(controller.read());
    expect(controller.layer.classList.contains("is-left")).toBeTrue();
    expect(controller.horizontal.metrics.position).toBe(600);
    element.scrollLeft = -300;
    element.dispatchEvent(new Event("scroll"));
    expect(controller.horizontal.metrics.position).toBe(300);
  });

  it("keeps marker geometry independent of the active editor", () => {
    const { element } = scrollport();
    const geometry = lumine.scrollbars.getGeometry(element);
    expect(geometry.viewportWidth).toBe(300);
    expect(geometry.viewportHeight).toBe(180);
    expect(geometry.scrollHeight).toBe(1000);
    expect(geometry.verticalSize).toBe(10);
  });

  it("resolves relative theme thickness before computing layout and hit areas", () => {
    const { element, controller } = scrollport();
    element.style.fontSize = "20px";
    element.style.setProperty("--scrollbar-size", "1em");
    controller.write(controller.read());
    expect(lumine.scrollbars.getGeometry(element).verticalSize).toBe(20);
    expect(controller.vertical.element.style.width).toBe("20px");
    expect(controller.horizontal.metrics.trackSize).toBe(280);
  });

  it("keeps inert documents free of presentation state and binds after adoption", async () => {
    const inert = document.implementation.createHTMLDocument("Detached output");
    const element = inert.createElement("div");
    element.style.cssText = "width:300px;height:180px;overflow:auto";
    const content = inert.createElement("div");
    content.style.cssText = "width:900px;height:1000px";
    element.appendChild(content);
    inert.body.appendChild(element);
    expect(lumine.scrollbars.attach(element)).toBeNull();
    expect(lumine.scrollbars.getVerticalTrack(element)).toBeNull();
    expect(lumine.scrollbars.getGeometry(element).verticalSize).toBe(10);
    const callback = jasmine.createSpy("inert output geometry");
    const subscription = lumine.scrollbars.observe(element, callback);
    components.push({ destroy: () => subscription.dispose() });
    jasmine.attachToDOM(document.adoptNode(element));
    fixtures.push(element);
    await flush();
    await flush();
    expect(lumine.scrollbars.getVerticalTrack(element).ownerDocument).toBe(document);
    expect(callback.calls.mostRecent().args[0].scrollHeight).toBe(1000);
  });

  const flush = () =>
    new Promise((resolve) => lumine.views.readDocument(() => lumine.views.updateDocument(resolve)));

  it("publishes geometry changes independently of scroll position and supports multiple consumers", async () => {
    const { element, content, controller } = scrollport();
    const first = jasmine.createSpy("first geometry consumer");
    const second = jasmine.createSpy("second geometry consumer");
    const subscriptions = [
      lumine.scrollbars.observe(element, first),
      lumine.scrollbars.observe(element, second),
    ];
    components.push({
      destroy: () => subscriptions.forEach((subscription) => subscription.dispose()),
    });
    expect(first).toHaveBeenCalledTimes(1);
    element.scrollTop = 200;
    element.dispatchEvent(new Event("scroll"));
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    content.style.height = "1400px";
    controller.refresh();
    await flush();
    await flush();
    expect(first.calls.mostRecent().args[0].scrollHeight).toBe(1400);
    expect(second.calls.mostRecent().args[0].scrollHeight).toBe(1400);
    subscriptions[0].dispose();
    content.style.height = "1600px";
    controller.refresh();
    await flush();
    await flush();
    expect(first.calls.mostRecent().args[0].scrollHeight).toBe(1400);
    expect(second.calls.mostRecent().args[0].scrollHeight).toBe(1600);
  });

  it("rebinds identical geometry to an adopted document without restoring native chrome", async () => {
    const { element, controller } = scrollport();
    element.style.width = "300px";
    element.style.height = "180px";
    const callback = jasmine.createSpy("adopted geometry");
    const subscription = lumine.scrollbars.observe(element, callback);
    const frame = document.createElement("iframe");
    jasmine.attachToDOM(frame);
    fixtures.push(frame);
    const targetDocument = frame.contentDocument;
    targetDocument.body.appendChild(targetDocument.adoptNode(element));
    try {
      await flush();
      await flush();
      const track = lumine.scrollbars.getVerticalTrack(element);
      expect(track.ownerDocument).toBe(targetDocument);
      expect(controller.destroyed).toBeTrue();
      expect(element.style.scrollbarWidth).toBe("none");
      expect(callback.calls.count()).toBeGreaterThan(1);
      expect(callback.calls.mostRecent().args[0].viewportWidth).toBe(300);
    } finally {
      subscription.dispose();
      lumine.scrollbars.releaseDocument(targetDocument);
    }
  });
});
