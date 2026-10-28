describe("Cursor hit testing across generated decoration content", () => {
  let editor, element, component, style;
  beforeEach(() => {
    editor = lumine.workspace.buildTextEditor({ autoHeight: false, softWrapped: false });
    editor.setText("01234 56789\n" + "filler\n".repeat(30));
    element = editor.element;
    element.style.cssText = "width:800px;height:100px";
    jasmine.attachToDOM(element);
    element.setUpdatedSynchronously(true);
    component = element.component;
    style = document.createElement("style");
    style.textContent = `
      .spec-generated-label::before { content: "TYPE HINT"; display:inline-block; padding:0 8px; }
      .spec-padded-text { margin-left:0.375px; padding-right:28px; }
    `;
    document.head.appendChild(style);
  });
  afterEach(() => {
    editor.destroy();
    element.remove();
    style.remove();
  });

  for (const offscreen of [false, true]) {
    it(`maps every pixel of a generated label to its source boundary (${offscreen ? "offscreen" : "onscreen"})`, () => {
      editor.decorateMarker(
        editor.markBufferRange([
          [0, 5],
          [0, 6],
        ]),
        {
          type: "text",
          class: "spec-generated-label",
        },
      );
      component.updateSync();
      if (offscreen) {
        // Keep the decorated row mounted, but outside the browser viewport.
        element.style.transform = "translateY(-2000px)";
      }
      // Chromium's caret API can return null, a foreign node, or a range
      // whose vertical extent excludes the mouse in the line's leading.
      // The fallback must work independently of which one it returns.
      spyOn(document, "caretRangeFromPoint").and.returnValue(null);
      const error = spyOn(console, "error");
      const begin =
        component.pixelPositionForScreenPosition({ row: 0, column: 4 }).left +
        component.getBaseCharacterWidth();
      const end = component.pixelPositionForScreenPosition({ row: 0, column: 5 }).left;
      expect(end - begin).toBeGreaterThan(20);
      const top =
        component.pixelPositionForScreenPosition({ row: 0, column: 0 }).top +
        component.getLineHeight() / 2;
      for (let left = begin + 0.25; left < end; left += 0.5)
        expect(component.screenPositionForPixelPosition({ top, left })).toEqual([0, 5]);
      expect(error).not.toHaveBeenCalled();
    });
  }

  it("maps CSS padding and fractional margins to the adjacent source boundary", () => {
    editor.decorateMarker(
      editor.markBufferRange([
        [0, 2],
        [0, 5],
      ]),
      {
        type: "text",
        class: "spec-padded-text",
      },
    );
    component.updateSync();
    spyOn(document, "caretRangeFromPoint").and.returnValue(null);
    const error = spyOn(console, "error");
    const node = element.querySelector(".spec-padded-text").firstChild;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    const origin = component.refs.lineTiles.getBoundingClientRect().left;
    const top = component.getLineHeight() / 2;
    for (let x = rect.right + 0.25; x < rect.right + 28; x += 0.5)
      expect(component.screenPositionForPixelPosition({ top, left: x - origin })).toEqual([0, 5]);
    expect(
      component.screenPositionForPixelPosition({ top, left: rect.left - origin - 0.1875 }),
    ).toEqual([0, 2]);
    expect(error).not.toHaveBeenCalled();
  });
});
