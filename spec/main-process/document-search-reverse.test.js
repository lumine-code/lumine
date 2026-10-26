const { test } = require("node:test");
const assert = require("node:assert/strict");
const PieceTree = require("../../src/piece-tree");
const TextBuffer = require("../../src/text-buffer");
const { DocumentSearch } = require("../../src/document-search");

test("bounded reverse replay preserves the forward global sequence and captures", () => {
  const inputs = [
    "aaaaababa abab abbc abc\r\nabc\na\r\nb\n😀😀x😀\r\n",
    "aaaaaaa\r\n😀abc abab\n".repeat(70),
  ];
  const patterns = [
    /a/g,
    /aa/g,
    /aba/g,
    /abc/gi,
    /\r?\n/g,
    /(?:)/gu,
    /^|$/gm,
    /(?<=a)(b)(?=c)/g,
    /(a)(b)\1/g,
    /a.*?b/g,
    /(?<pair>a(b))/dg,
  ];
  for (const input of inputs)
    for (const pattern of patterns)
      for (const windowUnits of [7, 25, 65536]) {
        const source = new PieceTree(input);
        for (const range of [undefined, { start: 1, end: input.length - 2 }]) {
          const search = new DocumentSearch(source, pattern, range, { windowUnits });
          const forward = Array.from(search.scan()).filter(Boolean);
          const reverse = Array.from(search.reverseRanges({ blockSize: 7, checkpointLimit: 4 }));
          assert.deepEqual(
            reverse,
            forward.map(({ start, end }) => ({ start, end })).reverse(),
            `${pattern} / ${windowUnits} / ${JSON.stringify(range)}`,
          );
          for (const found of reverse) {
            const actual = search.matchAtOffset(found.start, found.end);
            const expected = forward.find(
              (match) => match.start === found.start && match.end === found.end,
            );
            assert.deepEqual(Array.from(actual.match), Array.from(expected.match));
            assert.equal(actual.inputOffset + actual.match.index, found.start);
          }
        }
      }
});

test("reverse borderless literal traversal can stop at EOF without reading a huge prefix", () => {
  let source = new PieceTree("x".repeat(65536));
  for (let i = 0; i < 14; i++) source = source.replace(source.length, source.length, source);
  const slice = PieceTree.prototype.slice;
  let reads = 0;
  PieceTree.prototype.slice = function (start, end) {
    reads++;
    assert(start >= source.length - 65538);
    assert(end - start <= 65538);
    return slice.call(this, start, end);
  };
  try {
    const search = new DocumentSearch(source, /x/g);
    const iterator = search.reverseRanges();
    assert.deepEqual(iterator.next().value, { start: source.length - 1, end: source.length });
    iterator.return();
    assert.equal(reads, 1);
  } finally {
    PieceTree.prototype.slice = slice;
  }
});

test("legacy scan callbacks retain native context, captures, groups and indices", () => {
  for (const reverse of [false, true])
    for (const global of [false, true]) {
      const buffer = new TextBuffer("abc abc");
      try {
        const found = [];
        buffer.scanInRange(
          new RegExp("(?<=a)(?<letter>b)(?=c)", `d${global ? "g" : ""}`),
          buffer.getRange(),
          {},
          (result) => {
            found.push(result.range.start.column);
            assert.equal(result.match[0], "b");
            assert.equal(result.match[1], "b");
            assert.equal(result.match.groups.letter, "b");
            assert.equal(result.inputOffset + result.match.index, result.range.start.column);
            assert.equal(result.match.input.slice(...result.match.indices[1]), "b");
            result.replace("B");
            assert.equal(result.match[0], "b");
          },
          reverse,
        );
        assert.deepEqual(found, global ? (reverse ? [5, 1] : [1, 5]) : [reverse ? 5 : 1]);
      } finally {
        buffer.destroy();
      }
    }
});

test("legacy reverse callbacks preserve snapshot geometry while replacing matches", () => {
  const buffer = new TextBuffer("aa abc aa abc");
  try {
    const found = [];
    buffer.backwardsScan(/aa|(?<=a)b(?=c)/g, (result) => {
      found.push([result.range.start.column, result.match[0]]);
      result.replace("longer");
    });
    assert.deepEqual(found, [
      [11, "b"],
      [7, "aa"],
      [4, "b"],
      [0, "aa"],
    ]);
    assert.equal(buffer.getText(), "longer alongerc longer alongerc");
  } finally {
    buffer.destroy();
  }
});
