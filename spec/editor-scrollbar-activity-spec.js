describe("Editor scrollbar activity", () => {
  let editor, element, component, itemViews;

  beforeEach(() => {
    spyOn(window.performance, "now").and.callFake(() => Date.now());
    editor = lumine.workspace.buildTextEditor({ autoHeight: false, softWrapped: false });
    editor.setText(Array(100).fill("long source line ".repeat(20)).join("\n"));
    editor.setCursorBufferPosition([0, 0]);
    element = editor.getElement();
    element.dataset.scrollbarKind = "panel";
    element.style.cssText = "width:360px;height:160px;--scrollbar-size-editor:10px";
    component = element.getComponent();
    component.setScrollTop(0);
    component.setScrollLeft(0);
    itemViews = document.createElement("div");
    itemViews.className = "item-views";
    itemViews.style.cssText = "position:fixed;left:20px;top:20px";
    itemViews.appendChild(element);
    jasmine.attachToDOM(itemViews);
    element.setUpdatedSynchronously(true);
    editor.setSoftWrapped(false);
    component.updateSync();
    component.setScrollTop(0);
    component.setScrollLeft(0);
    component.updateSync();
    component.scrollbarActivity?.clear();
  });

  afterEach(() => {
    editor.destroy();
    element.remove();
    itemViews.remove();
  });

  function revealed() {
    return component.refs.scrollContainer.classList.contains("is-revealed");
  }

  function pointer(target, type, position) {
    const bounds = target.getBoundingClientRect();
    position ??= { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        pointerId: 1,
        clientX: position.x,
        clientY: position.y,
      }),
    );
    return position;
  }

  it("shares one recent-activity deadline across both scroll axes", () => {
    expect(revealed()).toBeFalse();
    expect(component.canScrollHorizontally()).toBeTrue();
    window.setTimeout.calls.reset();
    expect(component.setScrollTop(30)).toBeTrue();
    expect(revealed()).toBeTrue();
    advanceClock(600);
    expect(component.setScrollLeft(40)).toBeTrue();
    expect(component.getScrollLeft()).toBe(40);
    expect(window.setTimeout.calls.allArgs().filter((args) => args[1] === 700).length).toBe(1);
    advanceClock(100);
    expect(revealed()).toBeTrue();
    advanceClock(599);
    expect(revealed()).toBeTrue();
    advanceClock(1);
    expect(revealed()).toBeFalse();
  });

  it("reveals an accepted smooth wheel before its first animation frame", () => {
    editor.update({ smoothScrolling: true });
    expect(component.getScrollTop()).toBe(0);
    expect(component.applyWheelScroll(0, 100, 0)).toBeTrue();
    expect(component.getScrollTop()).toBe(0);
    expect(revealed()).toBeTrue();
  });

  it("reveals cursor navigation inside the viewport without requiring a scroll", () => {
    editor.moveDown();
    expect(editor.getCursorBufferPosition().row).toBe(1);
    expect(component.getScrollTop()).toBe(0);
    expect(revealed()).toBeTrue();
    advanceClock(700);
    expect(revealed()).toBeFalse();
  });

  for (const command of ["core:move-up", "editor:scroll-up", "editor:scroll-to-cursor"]) {
    it(`reveals handled ${command} at the document boundary`, async () => {
      await lumine.commands.dispatch(element, command);
      expect(editor.getCursorBufferPosition().row).toBe(0);
      expect(component.getScrollTop()).toBe(0);
      expect(revealed()).toBeTrue();
    });
  }

  it("does not treat text edits and reload selection adjustments as navigation", () => {
    editor.insertText("x");
    expect(revealed()).toBeFalse();
    component.didChangeSelectionRange({ textChanged: false, origin: "reload" });
    expect(revealed()).toBeFalse();
  });

  it("does not create activity timers for an editor whose content fits", () => {
    editor.update({ scrollPastEnd: false });
    editor.setText("short");
    component.updateSync();
    expect(component.canScrollVertically()).toBeFalse();
    expect(component.canScrollHorizontally()).toBeFalse();
    expect(component.scrollbarActivity).toBeFalsy();
    window.setTimeout.calls.reset();
    editor.moveRight();
    expect(lumine.scrollbars.reveal(element)).toBeFalse();
    expect(window.setTimeout.calls.allArgs().filter((args) => args[1] === 700).length).toBe(0);
  });

  it("reveals through the public API without rendering or invalidating marker geometry", () => {
    const changes = [];
    const subscription = element.onDidChangeScrollGeometry((geometry) => changes.push(geometry));
    const geometry = component.lastScrollGeometry;
    spyOn(component, "updateSync").and.callThrough();
    try {
      expect(lumine.scrollbars.reveal(element)).toBeTrue();
      expect(revealed()).toBeTrue();
      advanceClock(700);
      expect(revealed()).toBeFalse();
      expect(component.updateSync).not.toHaveBeenCalled();
      expect(component.lastScrollGeometry).toBe(geometry);
      expect(changes).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  jasmine.itWithDocumentFocus("lets a recent pulse expire while keyboard focus remains", () => {
    itemViews.style.left = "-1000px";
    component.didFocus();
    const rail = component.refs.verticalScrollbar.element;
    rail.style.transition = "none";
    expect(document.activeElement).toBe(component.getHiddenInput());
    expect(component.revealScrollbars()).toBeTrue();
    expect(revealed()).toBeTrue();
    advanceClock(700);
    expect(component.focused).toBeTrue();
    expect(document.activeElement).toBe(component.getHiddenInput());
    expect(revealed()).toBeFalse();
    expect(getComputedStyle(rail).opacity).toBe("0");
  });

  for (const release of ["pointerup", "pointercancel"]) {
    it(`keeps a stationary drag visible after the pulse expires until ${release}`, () => {
      const scrollbar = component.refs.verticalScrollbar.scrollbar;
      component.revealScrollbars();
      const position = pointer(scrollbar.thumb, "pointerdown");
      advanceClock(701);
      expect(component.scrollbarActivity.active).toBeFalse();
      expect(revealed()).toBeTrue();
      pointer(scrollbar.element, release, position);
      expect(revealed()).toBeFalse();
    });
  }

  for (const [layout, kind] of [
    ["overlay", "document"],
    ["gutter", "inline"],
  ]) {
    it(`keeps the ${layout} ${kind} presentation persistent without an activity timer`, () => {
      element.dataset.scrollbarLayout = layout;
      element.dataset.scrollbarKind = kind;
      component.updateSync();
      window.setTimeout.calls.reset();
      component.setScrollTop(30);
      component.setScrollLeft(40);
      expect(component.scrollbarActivity).toBeFalsy();
      expect(component.revealScrollbars()).toBeFalse();
      expect(window.setTimeout.calls.allArgs().filter((args) => args[1] === 700).length).toBe(0);
      expect(component.refs.scrollContainer.classList.contains("is-persistent")).toBeTrue();
    });
  }

  it("retires a pulse when the presentation becomes persistent", () => {
    component.revealScrollbars();
    element.dataset.scrollbar = "always";
    component.updateSync();
    expect(component.scrollbarActivity).toBeFalsy();
    expect(revealed()).toBeFalse();
    advanceClock(701);
    element.dataset.scrollbar = "hover";
    component.updateSync();
    expect(revealed()).toBeFalse();
    expect(component.revealScrollbars()).toBeTrue();
    expect(revealed()).toBeTrue();
  });

  it("retires activity and captured drags on detach and starts clean when reattached", () => {
    const scrollbar = component.refs.verticalScrollbar.scrollbar;
    component.revealScrollbars();
    pointer(scrollbar.thumb, "pointerdown");
    element.remove();
    expect(scrollbar.drag).toBeNull();
    expect(component.scrollbarActivity).toBeFalsy();
    expect(revealed()).toBeFalse();
    expect(component.revealScrollbars()).toBeFalse();
    advanceClock(1000);
    itemViews.appendChild(element);
    component.updateSync();
    expect(revealed()).toBeFalse();
    expect(component.revealScrollbars()).toBeTrue();
  });

  it("cancels the active deadline when the model is destroyed before DOM removal", () => {
    component.revealScrollbars();
    editor.destroy();
    expect(component.scrollbarActivity).toBeFalsy();
    expect(revealed()).toBeFalse();
    spyOn(component, "syncScrollbarVisibility").and.callThrough();
    advanceClock(1000);
    expect(component.syncScrollbarVisibility).not.toHaveBeenCalled();
  });
});
