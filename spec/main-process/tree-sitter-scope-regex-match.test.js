const { test } = require("node:test");
const assert = require("node:assert/strict");
const matchPattern = require("../../src/scope-regex-match");
const {
  withPredicateTextBudget,
  checkPredicateTextLength,
} = require("../../src/tree-sitter-query-budget");

function fixture(text) {
  const reads = [];
  const source = `offset:${text}:tail`;
  const node = {
    startIndex: 7,
    endIndex: 7 + text.length,
    get text() {
      checkPredicateTextLength(text.length);
      reads.push(text.length);
      return text;
    },
  };
  return {
    reads,
    match(regex, budget = {}) {
      return withPredicateTextBudget(
        () =>
          matchPattern(node, regex, () => ({
            slice(start, end) {
              reads.push(end - start);
              return source.slice(start, end);
            },
          })),
        { now: () => 0, ...budget },
      );
    },
  };
}

test("scope adjustments find exact early matches without reading a huge container", () => {
  const f = fixture(`selector {${"x".repeat(200000)}}`);
  const result = f.match(/{/);
  assert.equal(result.complete, true);
  assert.equal(result.value.index, 9);
  assert.deepEqual(f.reads, [4096]);
});

test("finite regex matches preserve native first-match semantics at chunk boundaries", () => {
  const text = `${"x".repeat(4095)}abcde${"x".repeat(100000)}`;
  for (const regex of [/abcde/, /a[b-d]{1,3}e/, /a.?cde/, /a[b-d]?[b-d]?[b-d]?e/]) {
    const f = fixture(text);
    const result = f.match(regex);
    assert.equal(result.complete, true);
    assert.equal(result.value.index, text.match(regex).index);
    assert.equal(result.value[0], text.match(regex)[0]);
    assert.ok(f.reads.every((length) => length <= 4096));
  }
});

test("finite anchored matches preserve CRLF, escaped anchors and code-unit positions", () => {
  for (const text of [
    `/*${"x".repeat(100000)}*/`,
    `/*${"x".repeat(100000)}*/\r\n`,
    `/*${"x".repeat(100000)}*/\n`,
    `/*${"x".repeat(100000)}*/\r`,
  ]) {
    for (const regex of [/^\/\*/, /\*\/$/, /\r?$/, /^\/\*$/, /\$$/, /^\$/]) {
      const f = fixture(text);
      const result = f.match(regex);
      const expected = text.match(regex);
      assert.equal(result.complete, true);
      assert.equal(result.value?.[0], expected?.[0]);
      assert.equal(result.value?.index, expected?.index);
      assert.ok(f.reads.every((length) => length <= 4));
    }
  }
});

test("bounded search never reports a false negative or a truncated greedy match", () => {
  for (const [text, regex] of [
    [`${"x".repeat(65536)}{`, /{/],
    [`${"x".repeat(65535)}ab`, /ab?/],
    ["x".repeat(100000), /missing/],
  ]) {
    const f = fixture(text);
    const result = f.match(regex);
    assert.equal(result.complete, false);
    assert.equal(result.reason, "predicate-text-limit");
    assert.equal(result.value, null);
    assert.equal(
      f.reads.reduce((sum, length) => sum + length, 0),
      65536,
    );
  }
});

test("opaque or unbounded expressions keep guarded full-text semantics", () => {
  for (const regex of [/x+/, /x*/, /(?=x)/, /(x)\1/, /x|y/, /x{1,}/, /\bx/, /x/i]) {
    const f = fixture("x".repeat(100000));
    assert.deepEqual(f.match(regex), {
      value: null,
      complete: false,
      reason: "predicate-text-limit",
    });
    assert.deepEqual(f.reads, []);
  }
  const f = fixture("TODO: value");
  assert.equal(f.match(/TODO(?=:)/).value[0], "TODO");
});

test("source-window reads honor a stricter caller budget", () => {
  const f = fixture("x".repeat(100000));
  assert.equal(f.match(/missing/, { maxPredicateTextLength: 2048 }).reason, "predicate-text-limit");
  assert.deepEqual(f.reads, []);
});
