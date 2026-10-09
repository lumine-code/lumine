const etch = require("@lumine-code/etch");
const Dock = require("../src/dock");
const { createPaneResizeHandleElement } = require("../src/pane-resize-handle-element");
const { isLayoutDragActive, onDidEndLayoutDrag } = require("../src/layout-drag");

describe("frame-bound layout resizing", () => {
  let frames, nextFrameId, docks, dividers, fixtures, subscriptions;

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 1;
    docks = [];
    dividers = [];
    fixtures = [];
    subscriptions = [];
    spyOn(window, "requestAnimationFrame").and.callFake((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    spyOn(window, "cancelAnimationFrame").and.callFake((id) => frames.delete(id));
  });

  afterEach(() => {
    subscriptions.forEach((subscription) => subscription.dispose());
    dividers.forEach(({ handle }) => handle.resizeStopped(false));
    docks.forEach((dock) => {
      if (!dock.destroyed) dock.destroy();
    });
    fixtures.forEach((fixture) => fixture.remove());
    // Drain Etch updates scheduled by cursor and visibility changes as well as
    // the resize callbacks, so the shared scheduler keeps no fake frame alive.
    for (let count = 0; frames.size && count < 10; count++) advanceFrame();
    window.requestAnimationFrame.and.callThrough();
    window.cancelAnimationFrame.and.callThrough();
    for (const callback of frames.values()) window.requestAnimationFrame(callback);
    frames.clear();
  });

  function advanceFrame() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  }

  function observeEnd(callback) {
    subscriptions.push(onDidEndLayoutDrag(callback));
  }

  function makeDock(location = "left") {
    const fixture = document.createElement("div");
    fixture.style.cssText =
      "position: fixed; left: 20px; top: 20px; width: 600px; height: 400px; display: flex;";
    if (location === "bottom") fixture.style.flexDirection = "column";
    if (location !== "left") fixture.style.justifyContent = "flex-end";
    const dock = new Dock({
      location,
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      deserializerManager: lumine.deserializers,
      notificationManager: lumine.notifications,
      viewRegistry: lumine.views,
      didActivate() {},
      didChangeActivePane() {},
      didChangeActivePaneItem() {},
      didDestroyPaneItem() {},
    });
    fixture.appendChild(dock.getElement());
    jasmine.attachToDOM(fixture);
    dock.setState({ size: 200 });
    dock.show();
    fixtures.push(fixture);
    docks.push(dock);
    return dock;
  }

  function dockSize(dock) {
    return dock.location === "bottom" ? dock.element.offsetHeight : dock.element.offsetWidth;
  }

  function moveDock(dock, size, buttons = 1) {
    const rect = dock.element.getBoundingClientRect();
    const clientX = dock.location === "right" ? rect.right - size : rect.left + size;
    const clientY = dock.location === "bottom" ? rect.bottom - size : rect.top + 10;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, buttons, button: 0 }));
  }

  function releaseDock() {
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  }

  function makeSide() {
    const element = document.createElement("div");
    element.style.cssText = "flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden;";
    let scale = 1;
    // These are the model methods used by the handle. The setter applies the
    // same synchronous flex-grow write as PaneElement's model subscription.
    element.model = {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      getFlexScale() {
        return scale;
      },
      setFlexScale(value) {
        scale = value;
        element.style.flexGrow = value;
      },
    };
    return element;
  }

  function makeDivider(horizontal = true) {
    const axis = document.createElement("div");
    axis.className = horizontal ? "horizontal" : "vertical";
    axis.style.cssText =
      "position: fixed; left: 20px; top: 20px; width: 600px; height: 400px; display: flex;";
    if (!horizontal) axis.style.flexDirection = "column";
    const previous = makeSide();
    const next = makeSide();
    const handle = createPaneResizeHandleElement();
    handle.style.flex = "0 0 0px";
    axis.append(previous, handle, next);
    jasmine.attachToDOM(axis);
    const origin = previous.getBoundingClientRect();
    const total = horizontal
      ? previous.clientWidth + next.clientWidth
      : previous.clientHeight + next.clientHeight;
    const divider = { axis, previous, next, handle, horizontal, origin, total };
    fixtures.push(axis);
    dividers.push(divider);
    return divider;
  }

  function startDivider({ handle }) {
    handle.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1 }));
  }

  function moveDivider({ horizontal, origin }, size, buttons = 1) {
    const clientX = origin.left + (horizontal ? size : 10);
    const clientY = origin.top + (horizontal ? 10 : size);
    document.dispatchEvent(new MouseEvent("mousemove", { clientX, clientY, buttons, button: 0 }));
  }

  function releaseDivider() {
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
  }

  function previousSize({ previous, horizontal }) {
    return horizontal ? previous.clientWidth : previous.clientHeight;
  }

  describe("docks", () => {
    for (const location of ["left", "right", "bottom"]) {
      it(`commits only the latest ${location} dock size in a pointer burst`, () => {
        const dock = makeDock(location);
        dock.handleResizeHandleDragStart();
        advanceFrame();
        const update = spyOn(etch, "updateSync").and.callThrough();
        moveDock(dock, 220);
        moveDock(dock, 240);
        moveDock(dock, 260);
        expect(dockSize(dock)).toBe(200);
        expect(update).not.toHaveBeenCalled();

        advanceFrame();

        expect(dockSize(dock)).toBe(260);
        expect(update.calls.allArgs().filter(([component]) => component === dock).length).toBe(1);
      });
    }

    it("settles the final size before drag-end observers run, even before the frame", () => {
      const dock = makeDock();
      const observed = [];
      observeEnd(() => observed.push([dockSize(dock), isLayoutDragActive()]));
      dock.handleResizeHandleDragStart();
      advanceFrame();
      moveDock(dock, 250);
      const canceledCallbacks = [...frames.values()];

      releaseDock();

      expect(observed).toEqual([[250, false]]);
      canceledCallbacks.forEach((callback) => callback(performance.now()));
      advanceFrame();
      expect(dockSize(dock)).toBe(250);
      expect(observed.length).toBe(1);
    });

    it("flushes the last held-button position when a release was missed", () => {
      const dock = makeDock();
      dock.handleResizeHandleDragStart();
      moveDock(dock, 250);
      moveDock(dock, 280, 0);

      expect(dockSize(dock)).toBe(250);
      expect(isLayoutDragActive()).toBe(false);
      advanceFrame();
      expect(dockSize(dock)).toBe(250);
    });

    it("balances the drag signal after repeated start and release events", () => {
      const dock = makeDock();
      const ended = jasmine.createSpy("ended");
      observeEnd(ended);
      dock.handleResizeHandleDragStart();
      dock.handleResizeHandleDragStart();
      releaseDock();
      releaseDock();

      expect(ended.calls.count()).toBe(1);
      expect(isLayoutDragActive()).toBe(false);
    });

    it("discards queued sizes when the dock is destroyed", () => {
      const dock = makeDock();
      dock.handleResizeHandleDragStart();
      advanceFrame();
      moveDock(dock, 250);
      const canceledCallbacks = [...frames.values()];
      const setState = spyOn(dock, "setState").and.callThrough();

      dock.destroy();
      canceledCallbacks.forEach((callback) => callback(performance.now()));
      advanceFrame();

      expect(setState).not.toHaveBeenCalled();
      expect(dockSize(dock)).toBe(200);
      expect(isLayoutDragActive()).toBe(false);
    });

    it("keeps programmatic sizing, showing and double-click fitting synchronous", () => {
      const dock = makeDock();
      dock.setState({ size: 230 });
      expect(dockSize(dock)).toBe(230);
      dock.hide();
      advanceFrame();
      expect(dockSize(dock)).toBe(0);
      dock.show();
      expect(dockSize(dock)).toBe(230);
      dock.getActivePane().addItem({
        element: document.createElement("div"),
        getDefaultLocation: () => "left",
        getPreferredWidth: () => 215,
      });
      dock.element
        .querySelector(".lumine-dock-resize-handle")
        .dispatchEvent(new MouseEvent("mousedown", { detail: 2, button: 0, buttons: 1 }));

      expect(dockSize(dock)).toBe(215);
      expect(isLayoutDragActive()).toBe(false);
    });
  });

  describe("pane dividers", () => {
    for (const horizontal of [true, false]) {
      it(`commits only the latest ${horizontal ? "horizontal" : "vertical"} split in a burst`, () => {
        const divider = makeDivider(horizontal);
        const { previous, next, total } = divider;
        const previousScale = spyOn(previous.model, "setFlexScale").and.callThrough();
        const nextScale = spyOn(next.model, "setFlexScale").and.callThrough();
        startDivider(divider);
        moveDivider(divider, total * 0.3);
        moveDivider(divider, total * 0.5);
        moveDivider(divider, total * 0.65);
        expect(previousScale).not.toHaveBeenCalled();
        expect(nextScale).not.toHaveBeenCalled();
        expect(previousSize(divider)).toBe(total / 2);

        advanceFrame();

        expect(previousSize(divider)).toBe(total * 0.65);
        expect(previousScale.calls.count()).toBe(1);
        expect(nextScale.calls.count()).toBe(1);
        expect(previous.model.getFlexScale() + next.model.getFlexScale()).toBeCloseTo(2, 8);
      });
    }

    it("exposes the final split to drag-end observers before its scheduled frame", () => {
      const divider = makeDivider();
      const observed = [];
      observeEnd(() => observed.push([previousSize(divider), isLayoutDragActive()]));
      startDivider(divider);
      moveDivider(divider, 390);
      const canceledCallbacks = [...frames.values()];

      releaseDivider();

      expect(observed).toEqual([[390, false]]);
      canceledCallbacks.forEach((callback) => callback(performance.now()));
      advanceFrame();
      expect(previousSize(divider)).toBe(390);
      expect(observed.length).toBe(1);
    });

    it("flushes the last held-button position after a missed release", () => {
      const divider = makeDivider();
      startDivider(divider);
      moveDivider(divider, 390);
      moveDivider(divider, 420, 0);

      expect(previousSize(divider)).toBe(390);
      expect(isLayoutDragActive()).toBe(false);
      advanceFrame();
      expect(previousSize(divider)).toBe(390);
    });

    it("balances the drag signal after repeated start and release events", () => {
      const divider = makeDivider();
      const ended = jasmine.createSpy("ended");
      observeEnd(ended);
      startDivider(divider);
      startDivider(divider);
      releaseDivider();
      releaseDivider();

      expect(ended.calls.count()).toBe(1);
      expect(isLayoutDragActive()).toBe(false);
      expect(divider.handle.querySelector(".lumine-pane-cursor-overlay")).toBe(null);
    });

    for (const reparent of [false, true]) {
      it(`discards queued splits when the handle is ${reparent ? "reparented" : "disconnected"}`, () => {
        const divider = makeDivider();
        const previousScale = spyOn(divider.previous.model, "setFlexScale").and.callThrough();
        const nextScale = spyOn(divider.next.model, "setFlexScale").and.callThrough();
        startDivider(divider);
        moveDivider(divider, 390);
        const canceledCallbacks = [...frames.values()];

        if (reparent) {
          const destination = makeDivider(false);
          destination.handle.replaceWith(divider.handle);
        } else {
          divider.axis.remove();
        }
        canceledCallbacks.forEach((callback) => callback(performance.now()));
        advanceFrame();

        expect(previousScale).not.toHaveBeenCalled();
        expect(nextScale).not.toHaveBeenCalled();
        expect(isLayoutDragActive()).toBe(false);
        expect(divider.handle.querySelector(".lumine-pane-cursor-overlay")).toBe(null);
      });
    }

    it("does not apply a pending split to a replaced neighbor", () => {
      const divider = makeDivider();
      const replacement = makeSide();
      const previousScale = spyOn(divider.previous.model, "setFlexScale").and.callThrough();
      const replacementScale = spyOn(replacement.model, "setFlexScale").and.callThrough();
      startDivider(divider);
      moveDivider(divider, 390);
      divider.next.replaceWith(replacement);

      advanceFrame();

      expect(previousScale).not.toHaveBeenCalled();
      expect(replacementScale).not.toHaveBeenCalled();
      expect(isLayoutDragActive()).toBe(false);
    });

    it("does not resize a pane whose model was destroyed before the frame", () => {
      const divider = makeDivider();
      const previousScale = spyOn(divider.previous.model, "setFlexScale").and.callThrough();
      const nextScale = spyOn(divider.next.model, "setFlexScale").and.callThrough();
      startDivider(divider);
      moveDivider(divider, 390);
      divider.next.model.destroyed = true;

      advanceFrame();

      expect(previousScale).not.toHaveBeenCalled();
      expect(nextScale).not.toHaveBeenCalled();
      expect(isLayoutDragActive()).toBe(false);
    });

    it("keeps finite pane scales when either axis becomes hidden before the frame", () => {
      for (const horizontal of [true, false]) {
        const divider = makeDivider(horizontal);
        startDivider(divider);
        moveDivider(divider, divider.total * 0.65);
        divider.axis.style.display = "none";

        advanceFrame();

        expect(divider.previous.model.getFlexScale()).toBe(1);
        expect(divider.next.model.getFlexScale()).toBe(1);
        expect(isLayoutDragActive()).toBe(false);
      }
    });
  });

  it("settles pending dock and divider positions when the window loses focus", () => {
    const dock = makeDock();
    dock.handleResizeHandleDragStart();
    moveDock(dock, 250);
    window.dispatchEvent(new FocusEvent("blur"));
    expect(dockSize(dock)).toBe(250);
    expect(isLayoutDragActive()).toBe(false);

    const divider = makeDivider();
    startDivider(divider);
    moveDivider(divider, 390);
    window.dispatchEvent(new FocusEvent("blur"));
    expect(previousSize(divider)).toBe(390);
    expect(isLayoutDragActive()).toBe(false);
    advanceFrame();
    expect(dockSize(dock)).toBe(250);
    expect(previousSize(divider)).toBe(390);
  });
});
