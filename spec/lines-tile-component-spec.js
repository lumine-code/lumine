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

  function scrollableBlock() {
    const tag = `tile-scroll-fixture-${++id}`;
    customElements.define(
      tag,
      class extends HTMLElement {
        disconnectedCallback() {
          this.disconnects = (this.disconnects || 0) + 1;
        }
        connectedMoveCallback() {
          this.moves = (this.moves || 0) + 1;
        }
      },
    );
    const item = document.createElement(tag);
    item.style.cssText = "display:block;width:120px;height:80px;overflow:auto";
    const content = document.createElement("div");
    content.style.cssText = "width:800px;height:1000px";
    const input = document.createElement("input");
    content.appendChild(input);
    item.appendChild(content);
    return { item, input };
  }
  afterEach(() => {
    tile?.destroy();
    tile = null;
  });

  it("retargets disjoint owned rows without replacing their shells or changing scope markup", () => {
    const old = [line("old one"), line("old two"), line("old three")];
    tile = new LinesTileComponent(props(old));
    jasmine.attachToDOM(tile.element);
    const shells = [...tile.element.children];
    const cache = tile.props.horizontalPixelPositionsByScreenLineId;
    for (const item of old) cache.set(item.id, [10]);
    const observer = new MutationObserver(() => {});
    observer.observe(tile.element, { childList: true });
    const next = [line("new one"), line("new two"), line("new three")];
    try {
      tile.update(props(next));
      const records = observer.takeRecords();
      expect(records.length).toBe(0);
      expect([...tile.element.children]).toEqual(shells);
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

  it("keeps a batched replacement fallback for rows requiring arbitrary inline styles", () => {
    tile = new LinesTileComponent(props([line("old one"), line("old two")]));
    const observer = new MutationObserver(() => {});
    observer.observe(tile.element, { childList: true });
    try {
      tile.update(
        props([line("new one"), line("new two")], {
          textDecorations: [0, 1].map(() => [{ column: 0, style: { color: "red" } }]),
        }),
      );
      const records = observer.takeRecords();
      expect(records.length).toBe(2);
      expect(records[0].removedNodes.length).toBe(2);
      expect(records[1].addedNodes.length).toBe(2);
      expect(tile.element.textContent).toBe("new onenew two");
      expect(tile.element.querySelectorAll('[style*="color: red"]').length).toBeGreaterThan(0);
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

  it("resolves recycled rows through the replacement model's scope table", () => {
    tile = new LinesTileComponent(props([line("old one")]));
    const next = props([line("new one")]);
    next.displayLayer.classNameForTag = () => "syntax--replacement";
    tile.update(next);
    expect(tile.lineComponents[0].props.displayLayer).toBe(next.displayLayer);
    expect(tile.element.querySelector(".syntax--replacement")).not.toBeNull();
    expect(tile.element.querySelector(".syntax--source")).toBeNull();
  });

  it("repairs detached rows before a resize uses them as insertion anchors", () => {
    const old = props([line("old one"), line("old two")]);
    tile = new LinesTileComponent(old);
    const extra = document.createElement("aside");
    tile.element.appendChild(extra);
    tile.lineComponents[0].element.remove();
    const next = [line("new one"), old.screenLines[1]];
    expect(() => tile.update(props(next, { height: 80 }))).not.toThrow();
    expect(tile.lineComponents.map((c) => c.element.textContent)).toEqual(
      next.map((l) => l.lineText),
    );
    expect(tile.lineComponents.every((c) => c.element.parentNode === tile.element)).toBeTrue();
    expect(extra.parentNode).toBe(tile.element);
    expect(extra.previousSibling).toBe(tile.lineComponents[1].element);
  });

  it("does not remove a reused shell owned by another tile when repairing a retired row", () => {
    const shared = props([line("old one")]);
    tile = new LinesTileComponent(shared);
    const retired = tile.lineComponents[0];
    retired.destroy();
    const neighbor = new LinesTileComponent({ ...shared, screenLines: [line("neighbor")] });
    try {
      expect(neighbor.lineComponents[0].element).toBe(retired.element);
      expect(() => tile.update(props([line("new one")]))).not.toThrow();
      expect(neighbor.lineComponents[0].element.parentNode).toBe(neighbor.element);
      expect(neighbor.element.textContent).toBe("neighbor");
      expect(tile.element.textContent).toBe("new one");
    } finally {
      neighbor.destroy();
    }
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

  for (const change of ["screen line", "descriptor", "screen line and descriptor"]) {
    it(`preserves a live block's scroll, focus and connection through ${change} replacement`, () => {
      const first = line("old one");
      const next = change.includes("screen line") ? line("new one") : first;
      const { item, input } = scrollableBlock();
      const decoration = { position: "after", item };
      const replacement = change.includes("descriptor") ? { ...decoration } : decoration;
      tile = new LinesTileComponent(
        props([first], { blockDecorations: new Map([[first.id, [decoration]]]) }),
      );
      jasmine.attachToDOM(tile.element);
      input.focus({ preventScroll: true });
      item.scrollTo({ left: 200, top: 200, behavior: "instant" });
      expect(document.activeElement).toBe(input);
      expect(item.scrollLeft).toBe(200);
      expect(item.scrollTop).toBe(200);
      tile.update(props([next], { blockDecorations: new Map([[next.id, [replacement]]]) }));
      expect(item.scrollLeft).toBe(200);
      expect(item.scrollTop).toBe(200);
      expect(document.activeElement).toBe(input);
      expect(item.disconnects || 0).toBe(0);
      expect(item.parentNode).toBe(tile.element);
      expect(item.previousSibling).toBe(tile.lineComponents[0].element);
    });
  }

  it("removes a block whose resolved item is no longer present", () => {
    const first = line("old one");
    const { item } = scrollableBlock();
    tile = new LinesTileComponent(
      props([first], {
        blockDecorations: new Map([[first.id, [{ position: "after", item }]]]),
      }),
    );
    jasmine.attachToDOM(tile.element);
    tile.update(props([first], { blockDecorations: new Map() }));
    expect(item.isConnected).toBeFalse();
    expect(item.parentNode).toBeNull();
    expect(item.disconnects).toBe(1);
    expect(tile.element.childNodes.length).toBe(1);
  });

  it("reorders retained blocks before and after a replacement row without disconnecting them", () => {
    const first = line("old one");
    const next = line("new one");
    const blocks = [scrollableBlock(), scrollableBlock(), scrollableBlock()];
    const [before, after, moved] = blocks.map(({ item }) => item);
    tile = new LinesTileComponent(
      props([first], {
        blockDecorations: new Map([
          [
            first.id,
            [
              { position: "before", item: before },
              { position: "after", item: after },
              { position: "after", item: moved },
            ],
          ],
        ]),
      }),
    );
    jasmine.attachToDOM(tile.element);
    tile.update(
      props([next], {
        blockDecorations: new Map([
          [
            next.id,
            [
              { position: "before", item: moved },
              { position: "before", item: before },
              { position: "after", item: after },
            ],
          ],
        ]),
      }),
    );
    expect([...tile.element.children]).toEqual([
      moved,
      before,
      tile.lineComponents[0].element,
      after,
    ]);
    for (const { item } of blocks) expect(item.disconnects || 0).toBe(0);
  });

  it("does not move already ordered blocks when only their descriptors are replaced", () => {
    const first = line("old one");
    const blocks = [scrollableBlock(), scrollableBlock(), scrollableBlock()];
    const decorations = blocks.map(({ item }, index) => ({
      position: index < 2 ? "before" : "after",
      item,
    }));
    tile = new LinesTileComponent(
      props([first], { blockDecorations: new Map([[first.id, decorations]]) }),
    );
    jasmine.attachToDOM(tile.element);
    tile.update(
      props([first], {
        blockDecorations: new Map([
          [first.id, decorations.map((decoration) => ({ ...decoration }))],
        ]),
      }),
    );
    for (const { item } of blocks) {
      expect(item.moves || 0).toBe(0);
      expect(item.disconnects || 0).toBe(0);
    }
  });

  it("uses its local row anchor for a retained block when a neighbor replaced the shared lookup", () => {
    const retained = line("retained row");
    const { item, input } = scrollableBlock();
    const decoration = { position: "before", item };
    const shared = props([retained], {
      blockDecorations: new Map([[retained.id, [decoration]]]),
    });
    tile = new LinesTileComponent(shared);
    jasmine.attachToDOM(tile.element);
    const neighbor = new LinesTileComponent({
      ...shared,
      screenLines: [line("old neighbor")],
      blockDecorations: undefined,
    });
    jasmine.attachToDOM(neighbor.element);
    try {
      neighbor.update({ ...shared, blockDecorations: undefined });
      expect(shared.lineComponentsByScreenLineId.get(retained.id).element.parentNode).toBe(
        neighbor.element,
      );
      input.focus({ preventScroll: true });
      item.scrollTo({ left: 200, top: 200, behavior: "instant" });
      expect(() => tile.update({ ...shared, height: 80 })).not.toThrow();
      expect(item.nextSibling).toBe(tile.lineComponents[0].element);
      expect(item.scrollLeft).toBe(200);
      expect(item.scrollTop).toBe(200);
      expect(document.activeElement).toBe(input);
      expect(item.disconnects || 0).toBe(0);
      expect(neighbor.lineComponents[0].element.parentNode).toBe(neighbor.element);
    } finally {
      neighbor.destroy();
    }
  });
});
