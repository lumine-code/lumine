const etch = require("@lumine-code/etch");

const getNextUpdatePromise = () => etch.getScheduler().nextUpdatePromise;

describe("Dock", () => {
  describe("an empty split pane's context menu", () => {
    it("offers Close Panel in every dock after the environment is reset", async () => {
      await lumine.reset();
      jasmine.attachToDOM(lumine.workspace.getElement());

      const docks = [
        lumine.workspace.getLeftDock(),
        lumine.workspace.getRightDock(),
        lumine.workspace.getBottomDock(),
      ];

      for (const dock of docks) {
        const pane = dock.getActivePane();
        pane.addItem(document.createElement("div"));
        const emptyPane = pane.splitRight();
        const itemViews = emptyPane.getElement().querySelector(":scope > .item-views");
        const items = lumine.contextMenu
          .templateForElement(itemViews)
          .map(({ label, command }) => ({ label, command }));

        expect(items).toEqual([{ label: "Close Panel", command: "pane:close" }]);
      }
    });
  });

  describe("hover-area hit testing", () => {
    it("reports no hover area before the dock has rendered", () => {
      const dock = lumine.workspace.getLeftDock();
      expect(dock.refs && dock.refs.innerElement).toBeFalsy();
      expect(dock.pointWithinHoverArea({ x: 0, y: 0 })).toBe(false);
      expect(dock.pointWithinHoverArea({ x: 0, y: 0 }, true)).toBe(false);
    });
  });

  describe("when a dock is activated", () => {
    it("opens the dock and activates its active pane", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getLeftDock();
      const didChangeVisibleSpy = jasmine.createSpy();
      dock.onDidChangeVisible(didChangeVisibleSpy);

      expect(dock.isVisible()).toBe(false);
      expect(document.activeElement).toBe(
        lumine.workspace.getCenter().getActivePane().getElement(),
      );
      dock.activate();
      expect(dock.isVisible()).toBe(true);
      expect(document.activeElement).toBe(dock.getActivePane().getElement());
      expect(didChangeVisibleSpy).toHaveBeenCalledWith(true);
    });
  });

  describe("when a dock is hidden", () => {
    it("transfers focus back to the active center pane if the dock had focus", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getLeftDock();
      const didChangeVisibleSpy = jasmine.createSpy();
      dock.onDidChangeVisible(didChangeVisibleSpy);

      dock.activate();
      expect(document.activeElement).toBe(dock.getActivePane().getElement());
      expect(didChangeVisibleSpy.calls.mostRecent().args[0]).toBe(true);

      dock.hide();
      expect(document.activeElement).toBe(
        lumine.workspace.getCenter().getActivePane().getElement(),
      );
      expect(didChangeVisibleSpy.calls.mostRecent().args[0]).toBe(false);

      dock.activate();
      expect(document.activeElement).toBe(dock.getActivePane().getElement());
      expect(didChangeVisibleSpy.calls.mostRecent().args[0]).toBe(true);

      dock.toggle();
      expect(document.activeElement).toBe(
        lumine.workspace.getCenter().getActivePane().getElement(),
      );
      expect(didChangeVisibleSpy.calls.mostRecent().args[0]).toBe(false);

      // Don't change focus if the dock was not focused in the first place
      const modalElement = document.createElement("div");
      modalElement.setAttribute("tabindex", -1);
      lumine.workspace.addModalPanel({ item: modalElement });
      modalElement.focus();
      expect(document.activeElement).toBe(modalElement);

      dock.show();
      expect(document.activeElement).toBe(modalElement);
      expect(didChangeVisibleSpy.calls.mostRecent().args[0]).toBe(true);

      dock.hide();
      expect(document.activeElement).toBe(modalElement);
      expect(didChangeVisibleSpy.calls.mostRecent().args[0]).toBe(false);
    });

    it("does not collapse a dock revealed as a drop target", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getRightDock();
      const inner = () => dock.getElement().querySelector(".lumine-dock-inner");
      const mask = () => inner().querySelector(".lumine-dock-mask");

      // A frameless window puts an OS resize border along its edge, so a hidden
      // side dock is widened into an invisible strip and its toggle button
      // pulled back out over it -- otherwise the button sits under the border
      // and cannot be clicked.
      expect(getComputedStyle(mask()).width).toBe("8px");
      expect(getComputedStyle(mask()).visibility).toBe("hidden");
      expect(getComputedStyle(inner()).pointerEvents).toBe("none");

      // A dock revealed as a drop target is open, so none of that applies to
      // it: it has to be painted and hit-testable, or the item being dragged
      // falls through to whatever sits underneath the dock.
      dock.handleToggleButtonDragEnter();
      expect(getComputedStyle(mask()).width).toBe("300px");
      expect(getComputedStyle(mask()).visibility).toBe("visible");
      expect(getComputedStyle(inner()).pointerEvents).not.toBe("none");

      // Detaches the drag listeners this dock added to the window.
      dock.draggedOut();
    });
  });

  describe("when a pane in a dock is activated", () => {
    it("opens the dock", async () => {
      const item = {
        element: document.createElement("div"),
        getDefaultLocation() {
          return "left";
        },
      };

      await lumine.workspace.open(item, { activatePane: false });
      expect(lumine.workspace.getLeftDock().isVisible()).toBe(false);

      lumine.workspace.getLeftDock().getPanes()[0].activate();
      expect(lumine.workspace.getLeftDock().isVisible()).toBe(true);
    });
  });

  describe("activating the next pane", () => {
    describe("when the dock has more than one pane", () => {
      it("activates the next pane", () => {
        const dock = lumine.workspace.getLeftDock();
        const pane1 = dock.getPanes()[0];
        const pane2 = pane1.splitRight();
        const pane3 = pane2.splitRight();
        pane2.activate();
        expect(pane1.isActive()).toBe(false);
        expect(pane2.isActive()).toBe(true);
        expect(pane3.isActive()).toBe(false);

        dock.activateNextPane();
        expect(pane1.isActive()).toBe(false);
        expect(pane2.isActive()).toBe(false);
        expect(pane3.isActive()).toBe(true);
      });
    });

    describe("when the dock has only one pane", () => {
      it("leaves the current pane active", () => {
        const dock = lumine.workspace.getLeftDock();

        expect(dock.getPanes().length).toBe(1);
        const pane = dock.getPanes()[0];
        expect(pane.isActive()).toBe(true);
        dock.activateNextPane();
        expect(pane.isActive()).toBe(true);
      });
    });
  });

  describe("activating the previous pane", () => {
    describe("when the dock has more than one pane", () => {
      it("activates the previous pane", () => {
        const dock = lumine.workspace.getLeftDock();
        const pane1 = dock.getPanes()[0];
        const pane2 = pane1.splitRight();
        const pane3 = pane2.splitRight();
        pane2.activate();
        expect(pane1.isActive()).toBe(false);
        expect(pane2.isActive()).toBe(true);
        expect(pane3.isActive()).toBe(false);

        dock.activatePreviousPane();
        expect(pane1.isActive()).toBe(true);
        expect(pane2.isActive()).toBe(false);
        expect(pane3.isActive()).toBe(false);
      });
    });

    describe("when the dock has only one pane", () => {
      it("leaves the current pane active", () => {
        const dock = lumine.workspace.getLeftDock();

        expect(dock.getPanes().length).toBe(1);
        const pane = dock.getPanes()[0];
        expect(pane.isActive()).toBe(true);
        dock.activatePreviousPane();
        expect(pane.isActive()).toBe(true);
      });
    });
  });

  describe("when the dock resize handle is double-clicked", () => {
    describe("when the dock is open", () => {
      it("resizes a vertically-oriented dock to the current item's preferred width", async () => {
        jasmine.attachToDOM(lumine.workspace.getElement());

        const item = {
          element: document.createElement("div"),
          getDefaultLocation() {
            return "left";
          },
          getPreferredWidth() {
            return 142;
          },
          getPreferredHeight() {
            return 122;
          },
        };

        await lumine.workspace.open(item);
        const dock = lumine.workspace.getLeftDock();
        const dockElement = dock.getElement();

        dock.setState({ size: 300 });
        await getNextUpdatePromise();
        expect(dockElement.offsetWidth).toBe(300);
        dockElement
          .querySelector(".lumine-dock-resize-handle")
          .dispatchEvent(new MouseEvent("mousedown", { detail: 2 }));
        await getNextUpdatePromise();

        expect(dockElement.offsetWidth).toBe(item.getPreferredWidth());
      });

      it("resizes a horizontally-oriented dock to the current item's preferred width", async () => {
        jasmine.attachToDOM(lumine.workspace.getElement());

        const item = {
          element: document.createElement("div"),
          getDefaultLocation() {
            return "bottom";
          },
          getPreferredWidth() {
            return 122;
          },
          getPreferredHeight() {
            return 142;
          },
        };

        await lumine.workspace.open(item);
        const dock = lumine.workspace.getBottomDock();
        const dockElement = dock.getElement();

        dock.setState({ size: 300 });
        await getNextUpdatePromise();
        expect(dockElement.offsetHeight).toBe(300);
        dockElement
          .querySelector(".lumine-dock-resize-handle")
          .dispatchEvent(new MouseEvent("mousedown", { detail: 2 }));
        await getNextUpdatePromise();

        expect(dockElement.offsetHeight).toBe(item.getPreferredHeight());
      });
    });

    describe("when the dock is closed", () => {
      it("does nothing", async () => {
        jasmine.attachToDOM(lumine.workspace.getElement());

        const item = {
          element: document.createElement("div"),
          getDefaultLocation() {
            return "bottom";
          },
          getPreferredWidth() {
            return 122;
          },
          getPreferredHeight() {
            return 142;
          },
        };

        await lumine.workspace.open(item, { activatePane: false });

        const dockElement = lumine.workspace.getBottomDock().getElement();
        dockElement
          .querySelector(".lumine-dock-resize-handle")
          .dispatchEvent(new MouseEvent("mousedown", { detail: 2 }));
        expect(dockElement.offsetHeight).toBe(0);
        expect(dockElement.querySelector(".lumine-dock-inner").offsetHeight).toBe(0);
        // The content should be masked away.
        expect(dockElement.querySelector(".lumine-dock-mask").offsetHeight).toBe(0);
      });
    });
  });

  describe("when you add an item to an empty dock", () => {
    describe("when the item has a preferred size", () => {
      it("is takes the preferred size of the item", async () => {
        jasmine.attachToDOM(lumine.workspace.getElement());

        const createItem = (preferredWidth) => ({
          element: document.createElement("div"),
          getDefaultLocation() {
            return "left";
          },
          getPreferredWidth() {
            return preferredWidth;
          },
        });

        const dock = lumine.workspace.getLeftDock();
        const dockElement = dock.getElement();
        expect(dock.getPaneItems()).toHaveLength(0);

        const item1 = createItem(111);
        await lumine.workspace.open(item1);

        // It should update the width every time we go from 0 -> 1 items, not just the first.
        expect(dock.isVisible()).toBe(true);
        expect(dockElement.offsetWidth).toBe(111);
        dock.destroyActivePane();
        expect(dock.getPaneItems()).toHaveLength(0);
        expect(dock.isVisible()).toBe(false);
        const item2 = createItem(222);
        await lumine.workspace.open(item2);
        expect(dock.isVisible()).toBe(true);
        expect(dockElement.offsetWidth).toBe(222);

        // Adding a second shouldn't change the size.
        const item3 = createItem(333);
        await lumine.workspace.open(item3);
        expect(dockElement.offsetWidth).toBe(222);
      });
    });

    describe("when the item has no preferred size", () => {
      it("is still has an explicit size", async () => {
        jasmine.attachToDOM(lumine.workspace.getElement());

        const item = {
          element: document.createElement("div"),
          getDefaultLocation() {
            return "left";
          },
        };
        const dock = lumine.workspace.getLeftDock();
        expect(dock.getPaneItems()).toHaveLength(0);

        expect(dock.state.size).toBe(null);
        await lumine.workspace.open(item);
        expect(dock.state.size).not.toBe(null);
      });
    });
  });

  describe("a deserialized dock", () => {
    it("restores the serialized size", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());

      const item = {
        element: document.createElement("div"),
        getDefaultLocation() {
          return "left";
        },
        getPreferredWidth() {
          return 122;
        },
        serialize: () => ({ deserializer: "DockTestItem" }),
      };
      lumine.deserializers.add({
        name: "DockTestItem",
        deserialize: () => item,
      });
      const dock = lumine.workspace.getLeftDock();
      const dockElement = dock.getElement();

      await lumine.workspace.open(item);
      dock.setState({ size: 150 });
      expect(dockElement.offsetWidth).toBe(150);
      const serialized = dock.serialize();
      dock.setState({ size: 122 });
      expect(dockElement.offsetWidth).toBe(122);
      dock.destroyActivePane();
      dock.deserialize(serialized, lumine.deserializers);
      expect(dockElement.offsetWidth).toBe(150);
    });

    it("isn't visible if it has no items", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());

      const item = {
        element: document.createElement("div"),
        getDefaultLocation() {
          return "left";
        },
        getPreferredWidth() {
          return 122;
        },
      };
      const dock = lumine.workspace.getLeftDock();

      await lumine.workspace.open(item);
      expect(dock.isVisible()).toBe(true);
      const serialized = dock.serialize();
      dock.deserialize(serialized, lumine.deserializers);
      expect(dock.getPaneItems()).toHaveLength(0);
      expect(dock.isVisible()).toBe(false);
    });

    it("removes splits whose items do not deserialize", () => {
      const restoredItem = {
        element: document.createElement("div"),
        serialize: () => ({ deserializer: "DockTestItem" }),
      };
      const transientItem = { element: document.createElement("div") };
      lumine.deserializers.add({
        name: "DockTestItem",
        deserialize: () => restoredItem,
      });

      const dock = lumine.workspace.getLeftDock();
      const restoredPane = dock.getActivePane();
      restoredPane.addItem(restoredItem);
      restoredPane.splitRight({ items: [transientItem] });
      const serialized = dock.serialize();

      lumine.workspace.getCenter().getActivePane().activate();
      dock.deserialize(serialized, lumine.deserializers);

      expect(dock.getPanes()).toHaveLength(1);
      expect(dock.getPaneItems()).toEqual([restoredItem]);
      expect(lumine.workspace.getActivePaneContainer()).toBe(lumine.workspace.getCenter());
    });
  });

  describe("drag handling", () => {
    it("expands docks to match the preferred size of the dragged item", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());

      const element = document.createElement("div");
      element.setAttribute("is", "tabs-tab");
      element.item = {
        element,
        getDefaultLocation() {
          return "left";
        },
        getPreferredWidth() {
          return 144;
        },
      };

      const dragEvent = new DragEvent("dragstart");
      Object.defineProperty(dragEvent, "target", { value: element });

      lumine.workspace.getElement().handleDragStart(dragEvent);
      await getNextUpdatePromise();
      expect(lumine.workspace.getLeftDock().refs.wrapperElement.offsetWidth).toBe(144);
    });

    it("does nothing when text nodes are dragged", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());

      const textNode = document.createTextNode("hello");

      const dragEvent = new DragEvent("dragstart");
      Object.defineProperty(dragEvent, "target", { value: textNode });

      expect(() => lumine.workspace.getElement().handleDragStart(dragEvent)).not.toThrow();
    });

    it("opens an empty dock as a drop target without making it visible", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getRightDock();

      const element = document.createElement("div");
      element.setAttribute("is", "tabs-tab");
      element.item = {
        element,
        getDefaultLocation() {
          return "right";
        },
      };

      const dragEvent = new DragEvent("dragstart");
      Object.defineProperty(dragEvent, "target", { value: element });

      lumine.workspace.getElement().handleDragStart(dragEvent);
      await getNextUpdatePromise();

      // The toggle button is offered even though the dock is empty and hidden.
      expect(dock.getPaneItems()).toHaveLength(0);
      expect(dock.refs.toggleButton.element).toHaveClass("lumine-dock-toggle-button-visible");
      expect(dock.refs.innerElement).not.toHaveClass("lumine-dock-open");

      dock.handleToggleButtonDragEnter();
      await getNextUpdatePromise();

      // Revealed as a drop target, the dock is open like any other: it takes up layout
      // space and can be hit tested, so the drop lands in it instead of falling through
      // to whatever is underneath. Assert the declared size rather than the measured
      // one — the mask animates open, so measuring here races the transition.
      const maskOf = () => dock.refs.innerElement.querySelector(".lumine-dock-mask");
      expect(dock.refs.innerElement).toHaveClass("lumine-dock-open");
      expect(getComputedStyle(dock.refs.innerElement).position).toBe("static");
      expect(maskOf().style.width).toBe("300px");
      // ...but it is still only a peek: nothing has actually been opened yet.
      expect(dock.isVisible()).toBe(false);

      dock.draggedOut();
      await getNextUpdatePromise();
      expect(dock.refs.innerElement).not.toHaveClass("lumine-dock-open");
      expect(getComputedStyle(dock.refs.innerElement).position).toBe("absolute");
      expect(maskOf().style.width).toBe("0px");
    });

    it("gives an empty dock revealed as a drop target real layout space", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getRightDock();
      expect(dock.getPaneItems()).toHaveLength(0);
      expect(dock.getElement().offsetWidth).toBe(0);

      dock.handleToggleButtonDragEnter();
      await getNextUpdatePromise();

      // The whole point: the dock claims width from the workspace, so the pane inside
      // it is hit testable and the item can be dropped there.
      expect(dock.getElement().offsetWidth).toBe(300);
      expect(dock.getElement().parentElement.offsetWidth).toBe(300);

      dock.draggedOut();
      await getNextUpdatePromise();
      expect(dock.getElement().offsetWidth).toBe(0);
    });

    it("shows and hides a dock without animating it", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getRightDock();
      const mask = () => dock.refs.innerElement.querySelector(".lumine-dock-mask");
      const wrapper = () => dock.refs.wrapperElement;

      // Neither the space the dock occupies nor its contents may transition. The dock
      // takes up layout space, so animating the size reflows the workspace on every
      // frame, and callers that open a dock and measure it would read a size
      // mid-animation.
      expect(getComputedStyle(mask()).transitionDuration).toBe("0s");
      expect(getComputedStyle(wrapper()).transitionDuration).toBe("0s");
      expect(getComputedStyle(wrapper()).transform).toBe("none");

      dock.show();
      await getNextUpdatePromise();
      expect(getComputedStyle(mask()).transitionDuration).toBe("0s");
      expect(getComputedStyle(wrapper()).transitionDuration).toBe("0s");
      expect(getComputedStyle(wrapper()).transform).toBe("none");
    });

    it("offers the toggle button for an empty, hidden dock on hover", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getRightDock();

      expect(dock.getPaneItems()).toHaveLength(0);
      expect(dock.isVisible()).toBe(false);
      expect(dock.refs.toggleButton.element).not.toHaveClass("lumine-dock-toggle-button-visible");

      dock.setHovered(true);
      await getNextUpdatePromise();
      expect(dock.refs.toggleButton.element).toHaveClass("lumine-dock-toggle-button-visible");
    });
  });
});
