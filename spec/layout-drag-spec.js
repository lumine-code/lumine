const { beginLayoutDrag, isLayoutDragActive, onDidEndLayoutDrag } = require("../src/layout-drag");

describe("layout drags", () => {
  let drags, subscription;

  beforeEach(() => {
    drags = [];
  });

  afterEach(() => {
    if (subscription) {
      subscription.dispose();
      subscription = null;
    }
    drags.forEach((drag) => drag.dispose());
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
});
