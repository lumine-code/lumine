const path = require("path");
const { conditionPromise, waitForFrames } = require("./helpers/async-spec-helpers");

function dispatchDrag(type, target, dataTransfer, x, y) {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}

function expectBounds(actual, expected) {
  for (const field of ["left", "top", "width", "height"]) {
    expect(actual[field]).toBeCloseTo(expected[field], 3);
  }
}

describe("workspace drop preview rendering", () => {
  const filePath = path.join(__dirname, "fixtures", "sample.js");
  let workspaceElement,
    workspaceStyle,
    manager,
    overlayStyle,
    item,
    pane,
    itemViews,
    controls,
    indicator,
    reporter,
    reporterVisibility;

  beforeEach(() => {
    jasmine.useRealClock();
    workspaceElement = lumine.workspace.getElement();
    workspaceStyle = workspaceElement.style.cssText;
    workspaceElement.style.cssText = `position: fixed; left: 17px; top: 23px; width: ${Math.min(640, window.innerWidth - 40)}px; height: ${Math.min(480, window.innerHeight - 60)}px;`;
    jasmine.attachToDOM(workspaceElement);
    reporter = document.querySelector(".spec-reporter-container");
    if (reporter) {
      reporterVisibility = reporter.style.visibility;
      reporter.style.visibility = "hidden";
    }
    manager = lumine.workspaceDrops;
    overlayStyle = manager.overlay.style.cssText;
    pane = lumine.workspace.getCenter().getActivePane();
    item = document.createElement("div");
    controls = document.createElement("button");
    controls.textContent = "Pane Controls";
    controls.style.cssText =
      "position: absolute; left: 10px; top: 0; width: 120px; height: 40px; z-index: 2147483647;";
    indicator = document.createElement("div");
    indicator.style.cssText =
      "position: absolute; left: 50%; top: 50%; width: 80px; height: 80px; transform: translate(-50%, -50%); z-index: 2147483647;";
    item.append(controls, indicator);
    pane.addItem(item);
    pane.activateItem(item);
    itemViews = pane.getElement().querySelector(":scope > .item-views");
  });

  afterEach(async () => {
    manager.clearActiveClaim();
    manager.overlay.style.cssText = overlayStyle;
    workspaceElement.style.cssText = workspaceStyle;
    if (reporter) reporter.style.visibility = reporterVisibility;
    for (const candidate of lumine.workspace.getCenter().getPanes()) {
      for (const paneItem of candidate.getItems()) await candidate.destroyItem(paneItem);
    }
  });

  function treeFileDrag() {
    const dataTransfer = new DataTransfer();
    manager.write(dataTransfer, {
      kind: "tree-entries",
      effect: "copyMove",
      allowedLocations: ["center"],
      source: { windowId: lumine.window.getId() },
      items: [{ type: "file", path: filePath }],
    });
    return dataTransfer;
  }

  function showFullPreview() {
    const rect = itemViews.getBoundingClientRect();
    const dataTransfer = treeFileDrag();
    const event = dispatchDrag(
      "dragover",
      item,
      dataTransfer,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    expect(event.defaultPrevented).toBe(true);
    return { rect, dataTransfer };
  }

  it("paints above pane controls and indicators without intercepting the drag", () => {
    controls.focus();
    expect(document.activeElement).toBe(controls);
    const { rect } = showFullPreview();
    const overlay = manager.overlay;
    expectBounds(overlay.getBoundingClientRect(), rect);
    expect(getComputedStyle(overlay).pointerEvents).toBe("none");
    expect(overlay.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(controls);

    try {
      for (const element of [controls, indicator]) {
        const bounds = element.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
        expect(document.elementFromPoint(x, y)).toBe(element);
        // Temporarily hit-test the visual-only preview to inspect its paint order.
        overlay.style.pointerEvents = "auto";
        expect(document.elementFromPoint(x, y)).toBe(overlay);
        overlay.style.pointerEvents = "none";
      }
    } finally {
      overlay.style.cssText = overlayStyle;
    }
    manager.clearActiveClaim();
    expect(document.activeElement).toBe(controls);
  });

  it("removes the preview from the top layer when a drag ends", () => {
    const { dataTransfer } = showFullPreview();
    expect(manager.overlay.matches(":popover-open")).toBe(true);
    dispatchDrag("dragend", item, dataTransfer, 0, 0);
    expect(manager.overlay.matches(":popover-open")).toBe(false);
    expect(manager.activeClaim).toBe(null);
  });

  it("tracks fractional pane bounds without rewriting unchanged preview geometry", () => {
    workspaceElement.style.left = "17.25px";
    workspaceElement.style.top = "23.5px";
    workspaceElement.style.width = "401.375px";
    workspaceElement.style.height = "301.625px";
    const { rect, dataTransfer } = showFullPreview();
    expectBounds(manager.overlay.getBoundingClientRect(), rect);
    const observer = new MutationObserver(() => {});
    observer.observe(manager.overlay, { attributes: true, attributeFilter: ["style"] });
    try {
      dispatchDrag(
        "dragover",
        item,
        dataTransfer,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      expect(observer.takeRecords().length).toBe(0);

      workspaceElement.style.width = "451.625px";
      const resizedRect = itemViews.getBoundingClientRect();
      dispatchDrag(
        "dragover",
        item,
        dataTransfer,
        resizedRect.left + resizedRect.width / 2,
        resizedRect.top + resizedRect.height / 2,
      );
      expectBounds(manager.overlay.getBoundingClientRect(), resizedRect);
      expect(observer.takeRecords().length).toBe(1);
    } finally {
      observer.disconnect();
    }
  });

  it("closes the previous preview when the workspace is rebound", () => {
    showFullPreview();
    const previousOverlay = manager.overlay;
    const replacement = document.createElement("div");
    workspaceElement.appendChild(replacement);
    try {
      manager.rebind(replacement);
      expect(previousOverlay.matches(":popover-open")).toBe(false);
      expect(previousOverlay.isConnected).toBe(false);
      expect(manager.overlay.matches(":popover-open")).toBe(false);
      expect(manager.activeClaim).toBe(null);
    } finally {
      manager.rebind(workspaceElement);
      replacement.remove();
    }
  });

  for (const direction of ["left", "right", "up", "down"]) {
    it(`previews and opens a tree file in a split ${direction} of a pane item`, async () => {
      const rect = itemViews.getBoundingClientRect();
      const horizontal = direction === "left" || direction === "right";
      const before = direction === "left" || direction === "up";
      const x = rect.left + rect.width * (horizontal ? (before ? 1 / 6 : 5 / 6) : 1 / 2);
      const y = rect.top + rect.height * (horizontal ? 1 / 2 : before ? 1 / 6 : 5 / 6);
      const dataTransfer = treeFileDrag();
      const drag = dispatchDrag("dragover", item, dataTransfer, x, y);
      expect(drag.defaultPrevented).toBe(true);
      expectBounds(manager.overlay.getBoundingClientRect(), {
        left: rect.left + (direction === "right" ? rect.width / 2 : 0),
        top: rect.top + (direction === "down" ? rect.height / 2 : 0),
        width: horizontal ? rect.width / 2 : rect.width,
        height: horizontal ? rect.height : rect.height / 2,
      });

      const drop = dispatchDrag("drop", item, dataTransfer, x, y);
      expect(drop.defaultPrevented).toBe(true);
      await conditionPromise(
        () => !manager.activeClaim && lumine.workspace.getCenter().getPanes().length === 2,
        "tree file split",
      );
      const destination = lumine.workspace
        .getCenter()
        .getPanes()
        .find((candidate) => candidate !== pane);
      const editor = destination.getActiveItem();
      expect(lumine.workspace.isTextEditor(editor)).toBe(true);
      expect(editor.getPath()).toBe(filePath);
      expect(pane.getActiveItem()).toBe(item);
      expect(lumine.workspace.paneForItem(item)).toBe(pane);
      expect(pane.getParent().getOrientation()).toBe(horizontal ? "horizontal" : "vertical");
      expect(pane.getParent().getChildren()).toEqual(
        before ? [destination, pane] : [pane, destination],
      );
      await waitForFrames(() => editor.getElement().offsetHeight > 0, {
        description: "opened editor layout",
      });
      expectBounds(
        editor.getElement().getBoundingClientRect(),
        destination.getElement().querySelector(":scope > .item-views").getBoundingClientRect(),
      );
      expect(manager.overlay.matches(":popover-open")).toBe(false);
    });
  }
});
