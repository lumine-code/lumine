const { test } = require("node:test");
const assert = require("node:assert/strict");
const { usesSyntaxIndentation } = require("../../src/typing-indentation-rules");
const WorkerMode = require("../../src/tree-sitter-worker-language-mode");

test("plain indentation requires proof across all possible injection grammars", () => {
  const plain = { queryPaths: {} };
  const indented = { queryPaths: { indentsQuery: "indents.scm" } };
  const root = {
    queryPaths: { injectionsQuery: "injections.scm" },
    queryCache: new Map([
      ["injectionsQuery", { injectionDescriptors: new Map([[0, { languageName: "child" }]]) }],
    ]),
  };
  const mode = { grammar: root, grammarForLanguageString: () => plain };
  assert.equal(usesSyntaxIndentation({ grammar: plain }), false);
  assert.equal(usesSyntaxIndentation({ grammar: indented }), true);
  assert.equal(usesSyntaxIndentation(mode), false);
  mode.grammarForLanguageString = () => indented;
  assert.equal(usesSyntaxIndentation(mode), true);
  mode.grammarForLanguageString = () => root;
  assert.equal(usesSyntaxIndentation(mode), false);
  root.queryCache.get("injectionsQuery").injectionDescriptors.set(1, {});
  assert.equal(usesSyntaxIndentation(mode), true);
  root.queryCache.clear();
  assert.equal(usesSyntaxIndentation(mode), true);
  assert.equal(
    usesSyntaxIndentation({ grammar: { ...plain, injectionPointsByType: { string: [{}] } } }),
    true,
  );
});

test("missing or obsolete indentation metadata cannot bypass syntax", () => {
  const mode = { getSyntaxRequestEpoch: () => "new", typingIndentationEpoch: "new" };
  const canSkip = () => WorkerMode.prototype.canIndentNewlineWithoutSyntax.call(mode);
  assert.equal(canSkip(), false);
  mode.usesSyntaxIndentation = false;
  assert.equal(canSkip(), true);
  mode.typingIndentationEpoch = "old";
  assert.equal(canSkip(), false);
});
