const path = require("path");

describe("WASM Tree-sitter Rust grammar", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("language-rust");
  });

  it("passes grammar tests", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "sample.rs"), /\/\//);
  });
});
