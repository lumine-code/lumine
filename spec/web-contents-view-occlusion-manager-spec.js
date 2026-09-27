const WebContentsViewOcclusionManager = require("../src/web-contents-view-occlusion-manager");

describe("WebContentsViewOcclusionManager", () => {
  let manager;
  let anchor;

  beforeEach(() => {
    manager = new WebContentsViewOcclusionManager();
    anchor = document.createElement("div");
    jasmine.attachToDOM(anchor);
  });

  afterEach(() => manager.destroy());

  it("detects visible core context views over a native surface", () => {
    const overlay = document.createElement("div");
    overlay.className = "context-view";
    spyOn(overlay, "getBoundingClientRect").and.returnValue({
      left: 50,
      right: 150,
      top: 50,
      bottom: 150,
      width: 100,
      height: 100,
    });
    jasmine.attachToDOM(overlay);

    expect(
      manager.isOccluded(anchor, {
        left: 0,
        right: 100,
        top: 0,
        bottom: 100,
      }),
    ).toBe(true);
  });

  it("tracks package-owned overlays until their registration is disposed", () => {
    const overlay = document.createElement("div");
    spyOn(overlay, "getBoundingClientRect").and.returnValue({
      left: 10,
      right: 20,
      top: 10,
      bottom: 20,
      width: 10,
      height: 10,
    });
    jasmine.attachToDOM(overlay);
    const registration = manager.registerOverlay(overlay);
    const bounds = { left: 0, right: 100, top: 0, bottom: 100 };

    expect(manager.isOccluded(anchor, bounds)).toBe(true);
    registration.dispose();
    expect(manager.isOccluded(anchor, bounds)).toBe(false);
  });
});
