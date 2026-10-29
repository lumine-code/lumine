describe("base custom control focus", () => {
  it("provides a keyboard ring for non-text controls without a UI theme", () => {
    const host = document.createElement("div");
    host.style.cssText = "--use-custom-controls: true; --accent-indicator-color: rgb(20,80,180);";
    const text = document.createElement("input");
    host.appendChild(text);
    jasmine.attachToDOM(host);
    try {
      text.focus();
      for (const type of ["radio", "toggle", "range", "select", "color"]) {
        const control = document.createElement(type === "select" ? "select" : "input");
        if (type !== "select") control.type = type === "toggle" ? "checkbox" : type;
        control.className = `input-${type}`;
        host.appendChild(control);
        control.focus();
        expect(control.matches(":focus-visible")).withContext(type).toBe(true);
        expect(getComputedStyle(control).boxShadow)
          .withContext(type)
          .toBe("rgb(20, 80, 180) 0px 0px 0px 2px");
      }
    } finally {
      host.remove();
    }
  });

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
