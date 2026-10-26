const { test } = require("node:test");
const assert = require("node:assert/strict");
const PieceTree = require("../../src/piece-tree");

test("longest LF-delimited span follows shared joins, edits and CRLF boundaries", () => {
  let text = "a\r\nb\n" + "x".repeat(40000) + "\r\nend",
    source = new PieceTree(text);
  let random = 17;
  for (let index = 0; index < 200; index++) {
    random = (random * 1664525 + 1013904223) >>> 0;
    const start = random % (text.length + 1),
      end = Math.min(text.length, start + (random % 400));
    const inserted = ["\r\n", "\n\n", "q", "", "z\r"][(random >>> 8) % 5];
    source = source.replace(start, end, inserted);
    text = text.slice(0, start) + inserted + text.slice(end);
    assert.equal(source.maxLineSpan, Math.max(...text.split("\n").map((line) => line.length)));
    source.inspect();
  }
});

test("string line APIs reject an oversized row before building its string", () => {
  let source = new PieceTree("x".repeat(32768));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  source = source.replace(0, 0, "safe\n");
  const lines = source.lines();
  assert.equal(lines.next().value, "safe");
  assert.throws(() => lines.next(), { code: "ERR_TEXT_MATERIALIZATION_LIMIT" });
  assert.equal(source.maxLineSpan, source.length - 5);
});
