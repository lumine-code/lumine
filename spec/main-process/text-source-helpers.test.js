const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree } = require("../../src/text-model");
const { rangeIsBlank, leadingIndentation, trimmedRange } = require("../../src/text-source-helpers");
const NullLanguageMode = require("../../src/null-language-mode");
const IndentResolver = require("../../src/tree-sitter-indent-resolver");

test("source whitespace and indentation preserve Unicode, tab stops and range boundaries", () => {
  const source = new PieceTree(" \t".repeat(5000) + "\u2003😀 word \r\n");
  assert.equal(rangeIsBlank(source, 0, 10001), true);
  assert.equal(rangeIsBlank(source, 0, source.length), false);
  assert.deepEqual(leadingIndentation(source, 0, source.length, 4), {
    columns: 20000,
    length: 10000,
    level: 5000,
  });
  assert.deepEqual(leadingIndentation(source, 0, 1, 4, 3), { columns: 4, length: 1, level: 1 });
  assert.deepEqual(trimmedRange(source, 0, source.length), {
    start: 10001,
    end: source.length - 3,
  });
});

test("None token scope queries retain oversized source without materializing its value", () => {
  let source = new PieceTree("x".repeat(32768));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  const mode = new NullLanguageMode({
    buffer: {
      lineLengthForRow: () => source.length,
      getTextSnapshot: () => source,
      lineForRow: () => {
        throw new Error("must not read full line");
      },
    },
  });
  try {
    const token = mode.tokenForPosition([0, 0]);
    assert.deepEqual(token.scopes, ["text.plain.null-grammar"]);
    assert.equal(token.valueSource.length, source.length);
    assert.throws(() => token.value, { code: "ERR_TEXT_MATERIALIZATION_LIMIT" });
  } finally {
    mode.destroy();
  }
});

test("syntax indentation compares node and trimmed line through bounded readers", () => {
  const source = new PieceTree(" \t" + "identifier".repeat(20000) + "\u2003");
  const resolver = Object.create(IndentResolver.prototype);
  resolver.buffer = {
    getTextSnapshot: () => source,
    lineLengthForRow: () => source.length,
    lineForRow: () => {
      throw new Error("must not materialize line");
    },
  };
  const node = {
    startIndex: 2,
    endIndex: source.length - 1,
    startPosition: { row: 0, column: 2 },
    tree: {
      textCallback: (offset) => source.slice(offset, Math.min(source.length, offset + 4096)),
    },
    get text() {
      throw new Error("must not materialize node text");
    },
  };
  assert.equal(resolver.indentLevelForBufferRow(0, 4), 1);
  assert.equal(resolver.nodeMatchesLineContent(node, resolver.lineContent(0)), true);
  node.endIndex--;
  assert.equal(resolver.nodeMatchesLineContent(node, resolver.lineContent(0)), false);
  assert.equal(resolver.nodeMatchesLineContent(node, resolver.lineContent(0), true), true);
});
