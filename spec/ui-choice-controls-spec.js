const ContextViewManager = require("../src/context-view-manager");
const { showMenuPopup } = require("../src/menu-view");

describe("shared native and popup choice presentation", () => {
  let fixture;
  let stylesheet;
  let contextViews;

  beforeEach(() => {
    fixture = document.createElement("div");
    fixture.className = "ui-choice-controls-spec";
    jasmine.attachToDOM(fixture);
    stylesheet = lumine.styles.addStyleSheet(
      `:root {
        --use-custom-controls: true;
        --ui-icon-size: 16px;
        --ui-border-radius: 6px;
        --accent-indicator-color: rgb(30, 80, 160);
        --accent-indicator-text-color: rgb(245, 250, 255);
      }
      .ui-choice-controls-spec :is(.input-checkbox, .input-radio),
      .ui-choice-controls-spec :is(.input-checkbox, .input-radio)::before,
      .ui-choice-controls-spec :is(.input-checkbox, .input-radio)::after {
        transition: none;
      }`,
      { priority: 2 },
    );
  });

  afterEach(() => {
    contextViews?.destroy();
    contextViews = null;
    fixture.remove();
    stylesheet.dispose();
  });

  function pair(type, checked = false) {
    const input = document.createElement("input");
    input.type = type;
    input.className = `input-${type}`;
    input.checked = checked;
    const indicator = document.createElement("span");
    indicator.className = `choice-control${type === "radio" ? " choice-control-radio" : ""}`;
    indicator.setAttribute("aria-hidden", "true");
    indicator.dataset.checked = String(checked);
    fixture.append(input, indicator);
    return { input, indicator };
  }

  function settle(element) {
    // Flush style first so newly requested transitions are included as well.
    element.getBoundingClientRect();
    for (const animation of element.getAnimations({ subtree: true })) animation.finish();
  }

  function expectSameMark(input, indicator, pseudo) {
    const actual = getComputedStyle(indicator, pseudo);
    const expected = getComputedStyle(input, pseudo);
    for (const property of [
      "width",
      "height",
      "borderRadius",
      "backgroundColor",
      "transform",
      "transformOrigin",
      "opacity",
      "marginLeft",
      "marginTop",
    ]) {
      expect(actual[property]).withContext(`${pseudo} ${property}`).toBe(expected[property]);
    }
    // Absolute pseudo-elements start inside the padding box. A popup outline
    // must not push the mark away from the borderless form control's centre.
    for (const [position, border] of [
      ["left", "borderLeftWidth"],
      ["top", "borderTopWidth"],
    ]) {
      const actualOrigin =
        parseFloat(getComputedStyle(indicator)[border]) + parseFloat(actual[position]);
      const expectedOrigin =
        parseFloat(getComputedStyle(input)[border]) + parseFloat(expected[position]);
      expect(actualOrigin)
        .withContext(`${pseudo} outer ${position}`)
        .toBeCloseTo(expectedOrigin, 2);
    }
  }

  it("follows theme size and corner radius while preserving the same checked glyph", () => {
    for (const size of [16, 20]) {
      for (const radius of [3, 4, 6]) {
        const scope = lumine.styles.addStyleSheet(
          `:root { --ui-icon-size: ${size}px; --ui-border-radius: ${radius}px; }`,
          { priority: 2 },
        );
        try {
          const { input, indicator } = pair("checkbox", true);
          settle(fixture);
          const nativeStyle = getComputedStyle(input);
          const popupStyle = getComputedStyle(indicator);
          for (const property of ["width", "height", "borderRadius", "backgroundColor"]) {
            expect(popupStyle[property])
              .withContext(`${size}/${radius} ${property}`)
              .toBe(nativeStyle[property]);
          }
          expect(popupStyle.borderRadius).toBe(`${radius}px`);
          expectSameMark(input, indicator, "::before");
          expectSameMark(input, indicator, "::after");
          expect(getComputedStyle(indicator, "::before").opacity).toBe("1");
          expect(getComputedStyle(indicator, "::after").opacity).toBe("1");
        } finally {
          fixture.replaceChildren();
          scope.dispose();
        }
      }
    }
  });

  it("keeps unchecked popup outlines visible with the same size, corners and hidden mark", () => {
    const { input, indicator } = pair("checkbox");
    settle(fixture);
    for (const property of ["width", "height", "borderRadius"]) {
      expect(getComputedStyle(indicator)[property])
        .withContext(property)
        .toBe(getComputedStyle(input)[property]);
    }
    expect(parseFloat(getComputedStyle(indicator).borderTopWidth)).toBeGreaterThan(0);
    for (const pseudo of ["::before", "::after"]) {
      expectSameMark(input, indicator, pseudo);
      expect(getComputedStyle(indicator, pseudo).opacity).toBe("0");
    }
  });

  it("shows the same single mixed dash regardless of the checkbox's retained checked value", () => {
    for (const checked of [false, true]) {
      const { input, indicator } = pair("checkbox", checked);
      input.indeterminate = true;
      indicator.dataset.checked = "mixed";
      settle(fixture);
      expect(getComputedStyle(indicator).backgroundColor).toBe(
        getComputedStyle(input).backgroundColor,
      );
      expect(getComputedStyle(input, "::before").opacity).withContext(String(checked)).toBe("0");
      expect(getComputedStyle(indicator, "::before").opacity).toBe("0");
      expect(getComputedStyle(input, "::after").opacity).toBe("1");
      expectSameMark(input, indicator, "::after");
      const dash = getComputedStyle(indicator, "::after");
      expect(parseFloat(dash.width)).toBeGreaterThan(parseFloat(dash.height));
      const transform = new DOMMatrix(dash.transform);
      expect(transform.b).toBe(0);
      expect(transform.c).toBe(0);
    }
  });

  it("uses the same centred circular radio dot independently of the checkbox radius", () => {
    for (const checked of [false, true]) {
      const { input, indicator } = pair("radio", checked);
      settle(fixture);
      expect(getComputedStyle(input).borderRadius).toBe("50%");
      expect(getComputedStyle(indicator).borderRadius).toBe("50%");
      expectSameMark(input, indicator, "::before");
      const dot = getComputedStyle(indicator, "::before");
      expect(dot.width).toBe(dot.height);
      expect(parseFloat(dot.width)).toBeCloseTo(
        parseFloat(getComputedStyle(indicator).width) / 3,
        1,
      );
      expect(dot.borderRadius).toBe("50%");
      if (checked) {
        expect(getComputedStyle(indicator).backgroundColor).toBe(
          getComputedStyle(input).backgroundColor,
        );
        expect(dot.opacity).toBe("1");
      } else {
        expect(dot.opacity).toBe("0");
      }
    }
  });

  it("honours popup tokens in a local scope without changing native form controls", () => {
    const { input, indicator } = pair("checkbox");
    fixture.style.cssText = `
      --choice-control-size: 24px;
      --choice-control-border-width: 2px;
      --choice-control-radius: 8px;
      --choice-control-border-color: rgb(50, 60, 70);
      --choice-control-background-color: rgb(230, 235, 240);
      --choice-control-selected-border-color: rgb(70, 80, 90);
      --choice-control-selected-background-color: rgb(90, 110, 130);
      --choice-control-mark-color: rgb(240, 245, 250);
      --choice-control-disabled-opacity: 0.35;
    `;
    expect(getComputedStyle(indicator).width).toBe("24px");
    expect(getComputedStyle(indicator).borderRadius).toBe("8px");
    expect(getComputedStyle(indicator).borderTopWidth).toBe("2px");
    expect(getComputedStyle(indicator).borderTopColor).toBe("rgb(50, 60, 70)");
    expect(getComputedStyle(indicator).backgroundColor).toBe("rgb(230, 235, 240)");
    expect(getComputedStyle(input).width).toBe("16px");
    expect(getComputedStyle(input).borderRadius).toBe("6px");
    for (const checked of ["true", "mixed"]) {
      indicator.dataset.checked = checked;
      expect(getComputedStyle(indicator).borderTopColor).toBe("rgb(70, 80, 90)");
      expect(getComputedStyle(indicator).backgroundColor).toBe("rgb(90, 110, 130)");
      expect(getComputedStyle(indicator, "::after").backgroundColor).toBe("rgb(240, 245, 250)");
    }
    indicator.dataset.disabled = "true";
    expect(getComputedStyle(indicator).opacity).toBe("0.35");
    indicator.classList.add("choice-control-radio");
    indicator.dataset.checked = "true";
    expect(getComputedStyle(indicator).borderRadius).toBe("50%");
    expect(getComputedStyle(indicator, "::before").width).toBe("8px");
  });

  it("leaves semantics and keyboard focus on the owning menu row", () => {
    contextViews = new ContextViewManager({ document, window });
    const anchor = document.createElement("button");
    fixture.appendChild(anchor);
    const popup = showMenuPopup(contextViews, {
      anchor,
      template: [
        { label: "Choice", type: "checkbox", checked: true },
        { label: "Unavailable", type: "checkbox", checked: "mixed", enabled: false },
        { label: "Action" },
      ],
    });
    const [choice, unavailable, action] = popup.rootList.items;
    popup.rootList.selectItem(choice, { focus: true });
    expect(document.activeElement).toBe(choice.element);
    expect(choice.element.getAttribute("role")).toBe("menuitemcheckbox");
    expect(choice.element.getAttribute("aria-checked")).toBe("true");
    choice.indicatorElement.focus();
    expect(document.activeElement).toBe(choice.element);
    expect(choice.indicatorElement.getAttribute("aria-hidden")).toBe("true");
    expect(choice.indicatorElement.tabIndex).toBe(-1);
    expect(getComputedStyle(choice.indicatorElement).pointerEvents).toBe("none");
    expect(unavailable.element.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.element.getAttribute("aria-checked")).toBe("mixed");
    expect(unavailable.indicatorElement.dataset.disabled).toBe("true");
    expect(action.indicatorElement).toBeNull();
    expect(action.element.hasAttribute("aria-checked")).toBe(false);
    expect(popup.element.querySelector("input")).toBeNull();
  });

  it("keeps native fallback controls and readable decorative indicators when custom controls are off", () => {
    fixture.style.setProperty("--use-custom-controls", "false");
    for (const type of ["checkbox", "radio"]) {
      const { input, indicator } = pair(type, true);
      expect(getComputedStyle(input).appearance).not.toBe("none");
      for (const pseudo of ["::before", "::after"]) {
        expect(["none", "normal"]).toContain(getComputedStyle(input, pseudo).content);
      }
      expect(indicator.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(getComputedStyle(indicator, type === "radio" ? "::before" : "::after").opacity).toBe(
        "1",
      );
      expect(indicator.tabIndex).toBe(-1);
      expect(indicator.querySelector("input")).toBeNull();
    }
  });
});
