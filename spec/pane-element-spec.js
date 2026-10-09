const PaneContainer = require("../src/pane-container");

describe("PaneElement", function () {
  let [paneElement, container, containerElement, pane] = [];

  beforeEach(function () {
    spyOn(lumine.applicationDelegate, "open");

    container = new PaneContainer({
      location: "center",
      config: lumine.config,
      confirm: lumine.window.confirm.bind(lumine.window),
      viewRegistry: lumine.views,
      applicationDelegate: lumine.applicationDelegate,
    });
    containerElement = container.getElement();
    pane = container.getActivePane();
    paneElement = pane.getElement();
  });

  describe("when the pane's active status changes", function () {
    it("preserves the .active class when an active pane is attached", function () {
      expect(pane.isActive()).toBe(true);
      expect(paneElement.className).toMatch(/active/);

      jasmine.attachToDOM(paneElement);

      expect(paneElement.className).toMatch(/active/);
    });

    it("adds or removes the .active class as appropriate", function () {
      const pane2 = pane.splitRight();
      expect(pane2.isActive()).toBe(true);

      expect(paneElement.className).not.toMatch(/active/);
      pane.activate();
      expect(paneElement.className).toMatch(/active/);
      pane2.activate();
      expect(paneElement.className).not.toMatch(/active/);
    });
  });

  describe("when the pane is empty", function () {
    const watermarkStyle = () => getComputedStyle(paneElement.itemViews, "::after");

    beforeEach(function () {
      containerElement.style.setProperty("--text-color-faded", "rgb(1, 2, 3)");
      containerElement.style.width = "800px";
      containerElement.style.height = "500px";
      jasmine.attachToDOM(containerElement);
    });

    afterEach(function () {
      document.body.classList.remove("is-unloading");
      lumine.config.unset("core.showEmptyPaneLogo");
    });

    it("shows the Lumine mark until an item is added", async function () {
      expect(watermarkStyle().content).toBe('""');
      expect(watermarkStyle().backgroundColor).toBe("rgb(1, 2, 3)");
      expect(watermarkStyle().webkitMaskImage).toContain("lumine-raw.svg");

      const item = document.createElement("div");
      pane.addItem(item);
      expect(watermarkStyle().content).toBe("none");

      await pane.destroyItem(item);
      expect(watermarkStyle().content).toBe('""');
    });

    it("does not show the mark in a dock pane", function () {
      const dock = document.createElement("lumine-dock");
      containerElement.remove();
      dock.appendChild(containerElement);
      jasmine.attachToDOM(dock);

      expect(watermarkStyle().content).toBe("none");
    });

    it("follows the empty-pane logo setting live", function () {
      expect(lumine.config.get("core.showEmptyPaneLogo")).toBe(true);
      expect(paneElement).toHaveClass("empty-pane-logo-visible");
      expect(watermarkStyle().content).toBe('""');

      lumine.config.set("core.showEmptyPaneLogo", false);
      expect(paneElement).not.toHaveClass("empty-pane-logo-visible");
      expect(watermarkStyle().content).toBe("none");

      lumine.config.set("core.showEmptyPaneLogo", true);
      expect(paneElement).toHaveClass("empty-pane-logo-visible");
      expect(watermarkStyle().content).toBe('""');
    });

    it("hides the mark while the editor window unloads", function () {
      expect(watermarkStyle().content).toBe('""');

      document.body.classList.add("is-unloading");

      expect(watermarkStyle().content).toBe("none");
    });

    it("moves the mark above background tips and restores it when they leave", function () {
      const styles = document.createElement("style");
      styles.textContent =
        "lumine-pane > .item-views:empty::after { transition: none !important; }";
      jasmine.attachToDOM(styles);
      const centeredTransform = watermarkStyle().transform;
      const centeredTop = watermarkStyle().top;
      expect(centeredTransform).not.toBe("none");
      const transform = new DOMMatrixReadOnly(centeredTransform);
      expect(transform.m41).toBeCloseTo(-parseFloat(watermarkStyle().width) / 2, 1);
      expect(transform.m42).toBeCloseTo(-parseFloat(watermarkStyle().height) / 2, 1);

      const backgroundTips = document.createElement("background-tips");
      paneElement.appendChild(backgroundTips);
      expect(watermarkStyle().transform).not.toBe("none");
      expect(watermarkStyle().transform).not.toBe(centeredTransform);
      expect(watermarkStyle().top).toBe(centeredTop);

      backgroundTips.remove();
      expect(watermarkStyle().transform).toBe(centeredTransform);
      expect(watermarkStyle().top).toBe(centeredTop);
    });

    it("animates toward background tips but returns to centre immediately", function () {
      expect(watermarkStyle().transitionDuration).toBe("0s");

      const backgroundTips = document.createElement("background-tips");
      paneElement.appendChild(backgroundTips);
      expect(watermarkStyle().transitionDuration).toBe("0.3s");
      expect(watermarkStyle().transitionProperty).toBe("transform");

      backgroundTips.remove();
      expect(watermarkStyle().transitionDuration).toBe("0s");
    });

    it("keeps its composition position when the empty viewport is resized", function () {
      const styles = document.createElement("style");
      styles.textContent =
        "lumine-pane > .item-views:empty::after { transition: none !important; }";
      jasmine.attachToDOM(styles);
      containerElement.style.setProperty("--ui-spacing", "8px");
      const backgroundTips = document.createElement("background-tips");
      paneElement.appendChild(backgroundTips);
      for (const height of [300.375, 900.625]) {
        containerElement.style.height = `${height}px`;
        const viewportHeight = paneElement.itemViews.getBoundingClientRect().height;
        const markHeight = parseFloat(watermarkStyle().height);
        const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const offset = Math.min(8 * rootFontSize, 0.18 * viewportHeight);
        const transform = new DOMMatrixReadOnly(watermarkStyle().transform);
        expect(parseFloat(watermarkStyle().top)).toBeCloseTo(viewportHeight / 2, 1);
        expect(transform.m42).toBeCloseTo(offset - markHeight - 24, 1);
      }
    });

    it("preserves custom offsets and leaves populated viewports outside size containment", function () {
      const backgroundTips = document.createElement("background-tips");
      paneElement.appendChild(backgroundTips);
      for (const offset of ["30px", "20%", "min(8rem, 25%)"]) {
        paneElement.style.setProperty("--empty-pane-content-offset", offset);
        expect(getComputedStyle(paneElement.itemViews).containerType).toBe("normal");
        expect(watermarkStyle().transitionProperty).toBe("top, transform");
      }
      paneElement.style.removeProperty("--empty-pane-content-offset");
      expect(getComputedStyle(paneElement.itemViews).containerType).toBe("size");
      pane.addItem(document.createElement("div"));
      expect(getComputedStyle(paneElement.itemViews).containerType).toBe("normal");
      expect(watermarkStyle().content).toBe("none");
    });

    it("keeps background tips after the item views when the pane reconnects", function () {
      const backgroundTips = document.createElement("background-tips");
      paneElement.appendChild(backgroundTips);
      expect(paneElement.itemViews.nextElementSibling).toBe(backgroundTips);

      containerElement.remove();
      jasmine.attachToDOM(containerElement);

      expect(paneElement.itemViews.nextElementSibling).toBe(backgroundTips);
    });
  });

  describe("when the active item changes", function () {
    it("hides all item elements except the active one", function () {
      const item1 = document.createElement("div");
      const item2 = document.createElement("div");
      const item3 = document.createElement("div");
      pane.addItem(item1);
      pane.addItem(item2);
      pane.addItem(item3);

      expect(pane.getActiveItem()).toBe(item1);
      expect(item1.parentElement).toBeDefined();
      expect(item1.style.display).toBe("");
      expect(item2.parentElement).toBeNull();
      expect(item3.parentElement).toBeNull();

      pane.activateItem(item2);
      expect(item2.parentElement).toBeDefined();
      expect(item1.style.display).toBe("none");
      expect(item2.style.display).toBe("");
      expect(item3.parentElement).toBeNull();

      pane.activateItem(item3);
      expect(item3.parentElement).toBeDefined();
      expect(item1.style.display).toBe("none");
      expect(item2.style.display).toBe("none");
      expect(item3.style.display).toBe("");
    });

    it("shows the active item's view when the pane element is reattached", function () {
      // Splitting a pane replaces it with an axis containing it, so the pane
      // element is detached and reattached. An item activated during that
      // window is only hidden, never shown, so reattaching has to show it.
      const item1 = document.createElement("div");
      const item2 = document.createElement("div");
      pane.addItem(item1);
      pane.addItem(item2);
      jasmine.attachToDOM(paneElement);

      pane.activateItem(item2);
      pane.activateItem(item1);
      expect(item2.style.display).toBe("none");

      paneElement.remove();
      pane.activateItem(item2);
      jasmine.attachToDOM(paneElement);

      expect(item1.style.display).toBe("none");
      expect(item2.style.display).toBe("");
    });

    it("transfers focus to the new item if the previous item was focused", function () {
      const item1 = document.createElement("div");
      item1.tabIndex = -1;
      const item2 = document.createElement("div");
      item2.tabIndex = -1;
      pane.addItem(item1);
      pane.addItem(item2);
      jasmine.attachToDOM(paneElement);
      paneElement.focus();

      expect(document.activeElement).toBe(item1);
      pane.activateItem(item2);
      expect(document.activeElement).toBe(item2);
    });

    it("keeps focus in the pane when the focused last item is destroyed", async function () {
      // Removing the focused element drops focus on `body` without firing any
      // blur event. With no next item to hand focus to, the pane element
      // itself has to take it, or the workspace ends up with nothing focused.
      const item = document.createElement("div");
      item.tabIndex = -1;
      pane.addItem(item);
      jasmine.attachToDOM(paneElement);
      item.focus();
      expect(document.activeElement).toBe(item);

      await pane.destroyItem(item);

      expect(pane.isAlive()).toBe(true);
      expect(pane.getItems().length).toBe(0);
      expect(document.activeElement).toBe(paneElement);
    });

    describe("if the active item is a model object", () =>
      it("retrieves the associated view from lumine.views and appends it to the itemViews div", function () {
        class TestModel {}

        lumine.views.addViewProvider(TestModel, function (model) {
          const view = document.createElement("div");
          view.model = model;
          return view;
        });

        const item1 = new TestModel();
        const item2 = new TestModel();
        pane.addItem(item1);
        pane.addItem(item2);

        expect(paneElement.itemViews.children[0].model).toBe(item1);
        expect(paneElement.itemViews.children[0].style.display).toBe("");
        pane.activateItem(item2);
        expect(paneElement.itemViews.children[1].model).toBe(item2);
        expect(paneElement.itemViews.children[0].style.display).toBe("none");
        expect(paneElement.itemViews.children[1].style.display).toBe("");
      }));

    describe("when the new active implements .getPath()", function () {
      it("adds the file path and file name as a data attribute on the pane", function () {
        const item1 = document.createElement("div");
        item1.getPath = () => "/foo/bar.txt";
        const item2 = document.createElement("div");
        pane.addItem(item1);
        pane.addItem(item2);

        expect(paneElement.dataset.activeItemPath).toBe("/foo/bar.txt");
        expect(paneElement.dataset.activeItemName).toBe("bar.txt");

        pane.activateItem(item2);

        expect(paneElement.dataset.activeItemPath).toBeUndefined();
        expect(paneElement.dataset.activeItemName).toBeUndefined();

        pane.activateItem(item1);
        expect(paneElement.dataset.activeItemPath).toBe("/foo/bar.txt");
        expect(paneElement.dataset.activeItemName).toBe("bar.txt");

        pane.destroyItems();
        expect(paneElement.dataset.activeItemPath).toBeUndefined();
        expect(paneElement.dataset.activeItemName).toBeUndefined();
      });

      describe("when the path of the item changes", function () {
        let [item1, item2] = [];

        beforeEach(function () {
          item1 = document.createElement("div");
          item1.path = "/foo/bar.txt";
          item1.changePathCallbacks = [];
          item1.setPath = function (path) {
            this.path = path;
            for (let callback of Array.from(this.changePathCallbacks)) {
              callback();
            }
          };
          item1.getPath = function () {
            return this.path;
          };
          item1.onDidChangePath = function (callback) {
            this.changePathCallbacks.push(callback);
            return {
              dispose: () => {
                this.changePathCallbacks = this.changePathCallbacks.filter((f) => f !== callback);
              },
            };
          };

          item2 = document.createElement("div");

          pane.addItem(item1);
          pane.addItem(item2);
        });

        it("changes the file path and file name data attributes on the pane if the active item path is changed", function () {
          expect(paneElement.dataset.activeItemPath).toBe("/foo/bar.txt");
          expect(paneElement.dataset.activeItemName).toBe("bar.txt");

          item1.setPath("/foo/bar1.txt");

          expect(paneElement.dataset.activeItemPath).toBe("/foo/bar1.txt");
          expect(paneElement.dataset.activeItemName).toBe("bar1.txt");

          pane.activateItem(item2);

          expect(paneElement.dataset.activeItemPath).toBeUndefined();
          expect(paneElement.dataset.activeItemName).toBeUndefined();

          item1.setPath("/foo/bar2.txt");

          expect(paneElement.dataset.activeItemPath).toBeUndefined();
          expect(paneElement.dataset.activeItemName).toBeUndefined();

          pane.activateItem(item1);

          expect(paneElement.dataset.activeItemPath).toBe("/foo/bar2.txt");
          expect(paneElement.dataset.activeItemName).toBe("bar2.txt");
        });
      });
    });
  });

  describe("when an item is removed from the pane", function () {
    describe("when the destroyed item is an element", () =>
      it("removes the item from the itemViews div", function () {
        const item1 = document.createElement("div");
        const item2 = document.createElement("div");
        pane.addItem(item1);
        pane.addItem(item2);
        paneElement = pane.getElement();

        expect(item1.parentElement).toBe(paneElement.itemViews);
        pane.destroyItem(item1);
        expect(item1.parentElement).toBeNull();
        expect(item2.parentElement).toBe(paneElement.itemViews);
        pane.destroyItem(item2);
        expect(item2.parentElement).toBeNull();
      }));

    describe("when the destroyed item is a model", () =>
      it("removes the model's associated view", function () {
        class TestModel {}

        lumine.views.addViewProvider(TestModel, function (model) {
          const view = document.createElement("div");
          model.element = view;
          view.model = model;
          return view;
        });

        const item1 = new TestModel();
        const item2 = new TestModel();
        pane.addItem(item1);
        pane.addItem(item2);

        expect(item1.element.parentElement).toBe(paneElement.itemViews);
        pane.destroyItem(item1);
        expect(item1.element.parentElement).toBeNull();
        expect(item2.element.parentElement).toBe(paneElement.itemViews);
        pane.destroyItem(item2);
        expect(item2.element.parentElement).toBeNull();
      }));
  });

  describe("when the pane element is focused", function () {
    it("transfers focus to the active view", function () {
      const item = document.createElement("div");
      item.tabIndex = -1;
      pane.activateItem(item);
      jasmine.attachToDOM(paneElement);

      expect(document.activeElement).toBe(document.body);
      paneElement.focus();
      expect(document.activeElement).toBe(item);

      document.body.focus();
      pane.activate();
      expect(document.activeElement).toBe(item);
    });

    it("reaches the active view even when no focus event is delivered", function () {
      const item = document.createElement("div");
      item.tabIndex = -1;
      pane.activateItem(item);
      jasmine.attachToDOM(paneElement);
      document.body.focus();

      // The pane element only hands focus on to its item from its own capture
      // listener, and a `focus()` call fires no event at all while the window
      // is not the focused one -- the state a native menu leaves the renderer
      // in. Swallowing the event here stands in for that, and what is left has
      // to be enough on its own.
      const swallow = (event) => event.stopPropagation();
      document.addEventListener("focus", swallow, { capture: true });
      try {
        pane.activate();
      } finally {
        document.removeEventListener("focus", swallow, { capture: true });
      }

      expect(document.activeElement).toBe(item);
    });

    it("makes the pane active", function () {
      pane.splitRight();
      expect(pane.isActive()).toBe(false);

      jasmine.attachToDOM(paneElement);
      paneElement.focus();

      expect(pane.isActive()).toBe(true);
    });

    it("does not re-activate the pane when focus changes within the pane", function () {
      const item = document.createElement("div");
      const itemChild = document.createElement("div");
      item.tabIndex = -1;
      itemChild.tabIndex = -1;
      item.appendChild(itemChild);
      jasmine.attachToDOM(paneElement);

      pane.activateItem(item);
      pane.activate();

      let activationCount = 0;
      pane.onDidActivate(() => activationCount++);

      itemChild.focus();
      expect(activationCount).toBe(0);
    });
  });

  describe("when focus leaves the pane", function () {
    // Chromium fires a blur with a null relatedTarget while it unfocuses a
    // subtree that is about to be detached -- what collapsing an axis does to
    // the surviving pane. `connectedCallback` restores focus from the model's
    // claim after that reparent, so only a blur that names a successor may
    // clear the claim.
    it("keeps the model's focus claim when the blur names no successor", function () {
      jasmine.attachToDOM(paneElement);
      paneElement.focus();
      expect(pane.isFocused()).toBe(true);

      paneElement.dispatchEvent(new FocusEvent("blur", { relatedTarget: null }));
      expect(pane.isFocused()).toBe(true);
    });

    it("clears the model's focus claim when the blur names an element outside the pane", function () {
      jasmine.attachToDOM(paneElement);
      paneElement.focus();
      expect(pane.isFocused()).toBe(true);

      const outside = document.createElement("div");
      outside.tabIndex = -1;
      jasmine.attachToDOM(outside);
      paneElement.dispatchEvent(new FocusEvent("blur", { relatedTarget: outside }));
      expect(pane.isFocused()).toBe(false);
    });
  });

  describe("when the pane element is attached", () =>
    it("focuses the pane element if isFocused() returns true on its model", function () {
      pane.focus();
      jasmine.attachToDOM(paneElement);
      expect(document.activeElement).toBe(paneElement);
    }));

  describe("resize", () =>
    it("shrinks independently of its contents' width", function () {
      jasmine.attachToDOM(containerElement);
      const item = document.createElement("div");
      item.style.width = "2000px";
      item.style.height = "30px";
      paneElement.insertBefore(item, paneElement.children[0]);

      paneElement.style.flexGrow = 0.1;
      expect(paneElement.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(paneElement.getBoundingClientRect().width).toBeLessThan(
        item.getBoundingClientRect().width,
      );

      paneElement.style.flexGrow = 0;
      expect(paneElement.getBoundingClientRect().width).toBe(0);
    }));
});
