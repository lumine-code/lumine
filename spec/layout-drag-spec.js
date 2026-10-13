const { beginLayoutDrag, isLayoutDragActive, onDidEndLayoutDrag } = require("../src/layout-drag");

describe("layout drags", () => {
  let drags, subscription, elements;

  beforeEach(() => {
    drags = [];
    elements = [];
  });

  afterEach(() => {
    if (subscription) {
      subscription.dispose();
      subscription = null;
    }
    drags.forEach((drag) => drag.dispose());
    elements.forEach((element) => element.remove());
  });

  function begin() {
    const drag = beginLayoutDrag();
    drags.push(drag);
    return drag;
  }

  it("reports whether a drag is in progress", () => {
    expect(isLayoutDragActive()).toBe(false);
    const drag = begin();
    expect(isLayoutDragActive()).toBe(true);
    drag.dispose();
    expect(isLayoutDragActive()).toBe(false);
  });

  it("notifies subscribers when the last drag ends", () => {
    const ended = jasmine.createSpy("ended");
    subscription = onDidEndLayoutDrag(ended);

    const drag = begin();
    expect(ended).not.toHaveBeenCalled();

    drag.dispose();
    expect(ended.calls.count()).toBe(1);
  });

  // A gesture ends down several paths — a mouseup, a mousemove that finds no
  // button held, a handle disconnected mid-drag, a dock destroyed — and more
  // than one of them can run for the same drag.
  it("ignores a repeated dispose", () => {
    const ended = jasmine.createSpy("ended");
    subscription = onDidEndLayoutDrag(ended);

    const drag = begin();
    drag.dispose();
    drag.dispose();

    expect(ended.calls.count()).toBe(1);
    expect(isLayoutDragActive()).toBe(false);
  });

  it("stays active until every drag has ended", () => {
    const ended = jasmine.createSpy("ended");
    subscription = onDidEndLayoutDrag(ended);

    const divider = begin();
    const dockHandle = begin();

    divider.dispose();
    expect(isLayoutDragActive()).toBe(true);
    expect(ended).not.toHaveBeenCalled();

    dockHandle.dispose();
    expect(isLayoutDragActive()).toBe(false);
    expect(ended.calls.count()).toBe(1);
  });

  it("is reachable from the workspace", () => {
    const drag = lumine.workspace.beginLayoutDrag();
    drags.push(drag);
    expect(isLayoutDragActive()).toBe(true);
    drag.dispose();
    expect(isLayoutDragActive()).toBe(false);
  });

  it("shields embedded surfaces until the last drag ends without rewriting their styles", () => {
    const frames = ["iframe", "webview", "embed", "object"].map((name) => {
      const element = document.createElement(name);
      element.style.pointerEvents = "auto";
      jasmine.attachToDOM(element);
      elements.push(element);
      return element;
    });
    const first = begin();
    const second = begin();
    frames.forEach((frame) => expect(getComputedStyle(frame).pointerEvents).toBe("none"));
    first.dispose();
    frames.forEach((frame) => expect(getComputedStyle(frame).pointerEvents).toBe("none"));
    second.dispose();
    frames.forEach((frame) => {
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");
      expect(frame.style.pointerEvents).toBe("auto");
    });
  });

  it("shields frames added after a drag starts", () => {
    const drag = begin();
    const frame = document.createElement("iframe");
    jasmine.attachToDOM(frame);
    elements.push(frame);
    expect(getComputedStyle(frame).pointerEvents).toBe("none");
    drag.dispose();
    expect(getComputedStyle(frame).pointerEvents).toBe("auto");
  });

  it("keeps pointer shields local to each document while the global drag signal remains active", () => {
    const otherDocument = document.implementation.createHTMLDocument("Other presentation");
    const first = begin();
    const second = beginLayoutDrag(otherDocument);
    drags.push(second);
    expect(document.documentElement.classList.contains("lumine-layout-dragging")).toBe(true);
    expect(otherDocument.documentElement.classList.contains("lumine-layout-dragging")).toBe(true);
    first.dispose();
    expect(document.documentElement.classList.contains("lumine-layout-dragging")).toBe(false);
    expect(otherDocument.documentElement.classList.contains("lumine-layout-dragging")).toBe(true);
    expect(isLayoutDragActive()).toBe(true);
    second.dispose();
    expect(otherDocument.documentElement.classList.contains("lumine-layout-dragging")).toBe(false);
    expect(isLayoutDragActive()).toBe(false);
  });
});
