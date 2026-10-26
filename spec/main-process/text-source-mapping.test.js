const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");

const jsonChunk = (text) =>
  JSON.stringify(text)
    .slice(1, -1)
    .replace(
      /[\ud800-\udfff]/g,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );

test("chunk mapping produces exact JSON text across quotes, controls and split surrogate pairs", async () => {
  const text = "x".repeat(32767) + '😀\r\n\t"\\\ud800end';
  const source = new PieceTree(text);
  const mapped = await source.mapChunks(jsonChunk);
  assert.equal(JSON.parse(`"${mapped.toString()}"`), text);
  assert.equal(mapped.toString(), jsonChunk(text));
});

test("mapping reuses immutable branches across huge snapshots and local edits", async () => {
  let source = new PieceTree("x".repeat(32768));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  const cache = new WeakMap();
  let calls = 0;
  const mapper = (chunk) => {
    calls++;
    return chunk.toUpperCase();
  };
  const first = await source.mapChunks(mapper, { cache });
  assert.equal(calls, 1);
  assert.equal(first.length, source.length);
  const middle = source.length / 2;
  const edited = source.replace(middle, middle + 1, "y");
  calls = 0;
  const second = await edited.mapChunks(mapper, { cache });
  assert(calls > 0 && calls <= 3);
  assert.equal(second.slice(middle - 1, middle + 2), "XYX");
  assert.equal(first.slice(middle - 1, middle + 2), "XXX");
  await assert.rejects(
    edited.mapChunks((text) => text, { cache }),
    /one mapper/,
  );
});

test("mapping aborts without mutating source and rejects invalid mapper results", async () => {
  const source = new PieceTree("a".repeat(70000));
  const controller = new AbortController();
  await assert.rejects(
    source.mapChunks(
      (chunk) => {
        controller.abort();
        return chunk;
      },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(source.length, 70000);
  await assert.rejects(
    source.mapChunks(() => Promise.resolve("x")),
    TypeError,
  );
});
