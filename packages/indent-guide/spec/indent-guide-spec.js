const { getGuides, toGuides, uniq } = require("../lib/guides");

describe("indent-guide", () => {
  describe("guide computation", () => {
    function indentFnFor(indents) {
      return (row) => (row < indents.length ? indents[row] : null);
    }

    function computeGuides(indents, cursorPositions = []) {
      return getGuides(
        0,
        indents.length,
        indents.length - 1,
        cursorPositions,
        indentFnFor(indents),
      );
    }

    it("creates one guide per indented block", () => {
      const guides = computeGuides([0, 1, 1, 0]);
      expect(guides.length).toBe(1);
      expect(guides[0].point.row).toBe(1);
      expect(guides[0].point.column).toBe(0);
      expect(guides[0].length).toBe(2);
    });

    it("nests guides for deeper indentation levels", () => {
      const guides = computeGuides([0, 1, 2, 1, 0]);
      expect(guides.length).toBe(2);

      const outer = guides.find((g) => g.point.column === 0);
      expect(outer.point.row).toBe(1);
      expect(outer.length).toBe(3);

      const inner = guides.find((g) => g.point.column === 1);
      expect(inner.point.row).toBe(2);
      expect(inner.length).toBe(1);
    });

    it("extends guides across whitespace-only lines using the surrounding indentation", () => {
      // Row 2 is blank (null indent) between two indented rows.
      const guides = computeGuides([0, 1, null, 1, 0]);
      expect(guides.length).toBe(1);
      expect(guides[0].point.row).toBe(1);
      expect(guides[0].length).toBe(3);
    });

    it("marks the guide containing the cursor as active", () => {
      const guides = computeGuides([0, 1, 2, 1, 0], [{ row: 2, level: 1 }]);
      const inner = guides.find((g) => g.point.column === 1);
      const outer = guides.find((g) => g.point.column === 0);
      expect(inner.active).toBe(true);
      expect(outer.active).toBe(false);
    });

    it("marks the deepest guide as active when the cursor level is unbounded", () => {
      const guides = computeGuides([0, 1, 2, 1, 0], [{ row: 2, level: Infinity }]);
      const inner = guides.find((g) => g.point.column === 1);
      expect(inner.active).toBe(true);
    });

    it("flags the guide stack that contains a cursor", () => {
      const guides = computeGuides([0, 1, 2, 1, 0], [{ row: 2, level: 0 }]);
      expect(guides.every((g) => g.stack)).toBe(true);
    });

    it("returns no guides for flat text", () => {
      expect(computeGuides([0, 0, 0])).toEqual([]);
    });
  });

  describe("toGuides", () => {
    it("floors fractional indentation levels", () => {
      const guides = toGuides([0, 1.5, 1.5, 0], []);
      expect(guides.length).toBe(1);
      expect(guides[0].length).toBe(2);
    });
  });

  describe("uniq", () => {
    it("collapses consecutive duplicates", () => {
      expect(uniq([1, 1, 2, 2, 3, 1])).toEqual([1, 2, 3, 1]);
      expect(uniq([])).toEqual([]);
    });
  });

  describe("package integration", () => {
    let workspaceElement, mainModule;

    // The runner stubs setTimeout, so poll on animation frames instead.
    async function waitUntil(condition, frames = 600) {
      for (let i = 0; i < frames; i++) {
        if (condition()) return;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error("Timed out waiting for condition");
    }

    async function renderGuides(editor, editorElement) {
      // The component measures asynchronously; keep updating until guides land.
      await waitUntil(() => {
        mainModule.updateGuide(editor, editorElement);
        return editorElement.querySelector(".indent-guide-layer indent-guide");
      });
    }

    beforeEach(async () => {
      workspaceElement = atom.views.getView(atom.workspace);
      jasmine.attachToDOM(workspaceElement);
      const pack = await atom.packages.activatePackage("indent-guide");
      mainModule = pack.mainModule;
    });

    it("registers the toggle command", () => {
      const commands = atom.commands
        .findCommands({ target: workspaceElement })
        .map((command) => command.name);
      expect(commands).toContain("indent-guide:toggle-cursor-aware-active");
    });

    it("renders guide elements for an indented buffer", async () => {
      const editor = await atom.workspace.open();
      editor.setText("a\n  b\n    c\n  d\ne\n");
      const editorElement = atom.views.getView(editor);
      await renderGuides(editor, editorElement);

      const layer = editorElement.querySelector(".indent-guide-layer");
      expect(layer).not.toBeNull();
      expect(layer.querySelectorAll("indent-guide.indent-guide").length).toBeGreaterThan(0);
    });

    it("renders guides above selections", async () => {
      const editor = await atom.workspace.open();
      editor.setText("a\n  b\n");
      editor.setSelectedBufferRange([
        [0, 0],
        [1, 3],
      ]);
      const editorElement = atom.views.getView(editor);
      await renderGuides(editor, editorElement);

      const highlights = editorElement.querySelector(".scroll-view .lines > .highlights");
      const selection = highlights.querySelector(".selection .region");
      const layer = editorElement.querySelector(".indent-guide-layer");
      const guide = editorElement.querySelector(".indent-guide-layer indent-guide");
      expect(selection).not.toBeNull();
      expect(layer.parentElement).toBe(highlights);
      expect(getComputedStyle(guide).zIndex).toBe("1");
    });

    it("keeps block decorations above guides", async () => {
      const editor = await atom.workspace.open();
      editor.setText("a\n  b\n");
      const marker = editor.markBufferPosition([0, Infinity]);
      const item = document.createElement("div");
      item.className = "inline-result";
      editor.decorateMarker(marker, {
        type: "block",
        item,
        position: "after",
      });
      const editorElement = atom.views.getView(editor);

      await waitUntil(() => {
        mainModule.updateGuide(editor, editorElement);
        return item.isConnected && editorElement.querySelector(".indent-guide-layer indent-guide");
      });

      const highlights = editorElement.querySelector(".scroll-view .lines > .highlights");
      const layer = editorElement.querySelector(".indent-guide-layer");
      expect(layer.parentElement).toBe(highlights);
      expect(highlights.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
    });

    it("removes guide layers on deactivation", async () => {
      const editor = await atom.workspace.open();
      editor.setText("a\n  b\n");
      const editorElement = atom.views.getView(editor);
      await renderGuides(editor, editorElement);

      await atom.packages.deactivatePackage("indent-guide");
      expect(editorElement.querySelector(".indent-guide-layer")).toBeNull();
      expect(editorElement.querySelector(".indent-guide")).toBeNull();
    });
  });
});
