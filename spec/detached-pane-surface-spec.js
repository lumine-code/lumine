describe("DetachedPaneSurface", () => {
  let item;

  beforeEach(() => {
    lumine.initializeDetachedPaneSurfaces({ force: true });
    jasmine.attachToDOM(lumine.workspace.getElement());
    item = {
      element: document.createElement("div"),
      transitions: [],
      getTitle: () => "Surface item",
      beginWindowSurfaceTransition(context) {
        this.transitions.push([
          "begin",
          context.reason,
          this.element.ownerDocument,
          this.element.isConnected,
        ]);
        return {
          commit: () =>
            this.transitions.push([
              "commit",
              context.reason,
              this.element.ownerDocument,
              this.element.isConnected,
            ]),
          rollback: ({ error }) =>
            this.transitions.push([
              "rollback",
              context.reason,
              this.element.ownerDocument,
              this.element.isConnected,
              error.message,
            ]),
        };
      },
    };
    const pane = lumine.workspace.getCenter().getActiveTiledPane();
    pane.addItem(item);
    pane.activateItem(item);
  });

  afterEach(async () => {
    const pane = lumine.workspace.paneForItem(item);
    if (pane?.isDetached?.()) {
      item.beginWindowSurfaceTransition = null;
      await lumine.workspace.attachDetachedPane(pane);
    }
    pane?.removeItem?.(item, true);
    lumine.initializeDetachedPaneSurfaces();
  });

  it("awaits realm rebuild after adoption and before completing detach and attach", async () => {
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    expect(surface.document).not.toBe(document);
    expect(item.transitions.slice(0, 2)).toEqual([
      ["begin", "detach", document, true],
      ["commit", "detach", surface.document, true],
    ]);

    await lumine.workspace.attachDetachedPane(detachedPane);
    expect(item.transitions.slice(2)).toEqual([
      ["begin", "attach", surface.document, true],
      ["commit", "attach", document, true],
    ]);
  });

  it("lays out the pane and active item in the visible child window", async () => {
    item.element.classList.add("pane-item");
    item.element.textContent = "Detached surface content";

    const detachedPane = await lumine.workspace.detachPaneItem(item);
    const surface = lumine.workspace.getWindowSurface(item);
    const paneElement = detachedPane.getElement();
    const itemView = lumine.views.getView(item);
    await new Promise((resolve) => surface.window.requestAnimationFrame(resolve));

    expect((await surface.windowService.getState()).visible).toBe(true);
    expect(surface.document.visibilityState).toBe("visible");
    expect(surface.paneHost.contains(paneElement)).toBe(true);
    const paneContainer = surface.paneHost.querySelector(":scope > lumine-pane-container");
    const itemViews = paneElement.querySelector(":scope > .item-views");
    expect(paneContainer).not.toBeNull();
    expect(itemViews).not.toBeNull();
    if (!paneContainer || !itemViews) return;
    expect(paneContainer.contains(paneElement)).toBe(true);
    expect(itemViews.contains(itemView)).toBe(true);

    const hostBounds = surface.paneHost.getBoundingClientRect();
    const containerStyle = surface.window.getComputedStyle(paneContainer);
    const paneStyle = surface.window.getComputedStyle(paneElement);
    const itemViewsStyle = surface.window.getComputedStyle(itemViews);
    const itemStyle = surface.window.getComputedStyle(itemView);
    const paneBounds = paneElement.getBoundingClientRect();
    const itemBounds = itemView.getBoundingClientRect();
    expect(containerStyle.display).toBe("flex");
    expect(paneStyle.display).toBe("flex");
    expect(itemViewsStyle.display).toBe("flex");
    expect(itemStyle.display).not.toBe("none");
    expect(itemStyle.visibility).not.toBe("hidden");
    // A theme may legally add a border or padding, so do not require pixel
    // equality. Requiring almost the whole host still distinguishes the real
    // pane layout from the item's small natural text box that masked the bug.
    expect(paneBounds.width).toBeGreaterThan(hostBounds.width * 0.9);
    expect(paneBounds.height).toBeGreaterThan(hostBounds.height * 0.9);
    expect(itemBounds.width).toBeGreaterThan(paneBounds.width * 0.9);
    expect(itemBounds.height).toBeGreaterThan(paneBounds.height * 0.9);

    const hit = surface.document.elementFromPoint(
      itemBounds.left + itemBounds.width / 2,
      itemBounds.top + itemBounds.height / 2,
    );
    expect(hit === itemView || itemView.contains(hit)).toBe(true);
  });

  it("physically restores the old DOM before invoking rollback", async () => {
    item.beginWindowSurfaceTransition = function (context) {
      this.transitions.push(["begin", context.reason, this.element.ownerDocument]);
      return {
        commit: () => {
          throw new Error("realm rebuild failed");
        },
        rollback: ({ error }) =>
          this.transitions.push([
            "rollback",
            this.element.ownerDocument,
            this.element.isConnected,
            error.message,
          ]),
      };
    };

    await expectAsync(lumine.workspace.detachPaneItem(item, { show: false })).toBeRejectedWithError(
      /realm rebuild failed/,
    );
    expect(lumine.workspace.paneForItem(item).isDetached()).toBe(false);
    expect(item.transitions.at(-1)).toEqual(["rollback", document, true, "realm rebuild failed"]);
  });

  it("re-detaches physically before rolling back a failed attach rebuild", async () => {
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    item.transitions = [];
    item.beginWindowSurfaceTransition = function (context) {
      return {
        commit: () => {
          if (context.reason === "attach") throw new Error("primary rebuild failed");
        },
        rollback: ({ error }) =>
          this.transitions.push([
            "rollback",
            this.element.ownerDocument,
            this.element.isConnected,
            error.message,
          ]),
      };
    };

    await expectAsync(lumine.workspace.attachDetachedPane(detachedPane)).toBeRejectedWithError(
      /primary rebuild failed/,
    );
    const restoredPane = lumine.workspace.paneForItem(item);
    expect(restoredPane.isDetached()).toBe(true);
    expect(lumine.workspace.getWindowSurface(item)).toBe(surface);
    expect(item.transitions).toEqual([
      ["rollback", surface.document, true, "primary rebuild failed"],
    ]);
  });

  it("recreates TextEditor observers in the element's current Window realm", async () => {
    lumine.workspace.paneForItem(item).removeItem(item, true);
    const editor = await lumine.workspace.open(null);
    const element = editor.getElement();
    const detachedPane = await lumine.workspace.detachPaneItem(editor, { show: false });
    const surface = lumine.workspace.getWindowSurface(editor);
    expect(element.ownerDocument).toBe(surface.document);
    expect(
      element.component.intersectionObserver instanceof surface.window.IntersectionObserver,
    ).toBe(true);
    expect(element.component.resizeObserver instanceof surface.window.ResizeObserver).toBe(true);
    await lumine.workspace.attachDetachedPane(detachedPane);
    expect(element.ownerDocument).toBe(document);
    expect(element.component.intersectionObserver instanceof window.IntersectionObserver).toBe(
      true,
    );
    expect(element.component.resizeObserver instanceof window.ResizeObserver).toBe(true);
    lumine.workspace.paneForItem(editor).destroyItem(editor, true);
  });
});
