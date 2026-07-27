// The icon geometry contract (static/atom-ui/styles/icons.css): every icon is
// a fixed square of --component-icon-size whose line-height equals its height,
// pinned with vertical-align: text-bottom. Core owns the box, icon sets own
// ink, themes own row metrics only. These specs pin the box in the base sheet
// and prove a bundled theme no longer contests it per surface.

function probe(classNames, { context } = {}) {
  const element = document.createElement("span");
  element.className = classNames;
  let root = element;
  if (context) {
    root = document.createElement("div");
    let parent = root;
    for (const contextClasses of context) {
      const child = document.createElement(contextClasses.tag || "div");
      child.className = contextClasses.classes;
      parent.appendChild(child);
      parent = child;
    }
    parent.appendChild(element);
  }
  jasmine.attachToDOM(root);
  return element;
}

function beforeStyle(element) {
  return getComputedStyle(element, "::before");
}

function expectContractBox(style, size = "16px") {
  expect(style.display).toBe("inline-block");
  expect(style.width).toBe(size);
  expect(style.height).toBe(size);
  expect(style.lineHeight).toBe(size);
  expect(style.fontSize).toBe(size);
  expect(style.textAlign).toBe("center");
  expect(style.verticalAlign).toBe("text-bottom");
}

describe("icon geometry contract", () => {
  it("declares the contract version token on the root element", () => {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--icon-contract")
      .trim();
    expect(token).toBe("box");
  });

  it("gives a bare icon the full contract box", () => {
    const style = beforeStyle(probe("icon icon-file-text"));
    expectContractBox(style);
    expect(style.marginRight).toBe("5px");
    // The old baseline-era nudge is gone.
    expect(style.top).toBe("auto");
  });

  it("wins the source-order tie against the octicon glyph rules", () => {
    // octicons.css keeps self-contained geometry for icon-* classes used
    // without .icon; the contract, later in the base sheet at the same
    // specificity, must take every shared property when .icon is present.
    const style = beforeStyle(probe("icon icon-file-directory"));
    expectContractBox(style);
    expect(style.fontFamily).toContain("Octicons Regular");
  });

  it("keeps the same box inside a list row", () => {
    const style = beforeStyle(
      probe("name icon icon-file-text", {
        context: [
          { classes: "list-tree has-collapsable-children", tag: "ol" },
          { classes: "list-item", tag: "li" },
        ],
      }),
    );
    expectContractBox(style);
  });

  it("sizes the disclosure arrow as a 12px glyph on the 16px carrier", () => {
    const item = probe("list-item", {
      context: [{ classes: "list-tree has-collapsable-children", tag: "ol" }],
    });
    const li = document.createElement("li");
    li.className = "list-nested-item";
    item.parentElement.insertBefore(li, item);
    li.appendChild(item);
    const style = beforeStyle(item);
    expect(style.fontSize).toBe("12px");
    expect(style.width).toBe("12px");
    expect(style.height).toBe("16px");
    expect(style.lineHeight).toBe("16px");
    expect(style.verticalAlign).toBe("text-bottom");
    expect(style.top).toBe("auto");
  });

  it("centers the image variant with the same alignment", () => {
    const element = probe("icon icon-image");
    element.style.setProperty("--icon-image", "none");
    const style = beforeStyle(element);
    expect(style.verticalAlign).toBe("text-bottom");
    expect(style.width).toBe("16px");
    expect(style.height).toBe("16px");
  });

  describe("with a bundled UI theme active", () => {
    beforeEach(async () => {
      jasmine.useRealClock();
      spyOn(atom, "inSpecMode").and.returnValue(false);
      atom.packages.loadPackage("one-theme");
      atom.themes.systemThemeQuery = { matches: true, addEventListener() {} };
      atom.config.set("theme.light", ["one-night-ui", "one-night-syntax"]);
      atom.config.set("theme.dark", ["one-night-ui", "one-night-syntax"]);
      await atom.themes.activateThemes();
    });

    afterEach(async () => {
      await atom.themes.deactivateThemes();
    });

    it("keeps the contract box in tree-view rows", () => {
      const style = beforeStyle(
        probe("name icon icon-file-text", {
          context: [
            { classes: "tool-panel tree-view" },
            { classes: "list-tree has-collapsable-children", tag: "ol" },
            { classes: "file entry list-item", tag: "li" },
          ],
        }),
      );
      expectContractBox(style);
    });

    it("keeps the contract box in tab titles", () => {
      const style = beforeStyle(
        probe("title icon icon-file-text", {
          context: [
            { classes: "tab-bar", tag: "ul" },
            { classes: "tab", tag: "li" },
          ],
        }),
      );
      expectContractBox(style);
      // The old per-surface shrink (font-size: 1.125em) must not return.
      expect(style.fontSize).toBe("16px");
    });
  });
});
