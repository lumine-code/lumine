const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createQuery } = require("../../src/completion-matcher");
const TextStore = require("../../src/text-store");

test("prepared completion matches preserve UTF-16 indices, scores and independent queries", () => {
  const query = createQuery("hlo");
  const result = query.match("hello");
  assert.deepEqual(result.matchIndices, [0, 3, 4]);
  assert.equal(query.match("hello"), result);
  assert.equal(query.match("world"), null);
  assert.deepEqual(createQuery("abc").match("😀abc").matchIndices, [2, 3, 4]);
  assert.deepEqual(createQuery("ist").match("İstanbul").matchIndices, [0, 1, 2]);
  assert.deepEqual(createQuery("").match("hello").matchIndices, []);
  assert.deepEqual(createQuery("hl").match("hello").matchIndices, [0, 2]);
  assert.deepEqual(result.matchIndices, [0, 3, 4]);
  assert(Object.isFrozen(result.matchIndices));
  assert.equal(createQuery("hello").isRefinementOf("he"), true);
  assert.equal(createQuery("he").isRefinementOf("hello"), false);
  assert.equal(createQuery("ΟΣΑ").isRefinementOf("ΟΣ"), true);
  assert.deepEqual(createQuery("ΟΣ").match("ΟΣΑ").matchIndices, [0, 1]);
  assert.deepEqual(createQuery("ος").match("οσα").matchIndices, [0, 1]);
  assert.equal(createQuery("ος").match("ΟΣ").exact, true);
  assert.equal(createQuery("ος").match("ΟΣΑ").prefix, true);
  assert.equal(createQuery("ς").match("Σ").firstCharacterMatches, true);
  assert.equal(createQuery("a".repeat(257)).match("a".repeat(257)), null);
});

test("compact candidates return absolute positions, nearest row distance and cursor containment", async () => {
  const store = new TextStore("prefix\n".repeat(4000) + "  banana\r\nword\nbanana banana");
  const result = await store.findWordCandidates("bna", {
    range: { start: { row: 4000, column: 2 }, end: { row: 4002, column: 13 } },
    position: { row: 4002, column: 8 },
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].position, { row: 4000, column: 2 });
  assert.equal(result[0].distance, 0);
  assert.equal(result[0].containsPosition, true);
  assert.equal(result[0].occurrences, 3);
  assert.equal(result[0].positions, undefined);
  assert.deepEqual(result[0].matchIndices, createQuery("bna").match("banana").matchIndices);
});

test("compact search keeps its invocation snapshot and scales output by distinct words", async () => {
  const store = new TextStore("banana\n".repeat(20000));
  const search = store.findWordCandidates("bna");
  store.setText("newer");
  const result = await search;
  assert.equal(result[0].word, "banana");
  assert.equal(result[0].occurrences, 20000);
  assert.equal(result[0].distance, Infinity);
  assert.equal(result[0].containsPosition, false);
  assert.equal(result[0].positions, undefined);
});

test("obsolete compact searches stop when their request is aborted", async () => {
  const store = new TextStore("banana\n".repeat(100000));
  const controller = new AbortController();
  const promise = store.findWordCandidates("bna", { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await promise, []);
});

test("compact completion tokens cannot span line boundaries", async () => {
  const store = new TextStore("ab\ncd");
  await assert.rejects(store.findWordCandidates("ac", { extraWordCharacters: "\n" }), RangeError);
  await assert.rejects(store.findWordCandidates("ac", { extraWordCharacters: "\r" }), RangeError);
});

test("compact completion metadata captures the cursor along with the text snapshot", async () => {
  const store = new TextStore("banana\nother");
  const position = { row: 0, column: 3 };
  const result = store.findWordCandidates("bna", { position });
  position.row = 1;
  position.column = 0;
  assert.equal((await result)[0].containsPosition, true);
});
