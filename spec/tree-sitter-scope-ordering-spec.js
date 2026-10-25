const { Point } = require("../src/text-buffer");
const InlineMode = require("../src/tree-sitter-language-mode");

describe("Tree-sitter scope ordering across seeks", () => {
  let editor;

  beforeEach(async () => {
    await lumine.packages.activatePackage("language-html");
    await lumine.packages.activatePackage("language-php");
    editor = await lumine.workspace.open();
  });

  afterEach(() => editor?.destroy());

  async function setUp(text) {
    editor.setText(text);
    editor.getBuffer().setLanguageMode(
      new InlineMode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("text.html.php"),
        grammars: lumine.grammars,
        config: lumine.config,
      }),
    );
    await editor.whenGrammarSettled();
    return editor.getBuffer().getLanguageMode();
  }

  function scopesAt(mode, start, target) {
    const iterator = mode.buildHighlightIterator();
    const scopes = iterator.seek(start, editor.getLastBufferRow());
    while (iterator.getPosition().compare(target) <= 0) {
      for (const id of iterator.getCloseScopeIds()) {
        const index = scopes.lastIndexOf(id);
        if (index !== -1) scopes.splice(index, 1);
      }
      scopes.push(...iterator.getOpenScopeIds());
      iterator.moveToSuccessor();
    }
    return scopes.map((id) => mode.scopeNameForScopeId(id));
  }

  it("keeps multiple injection base scopes in streaming order when seeking inside the range", async () => {
    const mode = await setUp("<?php\n\necho 'text';\n?>\n<div>done</div>");
    const target = new Point(2, 7);
    const streamed = scopesAt(mode, Point.ZERO, target);
    expect(streamed).toEqual([
      "text.html.php",
      "meta.embedded.block.php",
      "source.php",
      "string.quoted.single.php",
    ]);
    expect(scopesAt(mode, new Point(2, 0), target)).toEqual(streamed);
    expect(scopesAt(mode, target, target)).toEqual(streamed);
  });

  it("keeps the same order after editing and does not retain injection scopes beyond their range", async () => {
    const mode = await setUp("<?php\n\necho 'text';\n?>\n<div>done</div>");
    editor.setCursorBufferPosition([2, 7]);
    editor.insertText("x", { autoIndent: false });
    await editor.whenGrammarSettled();
    const target = new Point(2, 8);
    const streamed = scopesAt(mode, Point.ZERO, target);
    expect(scopesAt(mode, new Point(2, 0), target)).toEqual(streamed);
    expect(scopesAt(mode, target, target)).toEqual(streamed);
    const html = new Point(4, 6);
    expect(scopesAt(mode, html, html)).toEqual(scopesAt(mode, Point.ZERO, html));
    expect(scopesAt(mode, Point.ZERO, html)).not.toContain("source.php");
    expect(scopesAt(mode, Point.ZERO, html)).not.toContain("meta.embedded.block.php");
  });
});
