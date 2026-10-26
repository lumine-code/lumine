const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const { normalizeLineEndings } = require("../../src/text-source-helpers");

test("snapshot newline normalization agrees with native insertion semantics for every CR/LF seam", () => {
  const inputs = ["", "\r", "\n", "\r\n", "\r\r\n", "\n\r", "😀\r\nx\ry\n\r"];
  for (const text of inputs) {
    const source = new PieceTree(text);
    for (let start = 0; start <= text.length; start++) {
      for (let end = start; end <= text.length; end++) {
        const part = source.subtext(start, end);
        const value = text.slice(start, end);
        assert.equal(part.hasLoneCarriageReturn, /\r(?!\n)/.test(value));
        for (const ending of ["\n", "\r\n"])
          assert.equal(
            normalizeLineEndings(part, ending).toString(),
            value.replace(/\r\n|\n|\r/g, ending),
          );
      }
    }
  }
});

test("CR metadata remains exact across backing buffers and shared repeated roots", () => {
  const source = new PieceTree("x".repeat(32767) + "\r\n");
  assert.equal(source.hasLoneCarriageReturn, false);
  assert.equal(source.subtext(32767, 32768).hasLoneCarriageReturn, true);
  assert.equal(source.subtext(32768).hasLoneCarriageReturn, false);
  assert.equal(normalizeLineEndings(source, "\r\n"), source);
  let repeated = source;
  while (repeated.canMaterialize())
    repeated = repeated.replace(repeated.length, repeated.length, repeated);
  assert.equal(normalizeLineEndings(repeated, "\r\n"), repeated);
  const lone = repeated.replace(repeated.length, repeated.length, "\r");
  assert.equal(lone.hasLoneCarriageReturn, true);
});
