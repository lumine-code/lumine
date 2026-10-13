const { ipcRenderer } = require("electron");
const { isLayoutDragActive } = require("../src/layout-drag");

describe("layout resizing with focused embedded content", () => {
  let workspace, frame, sourcePane, handle;
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  };
  const mouse = (type, x, y, held = false) =>
    ipcRenderer.invoke("lumine:window", "sendInputEvent", {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
      modifiers: held ? ["leftButtonDown"] : [],
    });

  beforeEach(() => {
    jasmine.useRealClock();
    frame = handle = null;
    workspace = lumine.workspace;
    const root = workspace.getElement();
    root.style.cssText = "position: fixed; left: 0; top: 0; width: 800px; height: 500px;";
    jasmine.attachToDOM(root);
    sourcePane = workspace.getCenter().getActivePane();
  });

  async function loadFrame(opaque = false) {
    const element = document.createElement("div");
    element.style.cssText = "height: 100%; width: 100%;";
    frame = document.createElement("iframe");
    frame.style.cssText = "height: 100%; width: 100%; border: 0;";
    if (opaque) frame.setAttribute("sandbox", "allow-scripts");
    const loaded = new Promise((resolve) =>
      frame.addEventListener("load", resolve, { once: true }),
    );
    frame.srcdoc = '<input id="input" value="retained"><p>Embedded viewer</p>';
    element.appendChild(frame);
    element.focus = () => frame.focus();
    sourcePane.activateItem({ element, getTitle: () => "Embedded viewer" });
    await loaded;
    sourcePane.activate();
    if (opaque) frame.focus();
    else frame.contentDocument.getElementById("input").focus();
    await settle();
    expect(document.activeElement).toBe(frame);
    if (opaque) expect(frame.contentDocument).toBeNull();
  }

  afterEach(async () => {
    await mouse("mouseUp", 1, 1);
    handle?.resizeStopped(false);
    // Retire the child browsing context after returning focus to the parent
    // widget, so the next spec can acquire native focus after its teardown.
    const focusExit = document.createElement("button");
    jasmine.attachToDOM(focusExit);
    focusExit.focus();
    await settle();
  });

  function expectFrameFocus(opaque) {
    expect(document.activeElement).toBe(frame);
    if (!opaque) expect(frame.contentDocument.activeElement.id).toBe("input");
  }

  it("preserves text-editor focus while resizing with native input", async () => {
    sourcePane.splitRight({ activate: false });
    const editor = await workspace.open();
    editor.getElement().focus();
    await settle();
    const input = document.activeElement;
    expect(editor.getElement().contains(input)).toBe(true);
    handle = workspace.getElement().querySelector("lumine-pane-resize-handle");
    const rect = handle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const before = sourcePane.getFlexScale();
    await mouse("mouseMove", x, y);
    await mouse("mouseDown", x, y, true);
    await mouse("mouseMove", x + 50, y, true);
    await settle();
    expect(sourcePane.getFlexScale()).not.toBe(before);
    expect(document.activeElement).toBe(input);
    await mouse("mouseUp", x + 50, y);
    await settle();
    expect(isLayoutDragActive()).toBe(false);
  });

  for (const opaque of [false, true]) {
    for (const horizontal of [true, false]) {
      it(`resizes a ${horizontal ? "horizontal" : "vertical"} split over a focused ${opaque ? "opaque" : "same-origin"} iframe`, async () => {
        sourcePane[horizontal ? "splitRight" : "splitDown"]({ activate: false });
        await loadFrame(opaque);
        handle = workspace.getElement().querySelector("lumine-pane-resize-handle");
        const rect = handle.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const nextX = x - (horizontal ? 80 : 0);
        const nextY = y - (horizontal ? 0 : 80);
        const before = sourcePane.getFlexScale();
        await mouse("mouseMove", x, y);
        await mouse("mouseDown", x, y, true);
        await settle();
        expect(isLayoutDragActive()).toBe(true);
        expect(handle.layoutDrag).not.toBeNull();
        expect(getComputedStyle(frame).pointerEvents).toBe("none");
        await mouse("mouseMove", nextX, nextY, true);
        await settle();
        expect(sourcePane.getFlexScale()).not.toBe(before);
        expectFrameFocus(opaque);
        await mouse("mouseUp", nextX, nextY);
        await settle();
        expect(isLayoutDragActive()).toBe(false);
        expect(getComputedStyle(frame).pointerEvents).toBe("auto");
        expectFrameFocus(opaque);
      });
    }

    for (const location of ["left", "right", "bottom"]) {
      it(`resizes the ${location} dock over a focused ${opaque ? "opaque" : "same-origin"} iframe`, async () => {
        const dock = workspace
          .getPaneContainers()
          .find((container) => container.getLocation() === location);
        dock.getActivePane().addItem({
          element: document.createElement("div"),
          getTitle: () => "Dock item",
          getAllowedLocations: () => [location],
          getDefaultLocation: () => location,
        });
        dock.setState({ size: 150 });
        dock.show();
        await loadFrame(opaque);
        const grip = dock.getElement().querySelector(".lumine-dock-resize-handle");
        const rect = grip.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const nextX = x + (location === "left" ? 60 : location === "right" ? -60 : 0);
        const nextY = y - (location === "bottom" ? 60 : 0);
        await mouse("mouseMove", x, y);
        await mouse("mouseDown", x, y, true);
        await settle();
        expect(isLayoutDragActive()).toBe(true);
        expect(getComputedStyle(frame).pointerEvents).toBe("none");
        await mouse("mouseMove", nextX, nextY, true);
        await settle();
        expect(dock.state.size).toBeGreaterThan(150);
        expectFrameFocus(opaque);
        await mouse("mouseUp", nextX, nextY);
        await settle();
        expect(isLayoutDragActive()).toBe(false);
        expect(getComputedStyle(frame).pointerEvents).toBe("auto");
        expectFrameFocus(opaque);
      });
    }
  }
});
