const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Parser, Language } = require("web-tree-sitter");
const DocumentParser = require("../../src/tree-sitter-parser");
const PieceTree = require("../../src/piece-tree");

async function main() {
  await Parser.init();
  const grammarPath = require.resolve("language-javascript/grammars/javascript.json");
  const grammar = require("@lumine-code/season").readFileSync(grammarPath);
  const language = await Language.load(
    fs.readFileSync(path.join(path.dirname(grammarPath), grammar.treeSitter.grammar)),
  );
  const failure = process.argv[2];
  function fail() {
    const source = new PieceTree("const value = 1;\n".repeat(10000));
    const parser = new DocumentParser(language);
    const references = { source: new WeakRef(source), parser: new WeakRef(parser) };
    const signal = {
      throwIfAborted() {},
      get aborted() {
        if (failure === "progress") throw new Error("Injected progress failure");
        return false;
      },
    };
    let input = source;
    if (failure === "input") {
      input = {
        length: source.length,
        reader: () => () => {
          assert.ok(source.length > 0);
          throw new Error("Injected input failure");
        },
      };
    } else if (failure === "logger") {
      const logger = () => {
        assert.ok(source.length > 0);
        assert.equal(parser.getLogger(), logger);
        throw new Error("Injected logger failure");
      };
      parser.setLogger(logger);
    }
    assert.throws(() => parser.parseSync(input, { signal }), {
      message: `Injected ${failure} failure`,
    });
    assert.equal(parser.pending, null);
    parser.close();
    assert.equal(parser.disposed, true);
    return references;
  }
  const references = fail();
  // No subsequent parse may overwrite the runtime's global callbacks: an idle
  // worker with another document open must release the failed document too.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    global.gc();
  }
  assert.equal(references.source.deref(), undefined, "Failed input remains reachable");
  assert.equal(references.parser.deref(), undefined, "Closed parser remains reachable");
  console.log(`Collected failed ${failure} input and parser without another parse`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
