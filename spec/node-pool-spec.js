const NodePool = require("../src/node-pool");

describe("NodePool styles", () => {
  it("resets arbitrary inline styles and custom properties before reusing a node", () => {
    const pool = new NodePool();
    const node = pool.getElement("DIV", "old", { width: "40px", "--token-color": "red" });
    node.style.setProperty("color", "blue", "important");
    node.style.marginTop = "3px";
    node.dataset.bufferRow = "12";
    node.appendChild(document.createTextNode("old"));
    pool.release(node);
    const reused = pool.getElement("DIV", "new", {
      width: "40px",
      marginTop: "5px",
      "--token-color": "green",
    });
    expect(reused).toBe(node);
    expect(reused.className).toBe("new");
    expect(reused.style.width).toBe("40px");
    expect(reused.style.marginTop).toBe("5px");
    expect(reused.style.getPropertyValue("--token-color")).toBe("green");
    expect(reused.style.color).toBe("");
    expect(reused.style.getPropertyPriority("color")).toBe("");
    expect(reused.dataset.bufferRow).toBeUndefined();
    expect(reused.childNodes.length).toBe(0);
  });

  it("clears styles for unstyled reuse without changing inherited stylesheet rules", () => {
    const pool = new NodePool();
    const style = lumine.styles.addStyleSheet(".pooled-style-test { color: rgb(1, 2, 3); }");
    const node = pool.getElement("DIV", "pooled-style-test", { color: "red", "--extra": "1" });
    pool.release(node);
    const reused = pool.getElement("DIV", "pooled-style-test", null);
    jasmine.attachToDOM(reused);
    try {
      expect(reused.style.length).toBe(0);
      expect(getComputedStyle(reused).color).toBe("rgb(1, 2, 3)");
    } finally {
      reused.remove();
      style.dispose();
    }
  });
});
