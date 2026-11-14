const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const { scanInputIndentation } = require("../../src/tree-sitter-input-indentation");

async function observe({ source, levels, options = {}, inspect }) {
  const buffer = new TextBuffer({ text: source });
  const observations = [];
  let settlements = 0;
  const mode = {
    indentationOnly: true,
    buffer,
    async atGrammarSettlement() {
      settlements++;
      return {};
    },
    async *scanSuggestedIndentation([[row]]) {
      observations.push({ row, text: buffer.getText(), revision: buffer.getTextRevision() });
      yield [[row, levels[row]]];
    },
  };
  try {
    const plan = [];
    for await (const batch of scanInputIndentation(mode, [[0, levels.length - 1]], 4, options))
      plan.push(...batch);
    inspect({ plan, observations, settlements, buffer });
  } finally {
    buffer.destroy();
  }
}

test("a null level preserves the earlier prefix seen by the next syntax request", async () => {
  await observe({
    source: "  literal\nnext",
    levels: [null, 0],
    inspect({ plan, observations, settlements }) {
      assert.deepEqual(plan, [
        [0, null],
        [1, 0],
      ]);
      assert.equal(observations[1].text, "  literal\nnext");
      assert.equal(observations[1].revision, observations[0].revision);
      assert.equal(settlements, 1);
    },
  });
});

test("zero removes the earlier prefix before a later syntax request observes the document", async () => {
  await observe({
    source: "    former\nnext",
    levels: [0, 1],
    inspect({ plan, observations, settlements }) {
      assert.deepEqual(plan, [
        [0, 0],
        [1, 1],
      ]);
      assert.equal(observations[1].text, "former\nnext");
      assert.ok(observations[1].revision > observations[0].revision);
      assert.equal(settlements, 2);
    },
  });
});

test("a later syntax request sees materialized tabs rather than a virtual numeric level", async () => {
  await observe({
    source: "first\nsecond",
    levels: [2, 0],
    options: { softTabs: false },
    inspect({ observations }) {
      assert.equal(observations[1].text, "\t\tfirst\nsecond");
    },
  });
});

test("materializing an inserted prefix retains the original leading whitespace suffix", async () => {
  await observe({
    source: "\t first\nsecond",
    levels: [1, 0],
    options: { softTabs: false, preserveLeadingWhitespace: true },
    inspect({ observations }) {
      assert.equal(observations[1].text, "\t\t first\nsecond");
    },
  });
});

test("an already equal prefix does not consume a new parse before later syntax reads", async () => {
  await observe({
    source: "    first\nsecond",
    levels: [1, 0],
    inspect({ observations, settlements }) {
      assert.equal(observations[1].text, "    first\nsecond");
      assert.equal(observations[1].revision, observations[0].revision);
      assert.equal(settlements, 1);
    },
  });
});

test("the last planned prefix needs no materialization or parse without a downstream dependency", async () => {
  await observe({
    source: "last",
    levels: [2],
    inspect({ plan, buffer, settlements }) {
      assert.deepEqual(plan, [[0, 2]]);
      assert.equal(buffer.getText(), "last");
      assert.equal(settlements, 1);
    },
  });
});

test("input materialization refuses a public syntax mode before changing its buffer", async () => {
  const buffer = new TextBuffer({ text: "public" });
  try {
    const mode = {
      buffer,
      indentationOnly: false,
      atGrammarSettlement: () => assert.fail("A public mode must not be queried"),
      scanSuggestedIndentation: () => assert.fail("A public mode must not be scanned"),
    };
    const iterator = scanInputIndentation(mode, [[0, 0]], 4, {});
    await assert.rejects(iterator.next(), /requires a private syntax mode/);
    assert.equal(buffer.getText(), "public");
  } finally {
    buffer.destroy();
  }
});

test("a request superseded during settlement yields no indentation or buffer changes", async () => {
  const buffer = new TextBuffer({ text: "private" });
  let current = true;
  try {
    const mode = {
      buffer,
      indentationOnly: true,
      atGrammarSettlement: async () => {
        current = false;
        return {};
      },
      scanSuggestedIndentation: () => assert.fail("An obsolete request must not be scanned"),
    };
    const iterator = scanInputIndentation(mode, [[0, 0]], 4, {}, { isCurrent: () => current });
    await assert.rejects(iterator.next(), { name: "AbortError" });
    assert.equal(buffer.getText(), "private");
  } finally {
    buffer.destroy();
  }
});
