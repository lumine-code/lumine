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

  it("scales only the glyph of an opted-in icon button on keyboard focus", () => {
    const labelled = document.createElement("button");
    labelled.className = "btn icon icon-info";
    labelled.textContent = "Details";
    jasmine.attachToDOM(labelled);

    labelled.focus();
    expect(labelled.matches(":focus-visible")).toBeTrue();
    expect(getComputedStyle(labelled, "::before").scale).toBe("none");

    glyph.style.transition = "none";
    button.focus();
    expect(button.matches(":focus-visible")).toBeTrue();
    expect(getComputedStyle(glyph).scale).toBe("1.08");

    button.classList.add("icon-button-no-scale");
    expect(getComputedStyle(glyph).scale).toBe("none");
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
