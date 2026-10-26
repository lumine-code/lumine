const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const { transformSnapshot, transformSnapshotSync } = require("../../src/text-snapshot-transforms");

test("chunked case conversion agrees with native Unicode casing at every boundary", () => {
  const examples = [
    "aΣb AΣ AΣ\u0345B AΣ\u0301. \u0345Σ",
    "İıßﬃſ𐐀𐐨😀\ud800x\udc00",
    "AΣ" + "\u0301".repeat(71) + "B AΣ" + "\u0301".repeat(71) + ".",
  ];
  for (const input of examples)
    for (let size = 2; size < 18; size++) {
      const source = new PieceTree(input);
      assert.equal(
        transformSnapshotSync(source, "lower", { chunkSize: size }).toString(),
        input.toLowerCase(),
        `lower chunk ${size}`,
      );
      assert.equal(
        transformSnapshotSync(source, "upper", { chunkSize: size }).toString(),
        input.toUpperCase(),
        `upper chunk ${size}`,
      );
    }
});

test("reversal agrees with code-point reversal including split and lone surrogates", () => {
  const input = "ab😀𐐀\ud800x\udc00\r\nΣ";
  let source = new PieceTree();
  for (let i = 0; i < input.length; i++)
    source = source.replace(source.length, source.length, input[i]);
  for (let size = 2; size < 12; size++)
    assert.equal(
      transformSnapshotSync(source, "reverse", { chunkSize: size }).toString(),
      Array.from(input).reverse().join(""),
    );
});

test("async transformation yields, supports cancellation and retains unchanged source identity", async () => {
  const source = new PieceTree("lower case ".repeat(150000));
  let checks = 0;
  await assert.rejects(
    transformSnapshot(source, "upper", {
      check() {
        if (++checks === 2) throw Object.assign(new Error("cancel"), { name: "AbortError" });
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(await transformSnapshot(source, "lower"), source);
  assert.equal(source.slice(0, 10), "lower case");
});

test("context lookahead through long ignorable runs remains cancellable", async () => {
  const source = new PieceTree("AΣ" + "\u0301".repeat(1000000) + "B");
  let checks = 0;
  await assert.rejects(
    transformSnapshot(source, "lower", {
      chunkSize: 2,
      check() {
        if (++checks === 2) throw Object.assign(new Error("cancel"), { name: "AbortError" });
      },
    }),
    { name: "AbortError" },
  );
});
