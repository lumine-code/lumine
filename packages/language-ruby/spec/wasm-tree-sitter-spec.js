const path = require("path");

describe("WASM Tree-sitter Ruby grammar", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("language-ruby");
    atom.config.set("language.useTreeSitterParsers", true);
  });

  it("tokenizes classes, methods and keywords", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "classes-wasm-ts.rb"), /#/);
  });

  it("folds code", async () => {
    await runFoldsTests(path.join(__dirname, "fixtures", "folds.rb"), /#/);
  });
});
