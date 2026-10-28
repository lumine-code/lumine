const GutterContainerComponent = require("../src/gutter-container-component");

describe("Gutter row replacement", () => {
  let container, gutter, tile, model;
  const rootComponent = {
    renderedTileStartRows: [0],
    idsByTileStartRow: new Map([[0, 1]]),
    pixelPositionBeforeBlocksForRow: (row) => row * 20,
    heightForBlockDecorationsBeforeRow: () => 0,
    heightForBlockDecorationsAfterRow: () => 0,
  };
  function props(rows) {
    return {
      rootComponent,
      showLineNumbers: true,
      hasInitialMeasurements: true,
      guttersToRender: [model],
      renderedStartRow: 0,
      renderedEndRow: rows.length,
      rowsPerTile: 6,
      scrollTop: 0,
      scrollHeight: 600,
      lineHeight: 20,
      lineNumberGutterWidth: 40,
      activeBufferRow: rows[0],
      lineNumbersToRender: {
        maxDigits: 2,
        keys: rows,
        bufferRows: rows,
        screenRows: rows.map((_, index) => index),
        softWrappedFlags: rows.map(() => false),
        foldableFlags: rows.map(() => true),
      },
      decorationsToRender: {
        lineNumbers: new Map([["line-number", ["marked"]]]),
        blocks: new Map(),
      },
    };
  }
  beforeEach(() => {
    const element = document.createElement("div");
    model = {
      name: "line-number",
      type: "line-number",
      isVisible: () => true,
      getElement: () => element,
    };
    container = new GutterContainerComponent(props([0, 1, 2]));
    jasmine.attachToDOM(container.element);
    gutter = container.refs.lineNumberGutter;
    tile = gutter.tilesById.get(1);
  });
  afterEach(() => {
    gutter.destroy();
    container.element.remove();
  });

  it("reuses disjoint row slots while preserving labels, folding icons, classes and row maps", () => {
    const originalRows = [...tile.element.children];
    const originalText = originalRows.map((row) => row.firstChild);
    const observer = new MutationObserver(() => {});
    observer.observe(tile.element, { childList: true });
    try {
      container.update(props([10, 11, 12]));
      const records = observer.takeRecords();
      expect(records.length).toBe(0);
      expect([...tile.element.children]).toEqual(originalRows);
      expect([...tile.element.children].map((row) => row.firstChild)).toEqual(originalText);
      expect([...tile.element.children].map((row) => row.textContent.trim())).toEqual([
        "11",
        "12",
        "13",
      ]);
      expect([...tile.element.children].map((row) => row.dataset.bufferRow)).toEqual([
        "10",
        "11",
        "12",
      ]);
      expect([...tile.element.children].map((row) => row.dataset.screenRow)).toEqual([
        "0",
        "1",
        "2",
      ]);
      expect(tile.element.querySelectorAll(".foldable > .icon-right").length).toBe(3);
      expect(tile.element.firstChild.classList.contains("marked")).toBe(true);
      expect(tile.element.firstChild.classList.contains("active-line-number")).toBe(true);
      expect([...tile.lineNumbersByKey.keys()].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    } finally {
      observer.disconnect();
    }
  });

  it("keeps retained row elements on overlapping updates", () => {
    const retained = tile.lineNumbersByKey.get(1).element;
    const replace = spyOn(tile.element, "replaceChildren").and.callThrough();
    container.update(props([1, 2, 3]));
    expect(replace).not.toHaveBeenCalled();
    expect(tile.lineNumbersByKey.get(1).element).toBe(retained);
  });

  for (const text of [false, true]) {
    it(`preserves an extra package-owned ${text ? "text" : "element"} child`, () => {
      const extra = text ? document.createTextNode("package") : document.createElement("span");
      tile.element.appendChild(extra);
      const replace = spyOn(tile.element, "replaceChildren").and.callThrough();
      container.update(props([10, 11, 12]));
      expect(replace).not.toHaveBeenCalled();
      expect(extra.parentNode).toBe(tile.element);
    });
  }

  it("uses incremental removal when a package control in an outgoing row has focus", () => {
    const input = document.createElement("input");
    tile.element.firstChild.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const replace = spyOn(tile.element, "replaceChildren").and.callThrough();
    container.update(props([10, 11, 12]));
    expect(replace).not.toHaveBeenCalled();
  });
});
