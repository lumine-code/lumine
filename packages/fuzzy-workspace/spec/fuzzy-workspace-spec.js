const main = require("../lib/main");

describe("fuzzy-workspace", () => {
  let list;

  afterEach(() => {
    if (list) list.destroy();
    list = null;
  });

  // Render through a real list so the row is the one a user would see: the
  // package returns a descriptor and decorates the result in didRender, and
  // neither half is exercised by returning the descriptor alone.
  function renderRow(item) {
    list = atom.workspace.buildSelectList({
      items: [item],
      filterKeyForItem: (i) => i.title,
      elementForItem: (i, options) => main.elementForItem(i, options),
    });
    return list.element.querySelector("li");
  }

  describe("elementForItem", () => {
    let editor, pane;

    beforeEach(async () => {
      editor = await atom.workspace.open();
      pane = atom.workspace.getActivePane();
    });

    it("renders the title over the container as a two-line row", () => {
      const row = renderRow({
        paneItem: editor,
        pane,
        container: "Center",
        active: false,
        title: "untitled",
        uri: undefined,
      });

      expect(row.classList.contains("two-lines")).toBe(true);
      expect(row.querySelector(".primary-text").textContent).toBe("untitled");
      expect(row.querySelector(".secondary-line").textContent).toBe("Center");
    });

    it("shows the uri instead of the container when the item has one", () => {
      const row = renderRow({
        paneItem: editor,
        pane,
        container: "Center",
        active: false,
        title: "sample.js",
        uri: "/tmp/sample.js",
      });

      expect(row.querySelector(".secondary-line").textContent).toBe("/tmp/sample.js");
    });

    it("marks the active item so the theme can pick it out", () => {
      const active = renderRow({
        paneItem: editor,
        pane,
        container: "Center",
        active: true,
        title: "untitled",
      });
      expect(active.classList.contains("active-item")).toBe(true);

      const inactive = renderRow({
        paneItem: editor,
        pane,
        container: "Center",
        active: false,
        title: "untitled",
      });
      expect(inactive.classList.contains("active-item")).toBe(false);
    });

    it("applies the icon and the container key to the finished row", () => {
      const row = renderRow({
        paneItem: editor,
        pane,
        container: "Bottom Dock",
        active: false,
        title: "untitled",
      });

      // Both are done in didRender, which only runs once the row exists.
      const line = row.querySelector(".primary-line");
      expect(line.dataset.container).toBe("Bottom Dock");
      expect(line.classList.contains("icon")).toBe(true);
    });

    it("highlights the matched characters of the title", async () => {
      list = atom.workspace.buildSelectList({
        items: [{ paneItem: editor, pane, container: "Center", active: false, title: "untitled" }],
        filterKeyForItem: (i) => i.title,
        elementForItem: (i, options) => main.elementForItem(i, options),
      });

      list.refs.queryEditor.setText("unt");
      await atom.views.getNextUpdatePromise();

      const matched = list.element.querySelectorAll(".character-match");
      expect(matched.length).toBeGreaterThan(0);
      expect(matched[0].textContent).toBe("unt");
    });
  });
});
