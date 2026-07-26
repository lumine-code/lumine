const path = require("path");

describe("WASM Tree-sitter Shell Script grammar", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("language-shellscript");
  });

  it("passes grammar tests", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "sample.sh"), /#/);
  });
});
