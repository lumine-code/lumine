const { normalizeTreeSitterTextData } = require("./helpers/normalize-comments");

describe("Tree-sitter fixture assertions", () => {
  let editor;
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-python");
    editor = await lumine.workspace.open();
    editor.setText(
      [
        'text = "# <- not an assertion"',
        "value = 42",
        "# <- variable.other.assignment.python",
        "#       ^ constant.numeric.integer.python",
      ].join("\n"),
    );
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python");
    await editor.whenGrammarSettled();
  });
  afterEach(() => editor?.destroy());

  it("reads buffer syntax without depending on rendered tokens", () => {
    spyOn(editor, "tokensForScreenRow").and.throwError("Presentation is not ready");
    expect(normalizeTreeSitterTextData(editor, /#/)).toEqual([
      {
        expected: "variable.other.assignment.python",
        editorPosition: { row: 1, column: 0 },
        testPosition: { row: 2, column: 0 },
      },
      {
        expected: "constant.numeric.integer.python",
        editorPosition: { row: 1, column: 8 },
        testPosition: { row: 3, column: 0 },
      },
    ]);
    expect(editor.tokensForScreenRow).not.toHaveBeenCalled();
  });
});
