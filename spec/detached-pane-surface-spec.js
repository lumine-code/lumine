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
