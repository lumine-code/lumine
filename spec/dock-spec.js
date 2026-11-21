const { copyableElement } = require("./helpers/pane-item-fixtures");
const { waitForFrames } = require("./helpers/async-spec-helpers");
const etch = require("@lumine-code/etch");

const getNextUpdatePromise = () => etch.getScheduler().nextUpdatePromise;

describe("Dock", () => {
  describe("an empty dock's context menu", () => {
    it("offers Hide Dock in every dock and hides the selected dock", async () => {
      await lumine.reset();
      jasmine.attachToDOM(lumine.workspace.getElement());

      const docks = [
        lumine.workspace.getLeftDock(),
        lumine.workspace.getRightDock(),
        lumine.workspace.getBottomDock(),
      ];

      for (const dock of docks) {
        dock.show();
        const pane = dock.getActivePane();
        const itemViews = pane.getElement().querySelector(":scope > .item-views");
        const items = lumine.contextMenu
          .templateForElement(itemViews)
          .map(({ label, command }) => ({ label, command }));

        expect(items).toEqual([{ label: "Hide Dock", command: "dock:hide" }]);
        expect(dock.isVisible()).toBe(true);
        lumine.commands.dispatch(itemViews, "dock:hide");
        expect(dock.isVisible()).toBe(false);
      }
    });
  });

  describe("an empty split pane's context menu", () => {
    it("offers Hide Dock before the separated Close Pane action", async () => {
      await lumine.reset();
      jasmine.attachToDOM(lumine.workspace.getElement());

      const dock = lumine.workspace.getLeftDock();
      const occupiedPane = dock.getActivePane();
      occupiedPane.addItem(copyableElement("div", [dock.getLocation()]));
      const emptyPane = occupiedPane.splitRight();
      const itemViews = emptyPane.getElement().querySelector(":scope > .item-views");
      const items = lumine.contextMenu
        .templateForElement(itemViews)
        .map(({ label, command, type }) => (type === "separator" ? { type } : { label, command }));

      expect(items).toEqual([
        { label: "Hide Dock", command: "dock:hide" },
        { type: "separator" },
        { label: "Close Pane", command: "pane:close" },
      ]);
      await lumine.commands.dispatch(itemViews, "pane:close");
      expect(emptyPane.isDestroyed()).toBe(true);
      expect(dock.getPanes()).toEqual([occupiedPane]);
      expect(dock.isVisible()).toBe(true);
    });
  });

  describe("when a pane becomes empty", () => {
    it("removes the pane even when core.destroyEmptyPanes is false", async () => {
      lumine.config.set("core.destroyEmptyPanes", false);
      const dock = lumine.workspace.getLeftDock();
      const occupiedPane = dock.getActivePane();
      occupiedPane.addItem(copyableElement("div", [dock.getLocation()]));
      const emptiedPane = occupiedPane.splitRight({
        items: [copyableElement("div", [dock.getLocation()])],
      });

      await emptiedPane.destroyActiveItem();

      expect(emptiedPane.isDestroyed()).toBe(true);
      expect(dock.getPanes()).toEqual([occupiedPane]);
    });

    it("returns to the last used pane when closing the last item in a dock split", async () => {
      const docks = [
        lumine.workspace.getLeftDock(),
        lumine.workspace.getRightDock(),
        lumine.workspace.getBottomDock(),
      ];

      for (const dock of docks) {
        const pane1 = dock.getActivePane();
        pane1.addItem(copyableElement("div", [dock.getLocation()]));
        const pane2 = pane1.splitRight({ items: [copyableElement("div", [dock.getLocation()])] });
        const pane3 = pane2.splitRight({ items: [copyableElement("div", [dock.getLocation()])] });
        pane2.activate();
        pane3.activate();

        await pane3.destroyActiveItem();

        expect(pane3.isDestroyed()).toBe(true);
        expect(dock.getActivePane()).toBe(pane2);
        expect(lumine.workspace.getActivePane()).toBe(pane2);
        expect(dock.isVisible()).toBe(true);
      }
    });
  });

  describe("hover-area hit testing", () => {
    it("reports no hover area before the dock has rendered", () => {
      const Dock = require("../src/dock");
      const dock = new Dock({
        ...lumine.workspace.getLeftDock(),
        workspace: lumine.workspace,
        didChangeActivePane: () => {},
        didChangeActivePaneItem: () => {},
        didDestroyPaneItem: () => {},
      });
      try {
        expect(dock.refs && dock.refs.innerElement).toBeFalsy();
        expect(dock.pointWithinHoverArea({ x: 0, y: 0 })).toBe(false);
        expect(dock.pointWithinHoverArea({ x: 0, y: 0 }, true)).toBe(false);
      } finally {
        dock.destroy();
      }
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

  describe("dock toggle geometry", () => {
    let workspace;

    beforeEach(() => {
      workspace = lumine.workspace;
      const themeStyle = document.createElement("style");
      themeStyle.textContent = `
        .lumine-dock-toggle-button.left { margin-left: -2px; }
        .lumine-dock-toggle-button.right { margin-right: -2px; }
        .lumine-dock-inner:not(.lumine-dock-open) .lumine-dock-toggle-button.bottom {
          margin-bottom: -1px;
        }
        lumine-workspace[ui-dock-buttons="hidden"] .lumine-dock-toggle-button {
          display: none;
        }
        .lumine-dock-toggle-button-inner { transition: none !important; }
      `;
      jasmine.attachToDOM(themeStyle);
      const root = workspace.getElement();
      root.style.cssText = "position: fixed; left: 0; top: 0; width: 800px; height: 500px;";
      root.style.setProperty("--pane-item-border-color", "rgb(147, 72, 13)");
      root.style.setProperty("--tool-panel-border-color", "rgb(20, 40, 60)");
      jasmine.attachToDOM(root);
    });

    for (const location of ["left", "right", "bottom"]) {
      it(`covers the ${location} divider with the toggle without shifting its exterior cap`, async () => {
        const dock = workspace
          .getPaneContainers()
          .find((container) => container.getLocation() === location);
        dock.setState({ size: 160 });
        dock.show();
        dock.setHovered(true);
        await getNextUpdatePromise();

        const element = dock.getElement();
        const grip = element.querySelector(".lumine-dock-resize-handle");
        const toggle = element.querySelector(".lumine-dock-toggle-button");
        const button = toggle.querySelector(".lumine-dock-toggle-button-inner");
        const divider = grip.getBoundingClientRect();
        const bounds = toggle.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        const icon = button.querySelector(".icon").getBoundingClientRect();
        const [dockEdge, workspaceEdge] = {
          left: ["left", "right"],
          right: ["right", "left"],
          bottom: ["bottom", "top"],
        }[location];
        const x =
          location === "bottom"
            ? (bounds.left + bounds.right) / 2
            : (bounds[workspaceEdge] + divider[workspaceEdge]) / 2;
        const y =
          location === "bottom" ? (bounds.top + divider.top) / 2 : (bounds.top + bounds.bottom) / 2;
        const centerX = (buttonBounds.left + buttonBounds.right) / 2;
        const centerY = (buttonBounds.top + buttonBounds.bottom) / 2;
        const capBase = location === "bottom" ? centerY : centerX;
        const buttonStyle = getComputedStyle(button);
        const fillRadius = buttonBounds.width / 2 - parseFloat(buttonStyle.borderTopWidth);
        const centroidOffset = (4 * fillRadius) / (3 * Math.PI);
        const [iconX, iconY] = {
          left: [centerX + centroidOffset, centerY],
          right: [centerX - centroidOffset, centerY],
          bottom: [centerX, centerY - centroidOffset],
        }[location];
        const borderSide = { left: "Right", right: "Left", bottom: "Top" }[location];

        expect(bounds[dockEdge]).toBeCloseTo(divider[dockEdge], 2);
        expect(capBase).toBeCloseTo(divider[workspaceEdge], 2);
        expect(buttonStyle.borderTopColor).toBe(getComputedStyle(grip)[`border${borderSide}Color`]);
        expect((icon.left + icon.right) / 2).toBeCloseTo(iconX, 1);
        expect((icon.top + icon.bottom) / 2).toBeCloseTo(iconY, 1);

        const hitAtDivider =
          location === "bottom"
            ? document.elementFromPoint(x, Math.ceil(divider.top))
            : document.elementFromPoint(Math.ceil(divider.left), y);
        expect(button.contains(hitAtDivider)).toBe(true);

        // Blink can round fractional hit-test coordinates to the next pixel.
        const hitInDock = {
          left: () => document.elementFromPoint(Math.ceil(divider.left) - 1, y),
          right: () => document.elementFromPoint(Math.ceil(divider.right), y),
          bottom: () => document.elementFromPoint(x, Math.ceil(divider.bottom)),
        }[location];
        expect(toggle.contains(hitInDock())).toBe(false);
        expect(hitInDock()).not.toBe(grip);

        const outsideToggle =
          location === "bottom" ? [bounds.left, bounds.right] : [bounds.top, bounds.bottom];
        for (const coordinate of [
          Math.floor(outsideToggle[0]) - 7,
          Math.ceil(outsideToggle[1]) + 7,
        ]) {
          const hit =
            location === "bottom"
              ? document.elementFromPoint(coordinate, Math.ceil(divider.top))
              : document.elementFromPoint(Math.ceil(divider.left), coordinate);
          expect(hit).toBe(grip);
        }

        const workspaceElement = workspace.getElement();
        workspaceElement.setAttribute("ui-dock-buttons", "hidden");
        expect(hitInDock()).toBe(grip);
        workspaceElement.removeAttribute("ui-dock-buttons");

        dock.setHovered(false);
        await getNextUpdatePromise();

        const hiddenEdge = button.getBoundingClientRect()[workspaceEdge];
        const maskEdge = toggle.getBoundingClientRect()[dockEdge];
        const overlap = (hiddenEdge - maskEdge) * (location === "left" ? 1 : -1);
        expect(overlap).toBeLessThanOrEqual(0);
        expect(hitInDock()).toBe(grip);
      });
    }

    it("keeps the closed bottom toggle above the footer boundary", async () => {
      const footerItem = document.createElement("div");
      footerItem.style.height = "32px";
      const footer = workspace.addFooterPanel({ item: footerItem }).getElement();
      const dock = workspace.getBottomDock();
      dock.setHovered(true);
      await getNextUpdatePromise();

      const toggle = dock.getElement().querySelector(".lumine-dock-toggle-button");
      const button = toggle.querySelector(".lumine-dock-toggle-button-inner");
      const bounds = toggle.getBoundingClientRect();
      const icon = button.querySelector(".icon").getBoundingClientRect();
      const footerTop = footer.getBoundingClientRect().top;
      const x = (bounds.left + bounds.right) / 2;
      const fillRadius = bounds.width / 2 - parseFloat(getComputedStyle(button).borderTopWidth);
      const iconY = footerTop - (4 * fillRadius) / (3 * Math.PI) - 1;

      expect(dock.isVisible()).toBe(false);
      expect(bounds.bottom).toBeCloseTo(footerTop, 2);
      expect((icon.top + icon.bottom) / 2).toBeCloseTo(iconY, 1);
      expect(button.contains(document.elementFromPoint(x, Math.ceil(footerTop) - 1))).toBe(true);
      expect(footer.contains(document.elementFromPoint(x, Math.ceil(footerTop)))).toBe(true);
    });
  });

  describe("resize handle hit testing", () => {
    let workspace, controllers;

    beforeEach(() => {
      workspace = lumine.workspace;
      controllers = [];
      // Existing themes absolutely position dock grips and add their own border.
      // Keep those overrides in play because core also runs with older theme pins.
      const themeStyle = document.createElement("style");
      themeStyle.textContent = `
        .lumine-dock-resize-handle { position: absolute; z-index: 11; }
        .lumine-dock-resize-handle.left { inset: 0 0 0 auto; }
        .lumine-dock-resize-handle.right { inset: 0 auto 0 0; }
        .lumine-dock-resize-handle.bottom { inset: 0 0 auto; }
        .lumine-dock-inner.lumine-dock-open.left { border-right: 1px solid; }
        .lumine-dock-inner.lumine-dock-open.right { border-left: 1px solid; }
        .lumine-dock-inner.lumine-dock-open.bottom { border-top: 1px solid; }
        .dock-spec-native-scrollport::-webkit-scrollbar { width: 12px; }
      `;
      jasmine.attachToDOM(themeStyle);
      const root = workspace.getElement();
      root.style.cssText = "position: fixed; left: 0; top: 0; width: 800px; height: 500px;";
      jasmine.attachToDOM(root);
    });

    afterEach(() => {
      for (const controller of controllers) controller.dispose();
    });

    async function showDock(dock) {
      dock.setState({ size: 160 });
      dock.show();
      await getNextUpdatePromise();
    }

    function addScrollbar(container, location, { edge, horizontal = false } = {}) {
      const item = copyableElement("div", [location]);
      item.style.zIndex = "1";
      const context = item.appendChild(document.createElement("div"));
      context.style.cssText = "position: absolute; inset: 0; isolation: isolate;";
      const scrollport = context.appendChild(document.createElement("div"));
      scrollport.style.cssText = "position: absolute; inset: 0; overflow: auto;";
      const content = scrollport.appendChild(document.createElement("div"));
      content.style[horizontal ? "width" : "height"] = "2000px";
      container.getActivePane().activateItem(item);
      const controller = lumine.scrollbars.attach(scrollport, {
        kind: "panel",
        layout: "overlay",
        policy: "always",
        edge,
        horizontal,
        vertical: !horizontal,
      });
      controllers.push(controller);
      return horizontal ? controller.horizontal.element : controller.vertical.element;
    }

    function getDock(location) {
      return workspace
        .getPaneContainers()
        .find((container) => container.getLocation() === location);
    }

    async function waitForScrollbar(track) {
      await waitForFrames(() => Boolean(track.offsetHeight && track.offsetWidth), {
        frames: 30,
        description: "dock scrollbar geometry",
      });
      return track.getBoundingClientRect();
    }

    function waitForHit(target, x, y) {
      return waitForFrames(() => target.contains(document.elementFromPoint(x, y)), {
        frames: 30,
        description: "dock resize handle or scrollbar hit area",
      });
    }

    function pressAt(x, y) {
      const target = document.elementFromPoint(x, y);
      target?.dispatchEvent(
        new MouseEvent("mousedown", {
          clientX: x,
          clientY: y,
          buttons: 1,
          detail: 1,
          bubbles: true,
          cancelable: true,
        }),
      );
      return target;
    }

    for (const location of ["left", "right", "bottom"]) {
      it(`fits ${location} dock content to its one-pixel divider and resizes from both sides`, async () => {
        const dock = getDock(location);
        const item = copyableElement("div", [location]);
        item.style.backgroundColor = "rgb(20, 40, 60)";
        dock.getActivePane().activateItem(item);
        await showDock(dock);
        const element = dock.getElement();
        const mask = element.querySelector(".lumine-dock-mask").getBoundingClientRect();
        const center = workspace.getCenter().getActivePane().getElement().getBoundingClientRect();
        const itemBounds = item.getBoundingClientRect();
        const grip = element.querySelector(".lumine-dock-resize-handle");
        const rect = grip.getBoundingClientRect();
        const style = getComputedStyle(grip);
        const { edges, contentEdge, dividerStart, size, borderWidth, cross, direction } = {
          left: {
            edges: [rect.right, mask.right, center.left],
            contentEdge: itemBounds.right,
            dividerStart: rect.left,
            size: rect.width,
            borderWidth: style.borderRightWidth,
            cross: (rect.top + rect.bottom) / 2,
            direction: 1,
          },
          right: {
            edges: [rect.left, mask.left, center.right],
            contentEdge: itemBounds.left,
            dividerStart: rect.right,
            size: rect.width,
            borderWidth: style.borderLeftWidth,
            cross: (rect.top + rect.bottom) / 2,
            direction: -1,
          },
          bottom: {
            edges: [rect.top, mask.top, center.bottom],
            contentEdge: itemBounds.top,
            dividerStart: rect.bottom,
            size: rect.height,
            borderWidth: style.borderTopWidth,
            cross: (rect.left + rect.right) / 2,
            direction: -1,
          },
        }[location];
        const [dividerEnd, dockPaintEdge, workspaceEdge] = edges;
        expect(dividerEnd).toBe(dockPaintEdge);
        expect(dividerEnd).toBe(workspaceEdge);
        expect(contentEdge).toBe(dividerStart);
        expect(size).toBe(1);
        expect(borderWidth).toBe("1px");
        const pseudoSize = location === "bottom" ? "height" : "width";
        expect(getComputedStyle(grip, "::before")[pseudoSize]).toBe("5px");

        const line = (dividerStart + dividerEnd) / 2;
        for (const offset of [-3.5, -1.5, 1.5, 3.5]) {
          const position = line + direction * offset;
          const target =
            location === "bottom" ? pressAt(cross, position) : pressAt(position, cross);
          const onGrip = Math.abs(offset) < 2.5;
          expect(target === grip).toBe(onGrip);
          if (offset === -3.5) expect(target).toBe(item);
          expect(Boolean(dock.layoutDrag)).toBe(onGrip);
          window.dispatchEvent(new MouseEvent("mouseup"));
        }
      });
    }

    it("leaves the dock corner to the outer chrome when the active item is a panel", async () => {
      const themeStyle = document.createElement("style");
      themeStyle.textContent = "lumine-panel { border-bottom: 1px solid; }";
      jasmine.attachToDOM(themeStyle);

      const dock = workspace.getLeftDock();
      const item = copyableElement("lumine-panel", ["left"]);
      const section = item.appendChild(document.createElement("lumine-panel"));
      dock.getActivePane().activateItem(item);
      await showDock(dock);

      expect(getComputedStyle(item).borderBottomWidth).toBe("0px");
      expect(getComputedStyle(section).borderBottomWidth).toBe("1px");
    });

    it("keeps a single separator above the bottom dock without erasing split pane borders", async () => {
      const themeStyle = document.createElement("style");
      themeStyle.textContent = "lumine-pane, lumine-panel { border-bottom: 1px solid; }";
      jasmine.attachToDOM(themeStyle);

      const upperPane = workspace.getCenter().getActivePane();
      const lowerPane = upperPane.splitDown();
      const lowerRightPane = lowerPane.splitRight();
      const upper = upperPane.getElement();
      const lower = lowerPane.getElement();
      const lowerRight = lowerRightPane.getElement();
      const bottomBorder = (element) => getComputedStyle(element).borderBottomWidth;

      const dock = workspace.getBottomDock();
      expect(bottomBorder(lower)).toBe("1px");
      await showDock(dock);
      expect(bottomBorder(upper)).toBe("1px");
      expect(bottomBorder(lower)).toBe("0px");
      expect(bottomBorder(lowerRight)).toBe("0px");

      const panel = workspace.addBottomPanel({
        item: document.createElement("div"),
        visible: false,
      });
      expect(bottomBorder(lower)).toBe("0px");
      panel.show();
      expect(bottomBorder(panel.getElement())).toBe("0px");
      expect(bottomBorder(lower)).toBe("1px");
      expect(bottomBorder(lowerRight)).toBe("1px");
      panel.hide();
      expect(bottomBorder(lower)).toBe("0px");
      expect(bottomBorder(lowerRight)).toBe("0px");
    });

    for (const location of ["left", "right"]) {
      it(`resizes the ${location} dock at the seam and leaves the rest of each scrollbar usable`, async () => {
        const dock = getDock(location);
        const dockEdge = location === "left" ? "right" : "left";
        const dockTrack = addScrollbar(dock, location, { edge: dockEdge });
        const centerTrack = addScrollbar(workspace.getCenter(), "center", {
          edge: location,
        });
        await showDock(dock);
        const divider = dock.getElement().querySelector(".lumine-dock-resize-handle");
        const dividerBounds = divider.getBoundingClientRect();
        const dividerX = dividerBounds.left + dividerBounds.width / 2;
        for (const [track, edge] of [
          [dockTrack, dockEdge],
          [centerTrack, location],
        ]) {
          const rect = await waitForScrollbar(track);
          const adjacent = edge === "right" ? rect.right - 1 : rect.left + 1;
          const insideTrack = edge === "right" ? rect.right - 4 : rect.left + 4;
          const y = (rect.top + rect.bottom) / 2;
          expect(Math.abs(adjacent - dividerX)).toBeLessThan(2.5);
          expect(Math.abs(insideTrack - dividerX)).toBeGreaterThan(2.5);
          expect(pressAt(adjacent, y)).toBe(divider);
          expect(dock.layoutDrag).not.toBeNull();
          window.dispatchEvent(new MouseEvent("mouseup"));

          await waitForHit(track, insideTrack, y);
          expect(track.contains(pressAt(insideTrack, y))).toBe(true);
          expect(dock.layoutDrag).toBeNull();
          window.dispatchEvent(new MouseEvent("mouseup"));
        }
      });

      it(`keeps the workspace side of the ${location} grip available with a far-edge scrollbar`, async () => {
        const dock = getDock(location);
        const farEdge = location === "left" ? "right" : "left";
        const center = workspace.getCenter();
        const track = addScrollbar(center, "center", { edge: farEdge });
        await showDock(dock);
        const trackBounds = await waitForScrollbar(track);

        const grip = dock.getElement().querySelector(".lumine-dock-resize-handle");
        const gripBounds = grip.getBoundingClientRect();
        const centerOffset = location === "left" ? 1.5 : -1.5;
        const x = gripBounds.left + gripBounds.width / 2 + centerOffset;
        const y = (trackBounds.top + trackBounds.bottom) / 2;
        expect(pressAt(x, y)).toBe(grip);
        expect(dock.layoutDrag).not.toBeNull();
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
    }

    it("keeps the center's horizontal scrollbar clickable outside the bottom dock grip", async () => {
      const track = addScrollbar(workspace.getCenter(), "center", { horizontal: true });
      const dock = workspace.getBottomDock();
      await showDock(dock);
      const rect = await waitForScrollbar(track);
      const divider = dock.getElement().querySelector(".lumine-dock-resize-handle");
      const x = (rect.left + rect.right) / 2;
      expect(pressAt(x, rect.bottom - 1)).toBe(divider);
      expect(dock.layoutDrag).not.toBeNull();
      window.dispatchEvent(new MouseEvent("mouseup"));

      const y = rect.bottom - 4;
      await waitForHit(track, x, y);
      const target = pressAt(x, y);
      expect(track.contains(target)).toBe(true);
      expect(dock.layoutDrag).toBeNull();
      window.dispatchEvent(new MouseEvent("mouseup"));
    });

    for (const location of ["left", "right"]) {
      it(`preserves the native scrollbar outside the ${location} dock grip`, async () => {
        const scrollLocation = location === "left" ? "left" : "center";
        const scrollport = copyableElement("div", [scrollLocation]);
        scrollport.dataset.scrollbar = "none";
        scrollport.classList.add("dock-spec-native-scrollport");
        scrollport.style.cssText = "overflow-y: scroll; scrollbar-gutter: stable;";
        scrollport.appendChild(document.createElement("div")).style.height = "2000px";
        getDock(scrollLocation).getActivePane().activateItem(scrollport);
        const dock = getDock(location);
        await showDock(dock);

        const rect = scrollport.getBoundingClientRect();
        const x = rect.right - 4;
        const y = (rect.top + rect.bottom) / 2;
        expect(scrollport.offsetWidth - scrollport.clientWidth).toBeGreaterThan(4);
        await waitForHit(scrollport, x, y);
        expect(pressAt(x, y)).toBe(scrollport);
        expect(dock.layoutDrag).toBeNull();
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
    }
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

  describe("reserving space for a default item", () => {
    for (const [location, getDock, dimension, preferred] of [
      ["left", "getLeftDock", "offsetWidth", 211],
      ["right", "getRightDock", "offsetWidth", 233],
      ["bottom", "getBottomDock", "offsetHeight", 157],
    ]) {
      it(`reserves the preferred ${location} dock size before adding the item`, () => {
        jasmine.attachToDOM(lumine.workspace.getElement());
        const dock = lumine.workspace[getDock]();
        let preferredSize = preferred;
        const item = {
          element: document.createElement("div"),
          getDefaultLocation: () => location,
          getAllowedLocations: () => [location],
          getPreferredWidth: () => (location === "bottom" ? 999 : preferredSize),
          getPreferredHeight: () => (location === "bottom" ? preferredSize : 999),
        };

        dock.reserveSpaceForItem(item);

        expect(dock.getPaneItems()).toEqual([]);
        expect(dock.isVisible()).toBe(true);
        expect(dock.getElement()[dimension]).toBe(preferred);
        expect(dock.state.restoring).toBeFalsy();

        preferredSize += 100;
        dock.getActivePane().addItem(item);

        expect(dock.state.size).toBe(preferred);
        expect(dock.getElement()[dimension]).toBe(preferred);
      });
    }

    for (const [preferredSize, reservedSize] of [
      [undefined, 300],
      [0, 300],
      [45, 100],
    ]) {
      it(`reserves ${reservedSize}px when the preferred size is ${preferredSize}`, () => {
        jasmine.attachToDOM(lumine.workspace.getElement());
        const dock = lumine.workspace.getLeftDock();

        dock.reserveSpaceForItem({ getPreferredWidth: () => preferredSize });

        expect(dock.state.size).toBe(reservedSize);
        expect(dock.getElement().offsetWidth).toBe(reservedSize);
      });
    }

    it("retains the existing dock size", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getLeftDock();
      dock.setState({ size: 417 });

      dock.reserveSpaceForItem({ getPreferredWidth: () => 233 });

      expect(dock.state.size).toBe(417);
      expect(dock.getElement().offsetWidth).toBe(417);
    });

    it("preserves normal visibility changes while the item has not been added", () => {
      const dock = lumine.workspace.getLeftDock();
      const changed = jasmine.createSpy("dock visibility changed");
      const subscription = dock.onDidChangeVisible(changed);
      try {
        dock.reserveSpaceForItem({});
        dock.hide();
        dock.show();

        expect(changed.calls.allArgs()).toEqual([[true], [false], [true]]);
        expect(dock.isVisible()).toBe(true);
        expect(dock.state.restoring).toBeFalsy();
      } finally {
        subscription.dispose();
      }
    });
  });

  describe("a deserialized dock", () => {
    it("reserves its saved geometry without painting provisional contents", () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getLeftDock();
      const item = copyableElement("div", ["left"]);

      dock.beginInitialRestore({ size: 173, visible: true });
      dock.getActivePane().addItem(item);
      dock.activate();

      expect(lumine.workspace.getElement().style.visibility).toBe("");
      expect(dock.isVisible()).toBe(true);
      expect(dock.getElement().offsetWidth).toBe(173);
      expect(dock.refs.wrapperElement).toHaveClass("lumine-dock-restoring");

      dock.endInitialRestore();

      expect(dock.isVisible()).toBe(true);
      expect(dock.getActivePaneItem()).toBe(item);
      expect(dock.refs.wrapperElement).not.toHaveClass("lumine-dock-restoring");
    });

    it("defers a package's request to show a saved hidden dock", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const dock = lumine.workspace.getLeftDock();
      const item = {
        element: document.createElement("div"),
        getDefaultLocation: () => "left",
      };

      dock.beginInitialRestore({ size: 150, visible: false });
      await lumine.workspace.open(item);

      expect(dock.isVisible()).toBe(false);
      expect(dock.refs.wrapperElement).toHaveClass("lumine-dock-restoring");

      dock.endInitialRestore();

      expect(dock.isVisible()).toBe(true);
      expect(dock.getActivePaneItem()).toBe(item);
      expect(dock.refs.wrapperElement).not.toHaveClass("lumine-dock-restoring");
    });

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
        getAllowedLocations: () => ["left"],
        element: document.createElement("div"),
        serialize: () => ({ deserializer: "DockTestItem" }),
      };
      const transientItem = {
        getAllowedLocations: () => ["left"],
        element: document.createElement("div"),
      };
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

    it("does not offer a dock outside an item's implicit default location", async () => {
      jasmine.attachToDOM(lumine.workspace.getElement());
      const leftDock = lumine.workspace.getLeftDock();
      const rightDock = lumine.workspace.getRightDock();
      const element = document.createElement("div");
      element.setAttribute("is", "tabs-tab");
      element.item = {
        element,
        getDefaultLocation: () => "left",
      };
      const dragEvent = new DragEvent("dragstart");
      Object.defineProperty(dragEvent, "target", { value: element });

      lumine.workspace.getElement().handleDragStart(dragEvent);
      await getNextUpdatePromise();

      expect(leftDock.refs.toggleButton.element).toHaveClass("lumine-dock-toggle-button-visible");
      expect(rightDock.refs.toggleButton.element).not.toHaveClass(
        "lumine-dock-toggle-button-visible",
      );
    });

    it("clears an empty dock's drop target when the drop finishes without dragend", async () => {
      const workspaceElement = lumine.workspace.getElement();
      jasmine.attachToDOM(workspaceElement);
      const sourcePane = lumine.workspace.getLeftDock().getActivePane();
      const targetDock = lumine.workspace.getRightDock();
      const targetPane = targetDock.getActivePane();
      const item = {
        getAllowedLocations: () => ["left", "right"],
        element: document.createElement("div"),
        getDefaultLocation() {
          return "right";
        },
      };
      sourcePane.addItem(item);

      const tab = document.createElement("div");
      tab.setAttribute("is", "tabs-tab");
      tab.item = item;
      const dragEvent = new DragEvent("dragstart");
      Object.defineProperty(dragEvent, "target", { value: tab });

      workspaceElement.handleDragStart(dragEvent);
      targetDock.handleToggleButtonDragEnter();
      expect(targetDock.refs.innerElement).toHaveClass("lumine-dock-open");
      expect(targetDock.isVisible()).toBe(false);

      // Dropping a tab can detach its source element before `dragend` reaches
      // window. The workspace's drop cleanup must therefore close the temporary
      // target on its own.
      workspaceElement.handleDrop(new DragEvent("drop"));
      sourcePane.moveItemToPane(item, targetPane);
      targetPane.activateItem(item);
      targetPane.activate();
      await getNextUpdatePromise();

      expect(targetDock.state.draggingItem).toBeNull();
      expect(targetDock.state.showDropTarget).toBe(false);
      expect(targetDock.isVisible()).toBe(true);

      targetDock.setHovered(true);
      await getNextUpdatePromise();
      targetDock.refs.toggleButton.refs.innerElement.click();
      await getNextUpdatePromise();

      expect(targetDock.isVisible()).toBe(false);
      expect(targetDock.refs.innerElement).not.toHaveClass("lumine-dock-open");

      targetDock.show();
      await getNextUpdatePromise();
      const itemViews = targetPane.getElement().querySelector(":scope > .item-views");
      lumine.commands.dispatch(itemViews, "dock:hide");
      await getNextUpdatePromise();

      expect(targetDock.isVisible()).toBe(false);
      expect(targetDock.refs.innerElement).not.toHaveClass("lumine-dock-open");
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
