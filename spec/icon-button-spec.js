describe("Core icon buttons", () => {
  let button, glyph;

  beforeEach(() => {
    button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.setAttribute("aria-label", "Show details");
    glyph = document.createElement("span");
    glyph.className = "icon-button-glyph icon icon-info";
    glyph.setAttribute("aria-hidden", "true");
    button.appendChild(glyph);
    jasmine.attachToDOM(button);
  });

  it("gives a plain icon control a centered glyph and honors native hidden and disabled states", () => {
    expect(getComputedStyle(button).display).toBe("inline-grid");
    expect(getComputedStyle(glyph, "::before").marginRight).toBe("0px");

    const click = jasmine.createSpy("click");
    button.addEventListener("click", click);
    button.disabled = true;
    button.click();
    expect(click).not.toHaveBeenCalled();
    expect(getComputedStyle(button).cursor).toBe("not-allowed");

    button.hidden = true;
    expect(getComputedStyle(button).display).toBe("none");
  });

  it("underlines the glyph in its own color only for a collapsed disclosure", () => {
    glyph.style.color = "rgb(11, 22, 33)";
    button.setAttribute("aria-expanded", "false");
    expect(getComputedStyle(glyph, "::after").content).toBe("none");

    button.classList.add("icon-button-disclosure");
    expect(getComputedStyle(glyph, "::after").content).toBe('""');
    expect(getComputedStyle(glyph, "::after").backgroundColor).toBe("rgb(11, 22, 33)");

    button.setAttribute("aria-expanded", "true");
    expect(getComputedStyle(glyph, "::after").content).toBe("none");
  });

  it("scales the concealed action without changing a toolbar button that shows only a glyph", () => {
    const toolbarButton = document.createElement("button");
    toolbarButton.className = "btn icon icon-info";
    toolbarButton.setAttribute("aria-label", "Details");
    jasmine.attachToDOM(toolbarButton);

    toolbarButton.focus();
    expect(toolbarButton.matches(":focus-visible")).toBeTrue();
    expect(getComputedStyle(toolbarButton, "::before").scale).toBe("none");

    glyph.style.transition = "none";
    button.focus();
    expect(button.matches(":focus-visible")).toBeTrue();
    expect(getComputedStyle(glyph).scale).toBe("1.08");
  });

  it("animates enlargement for both glyphs and images when reduced motion is off", () => {
    const image = document.createElement("img");
    image.alt = "";
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const icon of [glyph, image]) {
      button.replaceChildren(icon);
      const style = getComputedStyle(icon);
      expect(style.transitionDuration).toBe(reducedMotion ? "0s" : "0.15s");
      if (!reducedMotion) {
        expect(style.transitionProperty).toBe("scale");
        expect(style.transitionTimingFunction).toBe("ease");
      }
    }
  });
});
