const LineComponent = require("../src/line-component");
const NodePool = require("../src/node-pool");

describe("LineComponent token markup", () => {
  const components = [];
  let id = 0;
  afterEach(() => {
    for (const component of components.splice(0)) component.destroy();
  });
  function build(
    lineText,
    tags = [-1, -3, 4, -4, 1, -5, lineText.length - 5, -6, -2],
    textDecorations,
  ) {
    const component = new LineComponent({
      screenRow: 0,
      textDecorations,
      screenLine: { id: ++id, lineText, tags },
      nodePool: new NodePool(),
      lineComponentsByScreenLineId: new Map(),
      horizontalPixelPositionsByScreenLineId: new Map(),
      displayLayer: {
        foldCharacter: "\u2026",
        isOpenTag: (tag) => tag < 0 && tag % 2 === -1,
        isCloseTag: (tag) => tag < 0 && tag % 2 === 0,
        classNameForTag: (tag) =>
          ({
            [-1]: "syntax--source syntax--js",
            [-3]: "syntax--keyword",
            [-5]: 'syntax--string quote" amp& less<',
          })[tag],
      },
    });
    components.push(component);
    return component;
  }
  for (const text of [
    'const value = "<img src=x onerror=alert(1)> & \\"";',
    "const value = '\r\t😀אבג e\u0301';",
    "const value = '\ud800\udfff\ud800X\udfff\u0001\u000b\u000c';",
    "const value = '\0';",
    "const value = 'fold'\u2026",
  ]) {
    it(`preserves text and scope structure for ${JSON.stringify(text)}`, () => {
      const fast = build(text),
        pooled = build(text);
      pooled.element.replaceChildren();
      pooled.unpooledContents = false;
      pooled.appendPooledContents();
      expect(fast.element.textContent).toBe(pooled.element.textContent);
      expect(fast.textNodes.map((node) => node.data).join("")).toBe(
        pooled.textNodes.map((node) => node.data).join(""),
      );
      expect([...fast.element.querySelectorAll("span")].map((node) => node.className)).toEqual(
        [...pooled.element.querySelectorAll("span")].map((node) => node.className),
      );
      expect(fast.element.querySelector("img,script,[onerror]")).toBeNull();
      expect(fast.unpooledContents).toBe(!text.includes("\0"));
    });
  }
  it("keeps the node pool bounded when token markup bypasses it", () => {
    const component = build("const value = 123;");
    const pool = component.props.nodePool;
    component.destroy();
    components.pop();
    expect(pool.textNodes.length).toBe(0);
    expect(pool.elementsByType.SPAN).toBeUndefined();
    expect(pool.elementsByType.DIV[0][0].childNodes.length).toBe(0);
  });

  it("escapes scope classes and follows changed class mappings when rebuilding markup", () => {
    const component = build("const value = 123;");
    const unsafe = 'syntax--keyword" data-injected="yes';
    component.props.displayLayer.classNameForTag = () => unsafe;
    component.appendHTMLContents();
    expect(component.element.querySelector("[data-injected]")).toBeNull();
    expect(component.element.querySelector("span[class]").className).toBe(unsafe);
    component.props.displayLayer.classNameForTag = () => "syntax--changed";
    component.appendHTMLContents();
    expect(component.element.querySelector("span[class]").className).toBe("syntax--changed");
    expect(component.element.textContent).toBe("const value = 123;");
  });

  it("collects HTML text nodes only when a measurement first requests them", () => {
    const walk = spyOn(document, "createTreeWalker").and.callThrough();
    const component = build("const value = 123;");
    expect(walk).not.toHaveBeenCalled();
    const nodes = component.textNodes;
    expect(nodes.map((node) => node.data).join("")).toBe("const value = 123;");
    expect(walk).toHaveBeenCalledTimes(1);
    expect(component.textNodes).toBe(nodes);
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("keeps an exposed text-node array current through HTML and decorated rebuilds", () => {
    const component = build("const value = 123;");
    const nodes = component.textNodes;
    const originalNodes = [...nodes];
    component.update({
      screenRow: 0,
      textDecorations: [{ column: 0, className: "marked" }, { column: 2 }],
    });
    expect(component.textNodes).toBe(nodes);
    expect(nodes.every((node) => component.element.contains(node))).toBeTrue();
    expect(originalNodes.some((node) => nodes.includes(node))).toBeFalse();
    component.update({ screenRow: 0, textDecorations: [] });
    expect(component.textNodes).toBe(nodes);
    expect(nodes.map((node) => node.data).join("")).toBe("const value = 123;");
    expect(nodes.every((node) => component.element.contains(node))).toBeTrue();
  });

  it("retains a caller-supplied text-node array when rebuilding HTML", () => {
    const component = build("const value = 123;");
    const nodes = [];
    component.textNodes = nodes;
    component.appendHTMLContents();
    expect(component.textNodes).toBe(nodes);
    expect(nodes.map((node) => node.data).join("")).toBe("const value = 123;");
  });
  it("preserves deeply nested scopes beyond the HTML parser depth limit", () => {
    const component = build("x", [...new Array(600).fill(-1), 1, ...new Array(600).fill(-2)]);
    expect(component.unpooledContents).toBeFalse();
    let node = component.textNodes[0],
      depth = 0;
    while (node.parentElement !== component.element) {
      node = node.parentElement;
      depth++;
    }
    expect(depth).toBe(601);
    expect(component.element.textContent).toBe("x");
  });
  it("switches safely between token markup and styled text decorations", () => {
    const component = build("const value = 123;");
    const update = (textDecorations) => component.update({ screenRow: 0, textDecorations });
    update([{ column: 0, className: "marked", style: { color: "red" } }, { column: 2 }]);
    expect(component.unpooledContents).toBeFalse();
    expect(component.element.querySelector(".marked").textContent).toBe("co");
    expect(component.element.querySelector(".marked").style.color).toBe("red");
    update([]);
    expect(component.unpooledContents).toBeTrue();
    expect(component.element.querySelector(".marked")).toBeNull();
    expect(component.element.textContent).toBe("const value = 123;");
  });
  describe("class-only decoration markup", () => {
    const text = "const value = '😀<&\r';";
    const cases = [
      {
        name: "inside one token",
        decorations: [{ column: 1, className: "marked" }, { column: 3 }],
      },
      {
        name: "across nested scope boundaries",
        decorations: [{ column: 0, className: "marked outer" }, { column: 7 }],
      },
      {
        name: "at token boundaries",
        decorations: [
          { column: 4, className: "marked" },
          { column: 5 },
          { column: 6, className: "second" },
        ],
      },
      {
        name: "escaped classes",
        decorations: [{ column: 0, className: 'marked" data-injected="yes <&' }, { column: 2 }],
      },
      { name: "at end of line", decorations: [{ column: text.length, className: "marked" }] },
      {
        name: "empty class transitions",
        decorations: [{ column: 0 }, { column: 2, className: "" }, { column: 6 }],
      },
    ];
    function compare(fast, pooled) {
      pooled.element.replaceChildren();
      pooled.unpooledContents = false;
      pooled.appendPooledContents();
      expect(fast.element.innerHTML).toBe(pooled.element.innerHTML);
      expect(fast.textNodes.map((node) => node.data).join("")).toBe(
        pooled.textNodes.map((node) => node.data).join(""),
      );
      expect(fast.element.querySelector("[data-injected],script,img")).toBeNull();
    }
    for (const { name, decorations } of cases) {
      it("matches pooled scope and decoration ancestry " + name, () => {
        const fast = build(text, undefined, decorations);
        compare(fast, build(text, undefined, decorations));
        expect(fast.unpooledContents).toBeTrue();
      });
    }
    it("preserves root-level empty-line and fold measurement placeholders", () => {
      for (const [line, tags] of [
        ["", [-1, -3, 0, -4, -5, 0, -6, -2]],
        ["const value…", undefined],
      ]) {
        const decorations = [{ column: 0, className: "marked" }];
        const fast = build(line, tags, decorations);
        compare(fast, build(line, tags, decorations));
        expect(fast.unpooledContents).toBeTrue();
      }
    });
    it("retains empty decorated Text nodes by falling back for duplicate boundaries", () => {
      const decorations = [
        { column: 0, className: "first" },
        { column: 0, className: "second" },
        { column: 4 },
      ];
      const component = build(text, undefined, decorations);
      expect(component.unpooledContents).toBeFalse();
      expect(component.element.querySelector(".first").firstChild.nodeType).toBe(Node.TEXT_NODE);
      expect(component.element.querySelector(".first").firstChild.data).toBe("");
      compare(component, build(text, undefined, decorations));
    });
    it("keeps arbitrary styles and custom properties on the existing pooled path", () => {
      const decorations = [
        { column: 0, className: "marked" },
        { column: 2, style: { "--value": "red", fontWeight: "bold" } },
        { column: 7 },
      ];
      const fast = build(text, undefined, decorations);
      expect(fast.unpooledContents).toBeFalse();
      compare(fast, build(text, undefined, decorations));
      expect(fast.element.querySelector("[style]").style.getPropertyValue("--value")).toBe("red");
    });
    it("preserves NUL in decoration classes on the existing DOM path", () => {
      const className = "marked\0tail";
      const decorations = [{ column: 0, className }, { column: 2 }];
      const component = build(text, undefined, decorations);
      expect(component.unpooledContents).toBeFalse();
      compare(component, build(text, undefined, decorations));
      const decorated = [...component.element.querySelectorAll("span")].find((node) =>
        node.className.includes("marked"),
      );
      expect(decorated.className).toBe(className);
    });
    it("switches between class-only HTML and styled DOM without retaining old nodes", () => {
      const component = build(text, undefined, [{ column: 0, className: "first" }]);
      const nodes = component.textNodes;
      component.update({ screenRow: 0, textDecorations: [{ column: 0, style: { color: "red" } }] });
      expect(component.unpooledContents).toBeFalse();
      expect(component.textNodes).toBe(nodes);
      component.update({
        screenRow: 0,
        textDecorations: [{ column: 0, className: "second" }, { column: 3 }],
      });
      expect(component.unpooledContents).toBeTrue();
      expect(component.textNodes).toBe(nodes);
      expect(component.element.querySelector(".first,[style]")).toBeNull();
      expect(nodes.every((node) => component.element.contains(node))).toBeTrue();
      expect(nodes.map((node) => node.data).join("")).toBe(text);
    });
    it("releases HTML decoration descendants rather than adding them to the node pool", () => {
      const component = build(text, undefined, [{ column: 0, className: "marked" }]);
      const pool = component.props.nodePool;
      component.destroy();
      components.pop();
      expect(pool.textNodes).toEqual([]);
      expect(pool.elementsByType.SPAN).toBeUndefined();
      expect(pool.elementsByType.DIV[0][0].childNodes.length).toBe(0);
    });
  });
});
