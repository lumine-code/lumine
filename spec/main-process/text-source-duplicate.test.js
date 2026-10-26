const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const { normalize } = require("../../src/text-editor-duplicate-lines");

test("cooperative duplicate normalization maps CR, LF and split CRLF anchors exactly", async () => {
  const text = "x".repeat(32767) + "\r\ny\rz\n😀\r";
  const source = new PieceTree(text);
  const offsets = [0, 3, 32767, 32768, 32769, 32770, 32771, text.length - 1, text.length];
  for (const ending of ["\n", "\r\n"]) {
    const result = await normalize(source, ending, offsets, () => {});
    assert.equal(result.source.toString(), text.replace(/\r\n|\n|\r/g, ending));
    assert.deepEqual(
      result.offsets,
      offsets.map((offset) => text.slice(0, offset).replace(/\r\n|\n|\r/g, ending).length),
    );
  }
});

test("normalization stops before publication when its owner is stale", async () => {
  const source = new PieceTree("a\r".repeat(100000));
  let checks = 0;
  await assert.rejects(
    normalize(source, "\n", [0], () => {
      if (++checks === 3) throw new Error("stale");
    }),
    /stale/,
  );
  assert.equal(checks, 3);
});
