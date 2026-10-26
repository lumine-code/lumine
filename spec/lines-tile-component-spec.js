const LinesTileComponent = require("../src/lines-tile-component");
const NodePool = require("../src/node-pool");

describe("LinesTileComponent row replacement", () => {
  let tile,
    id = 0;
  const line = (text) => ({
    id: ++id,
    lineText: text,
    tags: [-1, -3, 3, -4, 1, -5, text.length - 4, -6, -2],
  });
  function props(screenLines, extra = {}) {
    return {
      measuredContent: false,
      height: 60,
      width: 300,
      top: 0,
      lineHeight: 20,
      renderedStartRow: 0,
      tileStartRow: 0,
      tileEndRow: screenLines.length,
      screenLines,
      lineDecorations: [],
      textDecorations: [],
      nodePool: tile?.props.nodePool ?? new NodePool(),
      lineComponentsByScreenLineId: tile?.props.lineComponentsByScreenLineId ?? new Map(),
      horizontalPixelPositionsByScreenLineId:
        tile?.props.horizontalPixelPositionsByScreenLineId ?? new Map(),
      displayLayer: {
        foldCharacter: "…",
        isOpenTag: (tag) => tag < 0 && tag % 2 === -1,
        isCloseTag: (tag) => tag < 0 && tag % 2 === 0,
        classNameForTag: (tag) => (tag === -1 ? "syntax--source" : "syntax--keyword"),
      },
      ...extra,
    };
  }
  afterEach(() => {
    tile?.destroy();
    tile = null;
  });

  it("replaces disjoint rows in one removal and one insertion without changing scope markup", () => {
    const old = [line("old one"), line("old two"), line("old three")];
    tile = new LinesTileComponent(props(old));
    jasmine.attachToDOM(tile.element);
    const cache = tile.props.horizontalPixelPositionsByScreenLineId;
    for (const item of old) cache.set(item.id, [10]);
    const observer = new MutationObserver(() => {});
    observer.observe(tile.element, { childList: true });
    const next = [line("new one"), line("new two"), line("new three")];
    try {
      tile.update(props(next));
      const records = observer.takeRecords();
      expect(records.length).toBe(2);
      expect(records[0].removedNodes.length).toBe(3);
      expect(records[1].addedNodes.length).toBe(3);
      expect([...tile.element.children].map((node) => node.textContent)).toEqual(
        next.map((item) => item.lineText),
      );
      for (const component of tile.lineComponents) {
        expect(
          component.element.querySelector(".syntax--source > .syntax--keyword").textContent,
        ).toBe("new");
        expect(component.textNodes.map((node) => node.data).join("")).toBe(
          component.props.screenLine.lineText,
        );
        expect(tile.props.lineComponentsByScreenLineId.get(component.props.screenLine.id)).toBe(
          component,
        );
      }
      for (const item of old) {
        expect(tile.props.lineComponentsByScreenLineId.has(item.id)).toBeFalse();
        expect(cache.has(item.id)).toBeFalse();
      }
    } finally {
      observer.disconnect();
    }
  });

  it("keeps existing row elements when rows overlap", () => {
    const first = line("old one"),
      retained = line("old two");
    tile = new LinesTileComponent(props([first, retained]));
    const element = tile.lineComponents[1].element;
    tile.update(props([retained, line("new one")]));
    expect(tile.lineComponents[0].element).toBe(element);
  });

  it("inserts before the local row while another tile has registered its replacement", () => {
    const retained = line("retained row");
    const shared = props([retained]);
    tile = new LinesTileComponent(shared);
    const neighbor = new LinesTileComponent({ ...shared, screenLines: [line("old neighbor")] });
    const retainedElement = tile.lineComponents[0].element;
    try {
      neighbor.update({ ...shared, screenLines: [retained] });
      const inserted = line("new row");
      tile.update({ ...shared, screenLines: [inserted, retained] });
      expect([...tile.element.children].map((node) => node.textContent)).toEqual([
        "new row",
        "retained row",
      ]);
      expect(tile.lineComponents[1].element).toBe(retainedElement);
      expect(neighbor.lineComponents[0].element.parentNode).toBe(neighbor.element);
    } finally {
      neighbor.destroy();
    }
  });

  it("keeps incremental replacement when a package has focused content inside a row", () => {
    tile = new LinesTileComponent(props([line("old one"), line("old two"), line("old three")]));
    jasmine.attachToDOM(tile.element);
    const input = document.createElement("input");
    tile.lineComponents[0].element.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    const observer = new MutationObserver(() => {});
    observer.observe(tile.element, { childList: true });
    try {
      tile.update(props([line("new one"), line("new two"), line("new three")]));
      expect(observer.takeRecords().length).toBe(6);
    } finally {
      observer.disconnect();
    }
  });

  for (const kind of ["element", "text"]) {
    it(`preserves an extra package-owned ${kind} child`, () => {
      tile = new LinesTileComponent(props([line("old one"), line("old two")]));
      const extra =
        kind === "text" ? document.createTextNode("extra") : document.createElement("span");
      tile.element.appendChild(extra);
      tile.update(props([line("new one"), line("new two")]));
      expect(extra.parentNode).toBe(tile.element);
      expect(tile.element.childNodes.length).toBe(3);
    });
  }

  it("preserves the block decoration reconciliation path", () => {
    const first = line("old one"),
      second = line("new one"),
      item = document.createElement("div");
    const decoration = { position: "after", item };
    tile = new LinesTileComponent(
      props([first], { blockDecorations: new Map([[first.id, [decoration]]]) }),
    );
    jasmine.attachToDOM(tile.element);
    tile.update(props([second], { blockDecorations: new Map([[second.id, [decoration]]]) }));
    expect(item.parentNode).toBe(tile.element);
    expect(item.previousSibling).toBe(tile.lineComponents[0].element);
  });
});
