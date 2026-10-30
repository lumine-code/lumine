describe("Editor overlay scrollbars", () => {
  let editor, element, component;

  beforeEach(() => {
    jasmine.useRealClock();
    editor = lumine.workspace.buildTextEditor({ autoHeight: false, softWrapped: false });
    editor.setText("long source line ".repeat(20) + "\n" + "row\n".repeat(100));
    element = editor.getElement();
    element.style.cssText = "width:640px;height:240px;--scrollbar-size-editor:12px";
    jasmine.attachToDOM(element);
    element.setUpdatedSynchronously(true);
    component = element.component;
    editor.setSoftWrapped(false);
    component.updateSync();
  });

  afterEach(() => {
    editor.destroy();
    element.remove();
  });

  function pointer(rail, type, x, y) {
    rail.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        clientX: x,
        clientY: y,
      }),
    );
  }

  it("keeps the full viewport while wrapping before a stable overlay inset", () => {
    editor.setSoftWrapped(true);
    component.updateSync();
    const viewportWidth = component.getScrollContainerWidth();
    expect(component.getScrollContainerClientWidth()).toBe(viewportWidth);
    expect(component.getContentViewportWidth()).toBe(viewportWidth - 12);
    expect(editor.getEditorWidthInChars()).toBe(
      Math.floor((viewportWidth - 12) / component.getBaseCharacterWidth()),
    );
    expect(component.getScrollWidth()).toBe(viewportWidth);
    const wrappingWidth = editor.getEditorWidthInChars();
    component.didBlur({ relatedTarget: null });
    component.didFocus();
    component.updateSync();
    expect(editor.getEditorWidthInChars()).toBe(wrappingWidth);
    editor.setText("short");
    component.updateSync();
    expect(component.canScrollVertically()).toBe(false);
    expect(component.getContentViewportWidth()).toBe(component.getScrollContainerWidth() - 12);
  });

  for (const orientation of ["vertical", "horizontal"]) {
    it(`jumps a ${orientation} track click directly to the centered destination and cancels a wheel glide`, () => {
      const horizontal = orientation === "horizontal";
      const rail = component.refs[horizontal ? "horizontalScrollbar" : "verticalScrollbar"].element;
      const bounds = rail.getBoundingClientRect();
      const thumb = rail.querySelector(".scrollbar-thumb").getBoundingClientRect();
      const trackSize = horizontal ? bounds.width : bounds.height;
      const thumbSize = horizontal ? thumb.width : thumb.height;
      const maximum = horizontal ? component.getMaxScrollLeft() : component.getMaxScrollTop();
      expect(maximum).toBeGreaterThan(0);
      const offset = trackSize * 0.7;
      const expected =
        Math.max(0, Math.min(1, (offset - thumbSize / 2) / (trackSize - thumbSize))) * maximum;
      component.scrollAnimator.scrollBy({ x: 30, y: 30, duration: 120 });
      expect(component.scrollAnimator.isAnimating()).toBe(true);
      const x = horizontal ? bounds.left + offset : bounds.left + bounds.width / 2;
      const y = horizontal ? bounds.top + bounds.height / 2 : bounds.top + offset;
      pointer(rail, "pointerdown", x, y);
      expect(component.scrollAnimator.isAnimating()).toBe(false);
      expect(horizontal ? component.getScrollLeft() : component.getScrollTop()).toBeCloseTo(
        expected,
        0,
      );
      expect(horizontal ? rail.scrollLeft : rail.scrollTop).toBe(0);
      pointer(rail, "pointerup", x, y);
    });
  }

  it("updates thumb transforms without reading rail layout or native offsets on scroll-only frames", () => {
    if (component.updateScheduled) component.updateSync();
    const vertical = component.refs.verticalScrollbar;
    const horizontal = component.refs.horizontalScrollbar;
    const verticalRect = spyOn(vertical.element, "getBoundingClientRect").and.callThrough();
    const horizontalRect = spyOn(horizontal.element, "getBoundingClientRect").and.callThrough();
    const verticalOffset = spyOnProperty(vertical.element, "scrollTop", "set").and.callThrough();
    const horizontalOffset = spyOnProperty(
      horizontal.element,
      "scrollLeft",
      "set",
    ).and.callThrough();
    component.scrollAnimator.scrollBy({ x: 10, y: 10, duration: 120 });
    component.scrollAnimator.advance(1000 / 60);
    expect(vertical.props.scrollTop).toBe(component.getRequestedScrollTop());
    expect(horizontal.props.scrollLeft).toBe(component.getRequestedScrollLeft());
    expect(verticalRect).not.toHaveBeenCalled();
    expect(horizontalRect).not.toHaveBeenCalled();
    expect(verticalOffset).not.toHaveBeenCalled();
    expect(horizontalOffset).not.toHaveBeenCalled();
  });

  it("changes theme thickness in place and keeps the chosen logical position", () => {
    component.setScrollTop(100.25);
    component.updateSync();
    const vertical = component.refs.verticalScrollbar;
    element.style.setProperty("--scrollbar-size-editor", "18px");
    component.didUpdateScrollbarStyles();
    component.updateSync();
    expect(component.refs.verticalScrollbar).toBe(vertical);
    expect(component.getVerticalScrollbarWidth()).toBe(18);
    expect(component.getContentViewportWidth()).toBe(component.getScrollContainerWidth() - 18);
    expect(component.getScrollTop()).toBe(100.25);
    expect(vertical.props.scrollTop).toBe(100.25);
    expect(vertical.element.getBoundingClientRect().width).toBe(18);
  });

  it("publishes changed row geometry even when total height stays the same, without notifying on thumb movement", () => {
    const snapshots = [];
    const subscription = element.onDidChangeScrollGeometry((geometry) => snapshots.push(geometry));
    try {
      component.setScrollTop(10);
      component.updateSync();
      expect(snapshots).toEqual([]);
      const items = [20, 40].map((height, index) => {
        const item = document.createElement("div");
        item.style.height = height + "px";
        const marker = editor.markBufferPosition([index + 2, 0]);
        const decoration = editor.decorateMarker(marker, {
          type: "block",
          item,
          position: "after",
        });
        return { item, decoration };
      });
      component.updateSync();
      const height = component.getScrollHeight();
      const version = snapshots.at(-1).rowGeometryVersion;
      snapshots.length = 0;
      items[0].item.style.height = "30px";
      items[1].item.style.height = "30px";
      element.setUpdatedSynchronously(false);
      for (const { decoration } of items) component.invalidateBlockDecorationDimensions(decoration);
      component.updateSync();
      expect(component.getScrollHeight()).toBe(height);
      expect(snapshots.length).toBe(1);
      expect(snapshots[0].rowGeometryVersion).toBeGreaterThan(version);
    } finally {
      subscription.dispose();
    }
  });
});
