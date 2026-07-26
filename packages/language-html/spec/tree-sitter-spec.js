const path = require("path");

describe("WASM Tree-sitter HTML grammars", () => {
  beforeEach(async () => {
    atom.config.set("language.useTreeSitterParsers", true);
    await atom.packages.activatePackage("language-html");
    // The embedded-template grammars inject these into their directives.
    await atom.packages.activatePackage("language-javascript");
    await atom.packages.activatePackage("language-ruby");
  });

  it("tokenizes HTML tags, attributes and values", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "tree-sitter-html.html"), /<!--/, /-->/);
  });

  it("tokenizes EJS directives", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "tree-sitter-ejs.ejs"), /<!--/, /-->/);
  });

  it("tokenizes ERB directives", async () => {
    await runGrammarTests(path.join(__dirname, "fixtures", "tree-sitter-erb.erb"), /<!--/, /-->/);
  });
});
