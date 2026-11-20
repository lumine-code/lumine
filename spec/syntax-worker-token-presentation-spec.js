const Service = require("../src/syntax-worker-service");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const InlineMode = require("../src/tree-sitter-language-mode");
const cases = require("./fixtures/token-boundary-paint.json");

function scopesAt(editor, [row, column]) {
  let offset = 0;
  for (const token of editor.tokensForScreenRow(row, { highlightingOwner: editor })) {
    if (offset + token.text.length > column) return token.scopes;
    offset += token.text.length;
  }
  return [];
}

describe("Worker token boundary presentation", () => {
  beforeEach(() => jasmine.useRealClock());

  it("repaints existing text when a typed slash changes a number into a comment", async () => {
    await lumine.packages.activatePackage("language-javascript");
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const service = new Service(lumine.grammars);
    const editor = lumine.workspace.buildTextEditor({ autoIndent: false });
    editor.setText("value / 2\n");
    const mode = new WorkerMode({
      buffer: editor.getBuffer(),
      grammar: lumine.grammars.grammarForScopeName("source.js"),
      service,
    });
    editor.getBuffer().setLanguageMode(mode);
    const pane = lumine.workspace.getActivePane();
    pane.addItem(editor);
    pane.activateItem(editor);
    const frame = () => new Promise(requestAnimationFrame);
    const line = () => editor.getElement().querySelector('.line[data-screen-row="0"]');
    const paint = async () => {
      await editor.whenGrammarSettled();
      await mode.refresh();
      await frame();
    };
    const viewRequested = Promise.withResolvers();
    const releaseView = Promise.withResolvers();
    try {
      editor.setCursorBufferPosition([0, 7]);
      await frame();
      await paint();
      expect(line()?.querySelector(".syntax--constant.syntax--numeric")?.textContent).toBe("2");

      const editRevision = editor.getBuffer().getTextRevision() + 1;
      const request = service.request.bind(service);
      spyOn(service, "request").and.callFake((session, operation, data, options) => {
        if (operation !== "view" || options.revision !== editRevision)
          return request(session, operation, data, options);
        viewRequested.resolve();
        return releaseView.promise.then(() => request(session, operation, data, options));
      });
      editor.insertText("/");
      await viewRequested.promise;
      await frame();
      expect(line()?.textContent).toBe("value // 2");
      expect(line()?.querySelector(".syntax--constant.syntax--numeric")?.textContent).toBe("2");
      expect(line()?.querySelector(".syntax--comment.syntax--line")).toBeNull();

      releaseView.resolve();
      await paint();
      expect(line()?.querySelector(".syntax--comment.syntax--line")?.textContent).toContain("2");
      expect(line()?.querySelector(".syntax--constant.syntax--numeric")).toBeNull();

      editor.undo();
      await paint();
      expect(line()?.textContent).toBe("value / 2");
      expect(line()?.querySelector(".syntax--constant.syntax--numeric")?.textContent).toBe("2");
    } finally {
      releaseView.resolve();
      editor.destroy();
      await service.dispose();
    }
  });

  for (const { pack, scope, marked, insert, semanticChange } of cases) {
    it(`retains the inserted character's paint in ${scope}: ${marked} + ${JSON.stringify(insert)}`, async () => {
      await lumine.packages.activatePackage(pack);
      const service = new Service(lumine.grammars);
      const editor = lumine.workspace.buildTextEditor();
      const fresh = lumine.workspace.buildTextEditor();
      const index = marked.indexOf("|");
      const text = marked.replace("|", "");
      const expected = text.slice(0, index) + insert + text.slice(index);
      const prefix = text.slice(0, index).split(/\r?\n/);
      const position = [prefix.length - 1, prefix.at(-1).length];
      const grammar = lumine.grammars.grammarForScopeName(scope);
      editor.setText(text);
      const mode = new WorkerMode({ buffer: editor.getBuffer(), grammar, service });
      editor.getBuffer().setLanguageMode(mode);
      try {
        await editor.whenGrammarSettled();
        mode.requestHighlighting(editor, [[0, editor.getLastBufferRow()]]);
        await mode.refresh();
        editor.tokensForScreenRow(0, { highlightingOwner: editor });
        fresh.setText(expected);
        fresh.getBuffer().setLanguageMode(
          new InlineMode({
            buffer: fresh.getBuffer(),
            grammar,
            grammars: lumine.grammars,
            config: lumine.config,
          }),
        );
        await fresh.whenGrammarSettled();
        const expectedScopes = scopesAt(fresh, position);
        const refresh = spyOn(mode, "refresh").and.callFake(async () => {});
        editor.setCursorBufferPosition(position);
        editor.insertText(insert, {
          autoIndent: false,
          autoIndentNewline: false,
          autoDecreaseIndent: false,
        });
        expect(editor.getText()).toBe(expected);
        const provisional = semanticChange ? ["syntax--source syntax--python"] : expectedScopes;
        expect(scopesAt(editor, position)).toEqual(provisional);
        await new Promise(requestAnimationFrame);
        expect(scopesAt(editor, position)).toEqual(provisional);
        refresh.and.callThrough();
        await editor.whenGrammarSettled();
        await mode.refresh();
        for (let row = 0; row < editor.getLineCount(); row++)
          expect(editor.tokensForScreenRow(row)).toEqual(fresh.tokensForScreenRow(row));
        editor.undo();
        await editor.whenGrammarSettled();
        await mode.refresh();
        expect(editor.getText()).toBe(text);
      } finally {
        editor.destroy();
        fresh.destroy();
        await service.dispose();
      }
    });
  }
});
