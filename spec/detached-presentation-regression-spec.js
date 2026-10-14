describe("detached presentation DOM boundaries", () => {
  beforeEach(() => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => lumine.workspace.discardEditorWindows());

  it("snaps text and gutter scrolling to the destination monitor's pixel grid", async () => {
    const editor = await lumine.workspace.open();
    editor.setText("pixel grid\n".repeat(100));
    const extra = await lumine.workspace.detachItem(editor);
    const component = editor.getElement().getComponent();
    await conditionPromise(() => component.hasInitialMeasurements);
    spyOnProperty(window, "devicePixelRatio", "get").and.returnValue(1);
    spyOnProperty(extra.getDOMWindow(), "devicePixelRatio", "get").and.returnValue(2);
    spyOn(component, "getScrollTop").and.returnValue(0.3);
    spyOn(component, "getScrollLeft").and.returnValue(0.3);
    component.updateContentScrollTransform();
    expect(component.renderedScrollTop).toBe(0.5);
    expect(component.renderedScrollLeft).toBe(0.5);
    component.refs.gutterContainer.updateScrollTop(0.3);
    expect(component.refs.gutterContainer.innerElement.style.transform).toBe("translateY(-0.5px)");
  });

  for (const wrapped of [false, true]) {
    it(`accepts a ${wrapped ? "custom row view" : "row element"} constructed in another presentation`, async () => {
      const extra = await lumine.workspace.openEditorWindow({ show: false });
      const row = extra.getDocument().createElement("li");
      row.textContent = "Auxiliary row";
      const destroy = jasmine.createSpy("row destructor");
      const list = lumine.workspace.buildSelectList({
        items: ["row"],
        renderItem: () => (wrapped ? { element: row, destroy } : row),
      });
      try {
        const element = list.getElement();
        expect(element.querySelector("li")).toBe(row);
        expect(element.textContent).toContain("Auxiliary row");
      } finally {
        await list.destroy();
      }
      if (wrapped) expect(destroy).toHaveBeenCalledTimes(1);
    });
  }

  it("restores the local editor after a custom auxiliary modal closes", async () => {
    const editor = await lumine.workspace.open();
    const extra = await lumine.workspace.detachItem(editor);
    const document = extra.getDocument();
    editor.getElement().focus();
    const input = document.createElement("input");
    const panel = extra.addModalPanel({
      item: input,
      visible: false,
      autoFocus: input,
      restoreFocus: true,
    });
    try {
      panel.show();
      expect(document.activeElement).toBe(input);
      panel.hide();
      expect(editor.getElement().contains(document.activeElement)).toBeTrue();
      spyOn(lumine.workspace, "getFocusedWindow").and.returnValue(extra);
      expect(lumine.workspace.getFocusedTextEditor()).toBe(editor);
    } finally {
      panel.destroy();
    }
  });
});
