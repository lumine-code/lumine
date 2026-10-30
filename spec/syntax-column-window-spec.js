const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const { Point } = require("../src/text-buffer");

describe("Viewport column syntax", () => {
  for (const wrapped of [false, true])
    it(`prepares exact distant columns and recolors them after editing (wrapped=${wrapped})`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-javascript");
      const service = new Service(lumine.grammars),
        editor = lumine.workspace.buildTextEditor({ softWrapped: false, autoHeight: false });
      const fragment = 'const value = "text"; ';
      editor.setText(fragment.repeat(18000));
      const mode = new WorkerMode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("source.js"),
        service,
      });
      editor.getBuffer().setLanguageMode(mode);
      const element = editor.element;
      element.style.cssText = "width:800px;height:200px";
      try {
        await mode.ready;
        editor.update({ softWrapped: wrapped, maxScreenLineLength: Infinity });
        jasmine.attachToDOM(element);
        element.setUpdatedSynchronously(true);
        const c = element.component;
        c.updateSync();
        if (wrapped) {
          const screenRow = editor.screenPositionForBufferPosition([0, 200000]).row;
          c.didScrollScrollbar({
            orientation: "vertical",
            position: screenRow * c.getLineHeight(),
          });
          await mode.refresh();
          c.scrollPresentation.flush();
        } else {
          c.didScrollScrollbar({
            orientation: "horizontal",
            position: 200000 * c.getBaseCharacterWidth(),
          });
          expect(c.getScrollLeft()).toBe(0);
          await mode.refresh();
          c.horizontalScrollPresentation.flush();
        }
        c.updateSync();
        let line = wrapped
          ? c.renderedScreenLines[0]
          : c.renderedScreenLines.find((l) => l.startScreenColumn > 100000);
        expect(line).toBeDefined();
        const start = wrapped
          ? editor.bufferPositionForScreenPosition([c.renderedScreenLinesStartRow, 0])
          : new Point(0, line.startScreenColumn);
        expect(start.column).toBeGreaterThan(100000);
        expect(
          mode.cache.covers(
            start,
            new Point(0, start.column + line.lineText.length),
            null,
            (s) => s.bounded !== false,
          ),
        ).toBeTrue();
        const first = Math.ceil(start.column / fragment.length) * fragment.length;
        expect(mode.scopeDescriptorForPosition([0, first + 1]).scopes).toContain(
          "storage.type.const.js",
        );
        expect(
          mode.scopeDescriptorForPosition([0, first + fragment.indexOf("text") + 1]).scopes,
        ).toContain("string.quoted.double.js");
        editor.getBuffer().transact(() => {
          editor.getBuffer().insert(editor.getBuffer().getEndPosition(), "*/");
          editor.getBuffer().insert([0, 0], "/*");
        });
        await mode.atGrammarSettlement();
        await mode.refresh();
        c.updateSync();
        line = wrapped
          ? c.renderedScreenLines[0]
          : c.renderedScreenLines.find((l) => l.startScreenColumn > 100000);
        expect(
          line.tags.some(
            (t) => t < 0 && editor.displayLayer.classNameForTag(t)?.includes("syntax--comment"),
          ),
        ).toBeTrue();
        editor.undo();
        await mode.atGrammarSettlement();
        await mode.refresh();
        c.updateSync();
        line = wrapped
          ? c.renderedScreenLines[0]
          : c.renderedScreenLines.find((l) => l.startScreenColumn > 100000);
        expect(
          line.tags.some(
            (t) => t < 0 && editor.displayLayer.classNameForTag(t)?.includes("syntax--string"),
          ),
        ).toBeTrue();
      } finally {
        editor.destroy();
        element.remove();
        await service.dispose();
      }
    }, 15000);
});
