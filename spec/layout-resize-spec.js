const {
  beginLayoutResize,
  isLayoutResizeActive,
  onDidEndLayoutResize,
} = require("../src/layout-resize");
const { beginLayoutDrag, isLayoutDragActive, onDidEndLayoutDrag } = require("../src/layout-drag");

describe("continuous layout resize sessions", () => {
  let resources;

  beforeEach(() => {
    resources = [];
  });

  afterEach(() => {
    resources.reverse().forEach((resource) => resource.dispose());
  });

  function own(resource) {
    resources.push(resource);
    return resource;
  }

  it("settles only after every overlapping resize session ends", () => {
    const ended = jasmine.createSpy("resize ended");
    own(onDidEndLayoutResize(ended));
    const first = own(beginLayoutResize());
    const second = own(beginLayoutResize());
    expect(isLayoutResizeActive()).toBeTrue();
    first.dispose();
    first.dispose();
    expect(isLayoutResizeActive()).toBeTrue();
    expect(ended).not.toHaveBeenCalled();
    second.dispose();
    expect(isLayoutResizeActive()).toBeFalse();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("combines pointer drags with animation sessions while keeping pointer shielding separate", () => {
    const resized = jasmine.createSpy("resize ended");
    const dragged = jasmine.createSpy("drag ended");
    own(onDidEndLayoutResize(resized));
    own(onDidEndLayoutDrag(dragged));
    const animation = own(beginLayoutResize());
    expect(isLayoutDragActive()).toBeFalse();
    expect(document.documentElement.classList.contains("lumine-layout-dragging")).toBeFalse();
    const drag = own(beginLayoutDrag());
    expect(isLayoutResizeActive()).toBeTrue();
    expect(document.documentElement.classList.contains("lumine-layout-dragging")).toBeTrue();

    drag.dispose();

    expect(isLayoutResizeActive()).toBeTrue();
    expect(isLayoutDragActive()).toBeFalse();
    expect(document.documentElement.classList.contains("lumine-layout-dragging")).toBeFalse();
    expect(dragged).toHaveBeenCalledTimes(1);
    expect(resized).not.toHaveBeenCalled();
    animation.dispose();
    expect(resized).toHaveBeenCalledTimes(1);
  });

  it("keeps a remaining pointer drag active after an overlapping animation ends", () => {
    const animation = own(beginLayoutResize());
    const drag = own(beginLayoutDrag());
    animation.dispose();
    expect(isLayoutResizeActive()).toBeTrue();
    expect(isLayoutDragActive()).toBeTrue();
    expect(document.documentElement.classList.contains("lumine-layout-dragging")).toBeTrue();
    drag.dispose();
    expect(isLayoutResizeActive()).toBeFalse();
  });

  jasmine.itWithDocumentFocus(
    "leaves native input and embedded-frame pointer events enabled",
    () => {
      const input = document.createElement("input");
      const frame = document.createElement("iframe");
      frame.style.pointerEvents = "auto";
      jasmine.attachToDOM(input);
      jasmine.attachToDOM(frame);
      input.focus();
      const session = own(lumine.workspace.beginLayoutResize());
      expect(isLayoutResizeActive()).toBeTrue();
      expect(isLayoutDragActive()).toBeFalse();
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");
      expect(document.activeElement).toBe(input);
      input.value = "Editable throughout the animation";
      session.dispose();
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe("Editable throughout the animation");
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");
    },
  );
});
