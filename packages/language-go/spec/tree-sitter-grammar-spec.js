const path = require("path");

describe("WASM Tree-sitter Go grammar", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("language-go");
  });

  it("passes grammar tests", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "sample.go"), /\/\//);
  });
});
