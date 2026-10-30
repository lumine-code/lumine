const fs = require("node:fs");
const path = require("node:path");
const ContextViewManager = require("../src/context-view-manager");
const SelectBoxView = require("../src/select-box-view");

describe("SelectBox choice state", () => {
  let contextViews, selectBoxes, styles;

  beforeEach(() => {
    contextViews = new ContextViewManager({ document, window });
    selectBoxes = [];
    styles = document.createElement("style");
    styles.textContent = ["inputs.css", "select-box.css"]
      .map((name) =>
        fs.readFileSync(path.join(__dirname, "../static/lumine-ui/styles", name), "utf8"),
      )
      .join("\n");
    document.head.appendChild(styles);
  });

  afterEach(() => {
    for (const selectBox of selectBoxes) selectBox.destroy();
    contextViews.destroy();
    styles.remove();
  });

  function createSelectBox(options = {}) {
    const selectBox = new SelectBoxView(
      { contextViewManager: contextViews },
      {
        items: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta", disabled: true },
          { value: "gamma", label: "Gamma" },
          { value: "delta", label: "Delta" },
        ],
        value: "alpha",
        ariaLabel: "Example choice",
        ...options,
      },
    );
    selectBoxes.push(selectBox);
    document.body.appendChild(selectBox.element);
    return selectBox;
  }

  function keydown(target, key) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  it("keeps the current value marked while keyboard navigation moves to another option", async () => {
    const selectBox = createSelectBox();
    const changes = jasmine.createSpy("changes");
    selectBox.onDidChange(changes);
    await selectBox.open();
    const list = selectBox.listElement;
    const rows = [...list.querySelectorAll('[role="option"]')];
    const indicators = rows.map((row) => row.querySelector(".select-box-option-indicator"));

    expect(list.getAttribute("role")).toBe("listbox");
    expect(rows.map((row) => row.textContent)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(indicators.every((indicator) => indicator.getAttribute("aria-hidden") === "true")).toBe(
      true,
    );
    expect(indicators.every((indicator) => !indicator.hasAttribute("tabindex"))).toBe(true);

    keydown(list, "ArrowDown");
    expect(rows[2].classList.contains("active")).toBe(true);
    expect(list.getAttribute("aria-activedescendant")).toBe(rows[2].id);
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(indicators.map((indicator) => indicator.dataset.checked)).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(selectBox.value).toBe("alpha");
    expect(changes).not.toHaveBeenCalled();

    // The value marker owns the persistent state; row backgrounds own navigation.
    list.style.pointerEvents = "none";
    expect(getComputedStyle(rows[0]).backgroundColor).toBe(
      getComputedStyle(rows[3]).backgroundColor,
    );
    expect(parseFloat(getComputedStyle(indicators[0]).width)).toBeGreaterThan(0);
    expect(getComputedStyle(indicators[0]).width).toBe(getComputedStyle(indicators[2]).width);
    expect(getComputedStyle(indicators[0]).backgroundColor).not.toBe(
      getComputedStyle(indicators[2]).backgroundColor,
    );

    keydown(list, "Escape");
    expect(selectBox.value).toBe("alpha");
    expect(selectBox.element.getAttribute("aria-expanded")).toBe("false");
    expect(selectBox.element.hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.activeElement).toBe(selectBox.element);
  });

  it("commits the navigated option only on confirmation and restores trigger focus", async () => {
    const selectBox = createSelectBox();
    const changes = jasmine.createSpy("changes");
    selectBox.onDidChange(changes);
    await selectBox.open();
    const list = selectBox.listElement;
    const rows = [...list.querySelectorAll('[role="option"]')];

    rows[2].dispatchEvent(new MouseEvent("mouseenter"));
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[2].getAttribute("aria-selected")).toBe("false");
    expect(selectBox.value).toBe("alpha");

    keydown(list, "Enter");
    expect(selectBox.value).toBe("gamma");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes.calls.mostRecent().args[0].value).toBe("gamma");
    expect(changes.calls.mostRecent().args[0].index).toBe(2);
    expect(selectBox.popup).toBeNull();
    expect(document.activeElement).toBe(selectBox.element);
  });

  it("lets the indicator, label and remaining row area select the same full-width option", async () => {
    const selectBox = createSelectBox();
    const changes = jasmine.createSpy("changes");
    selectBox.onDidChange(changes);

    for (const targetSelector of [
      ".select-box-option-indicator",
      ".select-box-option-label",
      null,
    ]) {
      selectBox.setValue("alpha");
      await selectBox.open();
      const row = selectBox.optionElements[2];
      (targetSelector ? row.querySelector(targetSelector) : row).click();
      expect(selectBox.value).toBe("gamma");
      expect(selectBox.popup).toBeNull();
    }
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("retains a disabled current value marker and skips it during navigation", async () => {
    const selectBox = createSelectBox({ value: "beta" });
    await selectBox.open();
    const list = selectBox.listElement;
    const rows = selectBox.optionElements;
    const indicator = rows[1].querySelector(".select-box-option-indicator");

    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-disabled")).toBe("true");
    expect(indicator.dataset.checked).toBe("true");
    expect(indicator.dataset.disabled).toBe("true");
    expect(rows[2].classList.contains("active")).toBe(true);
    rows[1].click();
    expect(selectBox.popup).not.toBeNull();
    expect(selectBox.value).toBe("beta");

    keydown(list, "Home");
    expect(rows[0].classList.contains("active")).toBe(true);
    keydown(list, "End");
    expect(rows[3].classList.contains("active")).toBe(true);
    keydown(list, " ");
    expect(selectBox.value).toBe("delta");
  });
});
