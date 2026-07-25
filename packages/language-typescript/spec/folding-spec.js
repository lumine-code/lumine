const dedent = require("dedent");

function getDisplayText(editor) {
  return editor.displayLayer.getText();
}

describe("TypeScript folding (modern Tree-sitter)", () => {
  let editor;
  let languageMode;
  let grammar;

  async function setTextAndWaitForUpdate(text) {
    editor.setText(text);
    await languageMode.atTransactionEnd();
  }

  async function expectToFoldInto(unfoldedText, foldedText, { rowNumberToFold = 0 } = {}) {
    await setTextAndWaitForUpdate(unfoldedText);
    editor.foldBufferRow(rowNumberToFold);
    expect(getDisplayText(editor)).toBe(foldedText);
  }

  beforeEach(async () => {
    atom.config.set("language.useTreeSitterParsers", true);

    editor = await atom.workspace.open();
    editor.displayLayer.reset({ foldCharacter: "…" });
    await atom.packages.activatePackage("language-typescript");
    grammar = atom.grammars.grammarForScopeName("source.ts");
    editor.setGrammar(grammar);
    languageMode = editor.languageMode;
    await languageMode.ready;
  });

  it("folds a callback argument along with the row that closes the call", async () => {
    await expectToFoldInto(
      dedent`
        document.addEventListener("DOMContentLoaded", (): void => {
          console.log("hello");
        });
      `,
      dedent`
        document.addEventListener("DOMContentLoaded", (): void => {…});
      `,
    );
  });

  it("folds an argument list that breaks after its opening parenthesis", async () => {
    // The fold stops one row short so that the `) {` row keeps the fold for the
    // function body.
    await setTextAndWaitForUpdate(dedent`
      function foo(
        bar: string,
        baz: number,
      ) {
        qux;
      }
    `);

    editor.foldBufferRow(0);
    expect(getDisplayText(editor)).toBe(dedent`
      function foo(…
      ) {
        qux;
      }
    `);

    editor.foldBufferRow(3);
    expect(getDisplayText(editor)).toBe(dedent`
      function foo(…
      ) {…}
    `);
  });

  it("folds an argument list whose last argument starts on the closing row", async () => {
    await expectToFoldInto(
      dedent`
        console.log("a",
          "b",
          "c");
      `,
      dedent`
        console.log("a",…);
      `,
    );
  });
});
