const path = require("path");

describe("WASM Tree-sitter Java grammar", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("language-java");
  });

  it("passes grammar tests", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "sample.java"), /\/\//);
  });
});
