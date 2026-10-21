const LineComponent = require("../src/line-component");
const NodePool = require("../src/node-pool");

describe("LineComponent token markup", () => {
  const components = [];
  let id = 0;
  afterEach(() => {
    for (const component of components.splice(0)) component.destroy();
  });
  function build(lineText, tags = [-1, -3, 4, -4, 1, -5, lineText.length - 5, -6, -2]) {
    const component = new LineComponent({
      screenRow: 0,
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
});
