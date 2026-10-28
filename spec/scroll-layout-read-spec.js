describe("Scroll layout reads", () => {
  let editor, element, component;
  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    editor.setText("short row\n".repeat(100));
    element = editor.element;
    element.style.cssText = "width:800px;height:200px";
    jasmine.attachToDOM(element);
    element.setUpdatedSynchronously(true);
    component = element.component;
    component.updateSync();
  });
  afterEach(() => {
    editor.destroy();
    element.remove();
  });

  it("does not read visibility to measure an empty block-decoration queue", () => {
    expect(component.blockDecorationsToMeasure.size).toBe(0);
    expect(component.remeasureAllBlockDecorations).toBeFalsy();
    const visible = spyOn(component, "isVisible").and.callThrough();
    component.setScrollTop(100);
    component.updateSync();
    expect(visible).not.toHaveBeenCalled();
  });

  it("does not measure horizontal window bounds when every line is already fully rendered", () => {
    spyOn(component, "canScrollHorizontally").and.returnValue(true);
    const measure = spyOn(component.refs.lineTiles, "getBoundingClientRect").and.callThrough();
    expect(component.horizontalWindowMissesViewport()).toBeFalse();
    expect(measure).not.toHaveBeenCalled();
  });
});
