describe("block cleanup model reentry", () => {
  it("keeps a same-model no-op during cleanup from cancelling the requested replacement", () => {
    const first = lumine.workspace.buildTextEditor();
    const second = lumine.workspace.buildTextEditor();
    let element;
    try {
      first.setText("content\n".repeat(30));
      second.setText("content\n".repeat(30));
      const previous = document.createElement("div");
      previous.style.height = "40px";
      previous.setAttribute("data-block-decoration-selected", "true");
      first.decorateMarker(first.markBufferPosition([2, 0]), { type: "block", item: previous });
      const replacement = document.createElement("div");
      replacement.style.height = "60px";
      second.decorateMarker(second.markBufferPosition([2, 0]), {
        type: "block",
        item: replacement,
      });
      element = first.getElement();
      element.style.cssText = "width: 600px; height: 300px;";
      jasmine.attachToDOM(element);
      const component = element.getComponent();
      component.updateSync();
      const removeAttribute = previous.removeAttribute.bind(previous);
      let reentered = false;
      spyOn(previous, "removeAttribute").and.callFake((name) => {
        removeAttribute(name);
        if (name === "data-block-decoration-selected" && !reentered) {
          reentered = true;
          element.setModel(first);
        }
      });

      element.setModel(second);
      component.updateSync();

      expect(reentered).toBe(true);
      expect(element.getModel()).toBe(second);
      expect(component.blockDecorationOwner?.model).toBe(second);
      expect(component.pixelPositionAfterBlocksForRow(2)).toBe(2 * component.getLineHeight() + 60);
      first.destroy();
      expect(component.pixelPositionAfterBlocksForRow(2)).toBe(2 * component.getLineHeight() + 60);
    } finally {
      first.destroy();
      second.destroy();
      element?.remove();
    }
  });
});
