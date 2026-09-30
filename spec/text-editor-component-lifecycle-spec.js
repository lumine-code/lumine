const TextEditorComponent = require("../src/text-editor-component");
const TextEditorElement = require("../src/text-editor-element");

describe("Mounted text editor component lifecycle", () => {
  const fixtures = [];
  let initialAttachedCount;

  function attachedCount() {
    return TextEditorComponent.attachedComponents?.size || 0;
  }

  function buildFixture() {
    const editor = lumine.workspace.buildTextEditor();
    editor.setText("first\nsecond");
    const element = editor.getElement();
    element.setUpdatedSynchronously(false);
    jasmine.attachToDOM(element);
    const component = element.component;
    const fixture = { editor, element, component };
    fixtures.push(fixture);
    return fixture;
  }

  beforeEach(() => {
    initialAttachedCount = attachedCount();
  });

  afterEach(() => {
    for (const { editor, element } of fixtures.splice(0)) {
      editor.destroy();
      element.remove();
    }
    lumine.views.performDocumentUpdate();
  });

  it("keeps the same model and component when a live element is reattached", () => {
    const { editor, element, component } = buildFixture();
    editor.setCursorBufferPosition([1, 3]);
    expect(attachedCount()).toBe(initialAttachedCount + 1);

    element.remove();
    expect(component.attached).toBe(false);
    expect(attachedCount()).toBe(initialAttachedCount);
    expect(editor.isAlive()).toBe(true);

    jasmine.attachToDOM(element);
    expect(element.component === component).toBe(true);
    expect(element.getModel() === editor).toBe(true);
    expect(editor.getCursorBufferPosition().toArray()).toEqual([1, 3]);
    expect(component.attached).toBe(true);
    expect(attachedCount()).toBe(initialAttachedCount + 1);
  });

  it("releases the attached component before a destroyed model loses its element", () => {
    const { editor, element, component } = buildFixture();
    const disconnectResize = spyOn(component.resizeObserver, "disconnect").and.callThrough();
    const disconnectIntersection = spyOn(
      component.intersectionObserver,
      "disconnect",
    ).and.callThrough();
    let attachedDuringDestroy;
    editor.onDidDestroy(() => {
      attachedDuringDestroy = component.attached;
    });

    editor.destroy();
    expect(attachedDuringDestroy).toBe(false);
    expect(attachedCount()).toBe(initialAttachedCount);
    expect(disconnectResize).toHaveBeenCalledTimes(1);
    expect(disconnectIntersection).toHaveBeenCalledTimes(1);
    expect(element.component).toBeNull();

    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    element.dispatchEvent(new FocusEvent("blur"));
    element.dispatchEvent(new FocusEvent("focus"));
    element.remove();
    expect(build).not.toHaveBeenCalled();
    expect(element.component).toBeNull();
    expect(attachedCount()).toBe(initialAttachedCount);
  });

  it("does not initialize an unused element while handling detach or focus events", () => {
    const element = TextEditorElement.createTextEditorElement();
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    element.disconnectedCallback();
    element.dispatchEvent(new FocusEvent("focus"));
    element.dispatchEvent(new FocusEvent("blur"));
    expect(build).not.toHaveBeenCalled();
    expect(element.component).toBeUndefined();

    const editor = element.getModel();
    expect(build).toHaveBeenCalledTimes(1);
    expect(editor.isAlive()).toBe(true);
    editor.destroy();
  });

  jasmine.itWithDocumentFocus(
    "stops blinking and avoids phantom models when closing a focused editor",
    () => {
      const { editor, element, component } = buildFixture();
      element.focus();
      expect(component.focused).toBe(true);
      expect(component.cursorsBlinking).toBe(true);
      const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();

      editor.destroy();
      expect(component.focused).toBe(false);
      expect(component.cursorsBlinking).toBe(false);
      expect(component.cursorBlinkIntervalHandle).toBeNull();
      element.remove();
      lumine.views.performDocumentUpdate();
      expect(build).not.toHaveBeenCalled();
      expect(element.component).toBeNull();
      expect(attachedCount()).toBe(initialAttachedCount);
    },
  );

  it("does not accumulate components or recreate models across repeated mounted closes", () => {
    const build = spyOn(lumine.workspace, "buildTextEditor").and.callThrough();
    for (let iteration = 0; iteration < 20; iteration++) {
      const { editor, element, component } = buildFixture();
      editor.destroy();
      element.remove();
      lumine.views.performDocumentUpdate();
      expect(component.attached).toBe(false);
      expect(element.component).toBeNull();
      expect(attachedCount()).toBe(initialAttachedCount);
    }
    expect(build).toHaveBeenCalledTimes(20);
  });
});
