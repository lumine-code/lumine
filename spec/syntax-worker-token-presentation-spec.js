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
