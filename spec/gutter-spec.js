const Gutter = require("../src/gutter");

describe("Gutter", () => {
  const fakeGutterContainer = {
    scheduleComponentUpdate() {},
  };
  const name = "name";

  describe("::hide", () =>
    it("hides the gutter if it is visible.", () => {
      const options = {
        name,
        visible: true,
      };
      const gutter = new Gutter(fakeGutterContainer, options);
      const events = [];
      gutter.onDidChangeVisible((gutter) => events.push(gutter.isVisible()));

      expect(gutter.isVisible()).toBe(true);
      gutter.hide();
      expect(gutter.isVisible()).toBe(false);
      expect(events).toEqual([false]);
      gutter.hide();
      expect(gutter.isVisible()).toBe(false);
      // An event should only be emitted when the visibility changes.
      expect(events.length).toBe(1);
    }));

  describe("::show", () =>
    it("shows the gutter if it is hidden.", () => {
      const options = {
        name,
        visible: false,
      };
      const gutter = new Gutter(fakeGutterContainer, options);
      const events = [];
      gutter.onDidChangeVisible((gutter) => events.push(gutter.isVisible()));

      expect(gutter.isVisible()).toBe(false);
      gutter.show();
      expect(gutter.isVisible()).toBe(true);
      expect(events).toEqual([true]);
      gutter.show();
      expect(gutter.isVisible()).toBe(true);
      // An event should only be emitted when the visibility changes.
      expect(events.length).toBe(1);
    }));

  describe("::destroy", () => {
    let mockGutterContainer, mockGutterContainerRemovedGutters;

    beforeEach(() => {
      mockGutterContainerRemovedGutters = [];
      mockGutterContainer = {
        removeGutter(destroyedGutter) {
          mockGutterContainerRemovedGutters.push(destroyedGutter);
        },
      };
    });

    it("removes the gutter from its container.", () => {
      const gutter = new Gutter(mockGutterContainer, { name });
      gutter.destroy();
      expect(mockGutterContainerRemovedGutters).toEqual([gutter]);
    });

    it("calls all callbacks registered on ::onDidDestroy.", () => {
      const gutter = new Gutter(mockGutterContainer, { name });
      let didDestroy = false;
      gutter.onDidDestroy(() => {
        didDestroy = true;
      });
      gutter.destroy();
      expect(didDestroy).toBe(true);
    });

    it("does not allow destroying the line-number gutter", () => {
      const gutter = new Gutter(mockGutterContainer, { name: "line-number" });
      expect(gutter.destroy).toThrow();
    });
  });
});

describe("Native class-only gutter decorations", () => {
  let editor;
  let element;

  afterEach(() => {
    editor?.destroy();
    element?.remove();
  });

  async function paint() {
    const pending = element.getNextUpdatePromise();
    element.getComponent().scheduleUpdate();
    await pending;
  }

  for (const itemProperties of [{ item: null }, {}]) {
    it(`renders, moves, and removes a gutter background with ${itemProperties.item === null ? "a null" : "an omitted"} item`, async () => {
      editor = lumine.workspace.buildTextEditor();
      editor.setText("first\nsecond\nthird\nfourth");
      element = editor.getElement();
      element.style.cssText = "width: 400px; height: 180px;";
      element.setUpdatedSynchronously(false);
      const stylesheet = document.createElement("style");
      stylesheet.textContent =
        ".native-class-only-background { width: 100%; background-color: rgb(20, 100, 160); }";
      jasmine.attachToDOM(stylesheet);
      const gutter = editor.addGutter({ name: "background-only", type: "decorated" });
      gutter.getElement().style.width = "20px";
      const marker = editor.markBufferRange([
        [0, 0],
        [1, Infinity],
      ]);
      const decoration = gutter.decorateMarker(marker, {
        class: "native-class-only-background",
        ...itemProperties,
      });
      jasmine.attachToDOM(element);
      await paint();
      const component = element.getComponent();
      const background = gutter.getElement().querySelector(".native-class-only-background");
      expect(background).not.toBeNull();
      expect(background.childElementCount).toBe(0);
      expect(getComputedStyle(background).backgroundColor).toBe("rgb(20, 100, 160)");
      expect(parseFloat(background.style.top)).toBe(0);
      expect(parseFloat(background.style.height)).toBeCloseTo(2 * component.getLineHeight(), 2);
      marker.setBufferRange([
        [2, 0],
        [2, Infinity],
      ]);
      await paint();
      const moved = gutter.getElement().querySelector(".native-class-only-background");
      expect(moved.childElementCount).toBe(0);
      expect(parseFloat(moved.style.top)).toBeCloseTo(2 * component.getLineHeight(), 2);
      expect(parseFloat(moved.style.height)).toBeCloseTo(component.getLineHeight(), 2);
      marker.destroy();
      await paint();
      expect(decoration.isDestroyed()).toBe(true);
      expect(gutter.getElement().querySelector(".native-class-only-background")).toBeNull();
    });
  }
});
