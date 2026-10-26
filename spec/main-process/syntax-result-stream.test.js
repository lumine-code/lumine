const { test } = require("node:test");
const assert = require("node:assert/strict");
const stream = require("../../src/syntax-result-stream");

test("syntax iterators acknowledge only consumed packets and preserve final result", async () => {
  const entered = [];
  const iterator = stream(async (emit) => {
    for (let value = 0; value < 3; value++) {
      entered.push(value);
      await emit([value]);
    }
    return { count: 3 };
  });
  assert.deepEqual(await iterator.next(), { done: false, value: [0] });
  await new Promise(setImmediate);
  assert.deepEqual(entered, [0]);
  assert.deepEqual(await iterator.next(), { done: false, value: [1] });
  assert.deepEqual(await iterator.next(), { done: false, value: [2] });
  assert.deepEqual(await iterator.next(), { done: true, value: { count: 3 } });
});

test("breaking iteration releases acknowledgement and cancels its producer", async () => {
  let cancelled = false,
    after = false;
  const iterator = stream(async (emit, signal) => {
    signal.addEventListener("abort", () => {
      cancelled = true;
    });
    await emit(1);
    after = true;
  });
  await iterator.next();
  await iterator.return();
  assert.equal(cancelled, true);
  assert.equal(after, false);
});

test("producer failures and source invalidation never commit a partial success", async () => {
  const failure = new Error("query budget");
  const iterator = stream(async (emit) => {
    await emit([1]);
    throw failure;
  });
  await iterator.next();
  await assert.rejects(iterator.next(), (error) => error === failure);
  let current = true;
  const invalidated = stream(
    async (emit) => {
      await emit([1]);
      await emit([2]);
    },
    { isCurrent: () => current },
  );
  await invalidated.next();
  current = false;
  await assert.rejects(invalidated.next(), { name: "AbortError" });
});
