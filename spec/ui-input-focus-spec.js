describe("base custom checkbox focus", () => {
  it("keeps a keyboard focus indicator without requiring a UI theme", () => {
    const host = document.createElement("div");
    host.style.cssText = "--use-custom-controls: true; --accent-indicator-color: rgb(20,80,180);";
    const text = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "input-checkbox";
    host.append(text, checkbox);
    jasmine.attachToDOM(host);
    try {
      // Programmatic focus preserves the previous control's visible focus state.
      text.focus();
      checkbox.focus();
      expect(checkbox.matches(":focus-visible")).toBe(true);
      const style = getComputedStyle(checkbox);
      expect(style.outlineStyle).toBe("none");
      expect(style.boxShadow).toBe("rgb(20, 80, 180) 0px 0px 0px 2px");
    } finally {
      host.remove();
    }
  });
});
