const { test } = require("node:test");
const assert = require("node:assert/strict");
const BoundedJsonLines = require("../../src/bounded-json-lines");

test("JSON message budgets apply before joining split chunks", () => {
  const messages = [];
  const parser = new BoundedJsonLines((message) => messages.push(message), 20);
  parser.write('{"text":"');
  parser.write("123456789");
  assert.throws(() => parser.write('123456789"}\n'), { code: "ERR_PROJECT_SEARCH_RESULT_LIMIT" });
  assert.deepEqual(messages, []);
  assert.equal(parser.units, 0);
});

test("many bounded messages in one chunk and split Unicode remain exact", () => {
  const messages = [];
  const parser = new BoundedJsonLines((message) => messages.push(message), 20);
  parser.write('{"x":"😀"}\n'.repeat(40) + '{"x":');
  parser.write('"café"}\n');
  assert.equal(messages.length, 41);
  assert.equal(messages[40].x, "café");
});
