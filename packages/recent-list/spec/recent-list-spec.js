const path = require("path");
const main = require("../lib/main");

describe("recent-list", () => {
  let view, list;

  beforeEach(() => {
    main.activate();
    view = main.recentList;
  });

  afterEach(() => {
    if (list) list.destroy();
    list = null;
    main.deactivate();
  });

  // The package computes its own match indices in filter(), so the row renderer
  // passes them to highlight explicitly rather than letting it use the built-in
  // matcher's. Render through a real list to prove that path end to end.
  function renderRow(item) {
    list = atom.workspace.buildSelectList({
      items: [item],
      filterKeyForItem: (i) => i.paths[0],
      elementForItem: (i, options) => view.elementForItem(i, options),
    });
    return list.element.querySelector("li");
  }

  describe("elementForItem", () => {
    it("renders one line per project path", () => {
      const row = renderRow({
        paths: ["one" + path.sep, "two" + path.sep, "three" + path.sep],
        ibest: 0,
        matchIndices: [],
      });

      const lines = row.querySelectorAll(".primary-line");
      expect(lines.length).toBe(3);
      expect(lines[0].textContent).toBe("one" + path.sep);
      // Only the lines after the first carry the continuation class.
      expect(lines[0].classList.contains("icon-line")).toBe(false);
      expect(lines[1].classList.contains("icon-line")).toBe(true);
    });

    it("highlights only the best-matching line, using the package's own indices", () => {
      const row = renderRow({
        paths: ["one" + path.sep, "two" + path.sep],
        ibest: 1,
        matchIndices: [0, 1, 2],
      });

      const lines = row.querySelectorAll(".primary-line");
      expect(lines[0].querySelectorAll(".character-match").length).toBe(0);

      const matched = lines[1].querySelectorAll(".character-match");
      expect(matched.length).toBe(1);
      expect(matched[0].textContent).toBe("two");
    });

    it("renders plain text when there is nothing matched", () => {
      const row = renderRow({
        paths: ["one" + path.sep],
        ibest: 0,
        matchIndices: [],
      });

      expect(row.querySelectorAll(".character-match").length).toBe(0);
      expect(row.querySelector(".primary-line").textContent).toBe("one" + path.sep);
    });
  });

  describe("filter", () => {
    it("matches accent-insensitively through atom.tools", () => {
      // The package folds both sides itself; this is the call the port moved
      // from the select-list export onto atom.tools.
      expect(atom.tools.removeDiacritics("Łódź")).toBe("Lodz");
      expect(atom.tools.removeDiacritics("café")).toBe("cafe");
    });
  });
});
