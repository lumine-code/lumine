const { test } = require("node:test");
const assert = require("node:assert/strict");
const { constants } = require("node:buffer");
const TextBuffer = require("../../src/text-buffer");
const { PieceTree } = require("../../src/text-model");
const LanguageMode = require("../../src/tree-sitter-language-mode");

function modeFor(buffer) {
  const mode = Object.create(LanguageMode.prototype);
  mode.buffer = buffer;
  buffer.findInRangeSync = () => {
    throw new Error("The whitespace probe must not use whole-input regex search");
  };
  return mode;
}

function oversized(text) {
  let source = new PieceTree(text.repeat(32768));
  while (source.length <= constants.MAX_STRING_LENGTH)
    source = source.replace(source.length, source.length, source);
  return source;
}

test("first non-whitespace preserves ordinary Unicode, CRLF and UTF-16 match semantics", () => {
  const lines = [
    "",
    " \t\u00a0\u2003\ufeff",
    " \talpha",
    "\u2003😀",
    " \u200b",
    "x",
    " ".repeat(4095) + "\tvalue",
  ];
  const buffer = new TextBuffer({ text: lines.join("\r\n") });
  try {
    const mode = modeFor(buffer);
    for (let row = 0; row < lines.length; row++) {
      const expected = lines[row].search(/\S/);
      assert.deepEqual(
        mode.firstNonWhitespaceRange(row)?.serialize() ?? null,
        expected === -1
          ? null
          : [
              [row, expected],
              [row, expected + 1],
            ],
      );
    }
  } finally {
    buffer.destroy();
  }
});

test("comment probes on sparse conflict source larger than MAX_STRING_LENGTH never materialize its giant row", () => {
  let source = new PieceTree("<<<<<<< HEAD\n    ");
  source = source.replace(source.length, source.length, oversized("x"));
  source = source.replace(source.length, source.length, "\n=======\nother\n>>>>>>> incoming\n");
  const buffer = new TextBuffer({ text: source });
  try {
    const mode = modeFor(buffer);
    buffer.getText = () => {
      throw new Error("must not materialize the document");
    };
    buffer.lineForRow = () => {
      throw new Error("must not materialize a giant row");
    };
    let queried;
    mode.scopeDescriptorForPosition = (position) => {
      queried = position;
      return { getScopesArray: () => ["text.plain"] };
    };
    assert.ok(buffer.getLength() > constants.MAX_STRING_LENGTH);
    assert.deepEqual(mode.firstNonWhitespaceRange(1).serialize(), [
      [1, 4],
      [1, 5],
    ]);
    assert.equal(mode.isRowCommented(1), false);
    assert.deepEqual(queried.serialize(), [1, 4]);
  } finally {
    buffer.destroy();
  }
});

test("exhausting a huge whitespace prefix reports an unknown answer after bounded reads", () => {
  const source = oversized(" ");
  const buffer = new TextBuffer({ text: source });
  try {
    const mode = modeFor(buffer);
    let reads = 0;
    buffer.getTextSnapshot = () => ({
      lineCount: source.lineCount,
      lineStart: (row) => source.lineStart(row),
      reader(size) {
        assert.equal(size, 4096);
        const read = source.reader(size);
        return (offset) => {
          reads++;
          return read(offset);
        };
      },
    });
    assert.throws(() => mode.firstNonWhitespaceRange(0), {
      code: "ERR_SYNTAX_QUERY_BUDGET",
      reason: "source-window",
    });
    assert.equal(reads, 16);
  } finally {
    buffer.destroy();
  }
});

test("a fully examined whitespace row is blank and the exact prefix boundary is honored", () => {
  const buffer = new TextBuffer({
    text: " ".repeat(65536) + "\n" + " ".repeat(65535) + "x\n" + " ".repeat(65536) + "x",
  });
  try {
    const mode = modeFor(buffer);
    assert.equal(mode.firstNonWhitespaceRange(0), null);
    assert.deepEqual(mode.firstNonWhitespaceRange(1).serialize(), [
      [1, 65535],
      [1, 65536],
    ]);
    assert.throws(() => mode.firstNonWhitespaceRange(2), { code: "ERR_SYNTAX_QUERY_BUDGET" });
  } finally {
    buffer.destroy();
  }
});
