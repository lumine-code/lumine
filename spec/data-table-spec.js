describe("shared interface data tables", () => {
  let host;
  let table;

  beforeEach(() => {
    host = document.createElement("div");
    host.className = "data-table-container";
    host.tabIndex = -1;
    host.innerHTML = `
      <table class="data-table">
        <thead><tr>
          <th scope="col" aria-sort="none"><button type="button" class="data-table-sort native-key-bindings">Name</button></th>
          <th scope="col">Actions</th>
        </tr></thead>
        <tbody><tr class="data-table-row current focused" tabindex="0"><td>Alpha</td><td>Ready</td></tr></tbody>
      </table>`;
    table = host.querySelector("table");
    jasmine.attachToDOM(host);
  });

  afterEach(() => host.remove());

  it("uses theme geometry, typography and horizontal separators in natural and grid layouts", () => {
    table.style.cssText = `
      --ui-font-family: monospace;
      --ui-font-size: 14px;
      --ui-spacing: 10px;
      --data-grid-header-height: 40px;
      --data-grid-row-height: 36px;
      --data-grid-border-color: rgb(12, 34, 56);
      --data-grid-header-color: rgb(32, 42, 52);
    `;
    const header = table.querySelector("thead");
    const cell = table.querySelector("td");
    const row = cell.parentElement;
    const check = () => {
      expect(getComputedStyle(table).fontFamily).toBe("monospace");
      expect(getComputedStyle(cell).fontSize).toBe("14px");
      expect(Math.round(header.getBoundingClientRect().height)).toBe(40);
      expect(Math.round(row.getBoundingClientRect().height)).toBe(36);
      expect(getComputedStyle(header).backgroundColor).toBe("rgb(32, 42, 52)");
      expect(getComputedStyle(cell).borderBottomColor).toBe("rgb(12, 34, 56)");
      expect(getComputedStyle(cell).borderBottomWidth).toBe("1px");
      expect(getComputedStyle(cell).borderInlineStartWidth).toBe("0px");
      expect(getComputedStyle(cell).borderInlineEndWidth).toBe("0px");
    };
    check();

    table.style.display = "flex";
    table.style.flexDirection = "column";
    for (const section of [header, table.querySelector("tbody")]) section.style.display = "block";
    for (const tableRow of table.querySelectorAll("tr")) {
      tableRow.style.display = "grid";
      tableRow.style.gridTemplateColumns = "1fr 1fr";
    }
    check();

    table.style.setProperty("--data-grid-row-height", "42px");
    expect(Math.round(row.getBoundingClientRect().height)).toBe(42);
  });

  it("derives the direction indicator and selected header surface from aria-sort", () => {
    table.style.setProperty("--text-color-highlight", "rgb(60, 70, 80)");
    const column = table.querySelector("th");
    const button = column.querySelector("button");
    expect(getComputedStyle(button).transitionDuration).toBe("0s");
    expect(getComputedStyle(button, "::after").content).toBe('""');
    column.setAttribute("aria-sort", "ascending");
    expect(getComputedStyle(button, "::after").content).toBe('"↑"');
    expect(getComputedStyle(button).color).toBe("rgb(60, 70, 80)");
    expect(getComputedStyle(button, "::after").color).toBe("rgb(60, 70, 80)");
    expect(getComputedStyle(button).appearance).toBe("none");
    column.setAttribute("aria-sort", "descending");
    expect(getComputedStyle(button, "::after").content).toBe('"↓"');
    column.setAttribute("aria-sort", "none");
    expect(getComputedStyle(button, "::after").content).toBe('""');
    expect(table.querySelectorAll(".data-table-sort").length).toBe(1);
  });

  it("paints row states on the cells and follows the focus-owning container", () => {
    const row = table.querySelector("tbody tr");
    const cell = row.firstElementChild;
    row.style.setProperty("--data-table-row-tint", "rgb(200, 100, 0)");
    expect(getComputedStyle(cell).transitionDuration).toBe("0s");
    const swatch = document.createElement("div");
    swatch.style.backgroundColor = "color-mix(in srgb, rgb(200, 100, 0) 25%, transparent)";
    host.appendChild(swatch);
    expect(getComputedStyle(cell).backgroundColor).toBe(getComputedStyle(swatch).backgroundColor);
    table.style.setProperty("--data-grid-accent-color", "rgb(23, 45, 67)");
    host.focus();
    expect(getComputedStyle(row).outlineStyle).toBe("dotted");
    expect(getComputedStyle(row).outlineColor).toBe("rgb(23, 45, 67)");
    host.blur();
    expect(getComputedStyle(row).outlineStyle).toBe("none");
  });

  it("grows with interface typography when the theme minimum is smaller than the content", () => {
    table.style.cssText = `
      --ui-font-size: 20px;
      --ui-spacing: 10px;
      --data-grid-header-height: 24px;
      --data-grid-row-height: 24px;
    `;
    const row = table.querySelector("tbody tr");
    expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(35);
    expect(table.querySelector("thead").getBoundingClientRect().height).toBeGreaterThanOrEqual(35);
    table.style.display = "flex";
    table.style.flexDirection = "column";
    for (const section of table.children) section.style.display = "block";
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 1fr";
    expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(35);
    expect(row.firstElementChild.scrollHeight).toBeLessThanOrEqual(
      row.firstElementChild.clientHeight,
    );
  });

  it("shares a full-height header action without tinting it or losing the sort indicator", () => {
    table.style.setProperty("--ui-font-size", "12px");
    table.style.setProperty("--data-grid-header-height", "32px");
    table.style.width = "400px";
    const column = table.querySelector("th");
    const sort = column.querySelector("button");
    const controls = document.createElement("div");
    controls.className = "data-table-header-controls";
    const action = document.createElement("button");
    action.className = "data-table-header-action icon icon-x";
    action.type = "button";
    action.setAttribute("aria-label", "Clear all");
    column.appendChild(controls);
    controls.append(sort, action);
    column.setAttribute("aria-sort", "ascending");

    const rect = column.getBoundingClientRect();
    const actionRect = action.getBoundingClientRect();
    expect(actionRect.width).toBe(24);
    expect(Math.abs(actionRect.right - rect.right)).toBeLessThan(1);
    expect(Math.abs(actionRect.top - rect.top)).toBeLessThan(1);
    expect(actionRect.height).toBeGreaterThanOrEqual(31);
    expect(getComputedStyle(action).borderInlineStartWidth).toBe("1px");
    expect(getComputedStyle(action).borderRadius).toBe("0px");
    expect(getComputedStyle(action).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(action).cursor).toBe("default");
    expect(getComputedStyle(action).transitionDuration).toBe("0s");
    expect(getComputedStyle(sort, "::after").content).toBe('"↑"');
  });

  it("uses the application cursor for rows and actions while preserving navigation and disabled cursors", () => {
    const cell = table.querySelector("td");
    cell.innerHTML = `<span>Row text</span>
      <button type="button" class="btn-link data-table-action">Inspect</button>
      <a href="https://lumine-code.github.io">Documentation</a>
      <button type="button" class="btn" disabled>Unavailable</button>`;
    expect(getComputedStyle(cell).cursor).toBe("default");
    expect(getComputedStyle(cell.querySelector("span")).cursor).toBe("default");
    expect(getComputedStyle(table.querySelector(".data-table-sort")).cursor).toBe("default");
    expect(getComputedStyle(cell.querySelector(".data-table-action")).cursor).toBe("default");
    expect(getComputedStyle(cell.querySelector("a")).cursor).toBe("pointer");
    expect(getComputedStyle(cell.querySelector(":disabled")).cursor).toBe("not-allowed");
  });
});
