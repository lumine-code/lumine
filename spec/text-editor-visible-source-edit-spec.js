const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

describe("Prepared edits in a visible large document", () => {
  let editor, component;
  afterEach(() => {
    editor?.destroy();
    component?.element.remove();
  });

  const cases = [
    {
      name: "content spaces",
      text: " \t  alpha    beta\r\n".repeat(4200),
      expected: " \t  alpha beta\r\n".repeat(4200),
      run: (editor) => editor.collapseContentSpaces(),
    },
    {
      name: "row indentation",
      text: "  alpha\r\n\r\n beta\r\n".repeat(1400),
      expected: "    alpha\r\n\r\n   beta\r\n".repeat(1400),
      run: (editor) => editor.indentSelectedRows(),
    },
    {
      name: "row outdentation",
      text: "    alpha\r\n\r\n  beta\r\n".repeat(1400),
      expected: "  alpha\r\n\r\nbeta\r\n".repeat(1400),
      run: (editor) => editor.outdentSelectedRows(),
    },
    {
      name: "automatic indentation",
      text: "  seed\r\n" + "value\r\n".repeat(4200),
      expected: "seed\r\n" + "value\r\n".repeat(4200),
      run: (editor) => editor.autoIndentSelectedRows(),
    },
    {
      name: "line comments",
      text: "alpha\r\nbeta\r\n".repeat(2100),
      expected: "// alpha\r\n// beta\r\n".repeat(2100),
      run: (editor) =>
        editor.toggleLineCommentsInSelection({ commentStrings: { commentStartString: "//" } }),
    },
    {
      name: "line joining",
      text: Array.from({ length: 4200 }, (_, row) => `row-${row}`).join("\r\n"),
      expected: Array.from({ length: 4200 }, (_, row) => `row-${row}`).join(" "),
      run: (editor) => editor.joinLines(),
    },
    {
      name: "replace all",
      text: "alpha beta\r\n".repeat(4200),
      expected: "omega beta\r\n".repeat(4200),
      run: (editor) => editor.getBuffer().replaceAllMatches(/alpha/g, "omega"),
    },
    {
      name: "line duplication with ending normalization",
      text: ("alpha ".repeat(60) + "\r\n").repeat(3000),
      run: (editor) => {
        editor.getBuffer().setPreferredLineEnding("\n");
        return editor.duplicateLines();
      },
      get expected() {
        return this.text + this.text.replace(/\r\n/g, "\n");
      },
    },
  ];

  for (const scenario of cases) {
    it(`publishes ${scenario.name} with existing view markers and exact undo/redo`, async () => {
      editor = new TextEditor({
        autoHeight: false,
        softWrapped: false,
        softTabs: true,
        tabLength: 2,
      });
      editor.setText(scenario.text);
      component = new TextEditorComponent({ model: editor });
      component.element.style.height = "300px";
      component.element.style.width = "600px";
      jasmine.attachToDOM(component.element);
      editor.selectAll();
      component.updateSync();
      const buffer = editor.getBuffer();
      const range = editor.getSelectedBufferRange();
      const marker = editor.markBufferPosition([100, 0], { invalidate: "never" });
      editor.decorateMarker(marker, { type: "line", class: "prepared-edit-probe" });
      const markers = editor.getMarkerCount();
      buffer.clearUndoStack();

      const pending = scenario.run(editor);
      expect(typeof pending?.then).toBe("function");
      await pending;
      component.updateSync();

      expect(buffer.getText()).toBe(scenario.expected);
      expect(marker.isDestroyed()).toBe(false);
      expect(editor.getMarkerCount()).toBe(markers);
      editor.undo();
      expect(buffer.getText()).toBe(scenario.text);
      expect(editor.getSelectedBufferRange()).toEqual(range);
      expect(marker.getStartBufferPosition()).toEqual([100, 0]);
      editor.redo();
      expect(buffer.getText()).toBe(scenario.expected);
    });
  }
});
