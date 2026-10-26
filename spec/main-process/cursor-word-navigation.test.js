const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const { paragraphBoundary, currentWordRange } = require("../../src/cursor-word-navigation");
const Point = require("../../src/point");

test("paragraph source navigation preserves LF/CRLF native match sequence", () => {
  const examples = [
    "a\n\n\n\n\nb",
    "a\r\n \r\n\t\r\nb\r\n\r\nc",
    "a\n \r\n\n\r\n b\n\nc",
    "\n\n\n",
    "x\n \n y\n \n z",
    "",
  ];
  for (const text of examples) {
    const buffer = new TextBuffer(text);
    for (let row = 0; row < buffer.getLineCount(); row++)
      for (const column of new Set([0, buffer.lineLengthForRow(row)])) {
        const position = new Point(row, column),
          cursor = { editor: { buffer }, getBufferPosition: () => position };
        const regex = /(\r\n[\t ]*\r\n)|(\n[\t ]*\n)/g;
        const next = buffer
          .findAllInRangeSync(regex, [position, buffer.getEndPosition()])
          .map((r) => new Point(r.start.row + 1, 0))
          .find((p) => !p.isEqual(position));
        const eof = buffer.getEndPosition();
        assert.deepEqual(
          paragraphBoundary(cursor, 1),
          next
            ? { row: next.row, column: next.column }
            : { row: eof.row, column: Math.max(0, eof.column - 1) },
          `next ${JSON.stringify(text)} ${row},${column}`,
        );
        const prev = buffer
          .findAllInRangeSync(regex, [
            [row - 1, column],
            [0, 0],
          ])
          .map((r) => new Point(r.start.row + 1, 0))
          .reverse()
          .find((p) => !p.isEqual(position));
        assert.deepEqual(
          paragraphBoundary(cursor, -1),
          prev ? { row: prev.row, column: prev.column } : { row: 0, column: 0 },
          `previous ${JSON.stringify(text)} ${row},${column}`,
        );
      }
    buffer.destroy();
  }
});

test("source subword grammar agrees with native matches at every clipped range", () => {
  const Cursor = require("../../src/cursor");
  const { subwordRanges, lastSubwordRange } = require("../../src/cursor-word-navigation");
  const texts = [
    "HTTPServer_foo2_bar __XML9 .. tail\n\tcamelCase  \r\nUPPER\n",
    "  ____ words123! \n\nAéABCdZ_Éà𐐀😀",
    "AaAa_ABCd\r\n a\t\n end",
  ];
  for (const text of texts)
    for (const nonWord of [".,!;()-+", "_aA.", ""])
      for (const backwards of [false, true]) {
        const buffer = new TextBuffer(text);
        const cursor = { editor: { buffer }, getNonWordCharacters: () => nonWord };
        const regex = Cursor.prototype.subwordRegExp.call(cursor, { backwards });
        for (let start = 0; start <= text.length; start += 3)
          for (const end of [text.length, Math.min(text.length, start + 13)]) {
            const range = [
              buffer.positionForCharacterIndex(start),
              buffer.positionForCharacterIndex(end),
            ];
            const expected = buffer
              .findAllInRangeSync(regex, range)
              .map((r) => [r.start.row, r.start.column, r.end.row, r.end.column]);
            const actual = Array.from(subwordRanges(cursor, range, regex), (r) => [
              r.start.row,
              r.start.column,
              r.end.row,
              r.end.column,
            ]);
            assert.deepEqual(
              actual,
              expected,
              `${JSON.stringify(text)} ${nonWord} ${backwards} ${start}-${end}`,
            );
            if (backwards) {
              const last = lastSubwordRange(cursor, range, regex);
              assert.deepEqual(
                last
                  ? [last.start.row, last.start.column, last.end.row, last.end.column]
                  : undefined,
                expected.at(-1),
                `last ${JSON.stringify(text)} ${nonWord} ${start}-${end}`,
              );
            }
          }
        buffer.destroy();
      }
});

test("default word runs and inclusive current-word edges agree with native matching", () => {
  const Cursor = require("../../src/cursor");
  const { wordRanges } = require("../../src/cursor-word-navigation");
  const texts = ["one(two) a-b\n  \r\n😀é_2.. ", " word\n\n\t\nlast", "A.B  C-D"];
  for (const text of texts)
    for (const nonWord of [".()-", "", " _"])
      for (const includeNonWordCharacters of [false, true]) {
        const buffer = new TextBuffer(text);
        const cursor = { editor: { buffer }, getNonWordCharacters: () => nonWord };
        const options = { includeNonWordCharacters };
        const regex = Cursor.prototype.wordRegExp.call(cursor, options);
        for (let start = 0; start <= text.length; start += 2)
          for (const end of [text.length, Math.min(text.length, start + 9)]) {
            const range = [
              buffer.positionForCharacterIndex(start),
              buffer.positionForCharacterIndex(end),
            ];
            const expected = buffer
              .findAllInRangeSync(regex, range)
              .map((r) => [r.start.row, r.start.column, r.end.row, r.end.column]);
            const actual = Array.from(wordRanges(cursor, range, options), (r) => [
              r.start.row,
              r.start.column,
              r.end.row,
              r.end.column,
            ]);
            assert.deepEqual(
              actual,
              expected,
              `${JSON.stringify(text)} ${nonWord} ${start}-${end}`,
            );
            const reverse = Array.from(wordRanges(cursor, range, options, true), (r) => [
              r.start.row,
              r.start.column,
              r.end.row,
              r.end.column,
            ]);
            assert.deepEqual(reverse, expected.toReversed());
          }
        for (let row = 0; row < buffer.getLineCount(); row++)
          for (let column = 0; column <= buffer.lineLengthForRow(row); column++) {
            cursor.getBufferPosition = () => new Point(row, column);
            const match = buffer
              .findAllInRangeSync(regex, [
                [row, 0],
                [row, Infinity],
              ])
              .find((r) => r.end.column >= column && r.start.column <= column);
            const expected = match
              ? new (require("../../src/range"))(match.start, match.end)
              : new (require("../../src/range"))([row, column], [row, column]);
            assert.deepEqual(currentWordRange(cursor, options).serialize(), expected.serialize());
          }
        buffer.destroy();
      }
});

test("backward subword restart is exact across randomized class and newline transitions", () => {
  const Cursor = require("../../src/cursor");
  const { lastSubwordRange } = require("../../src/cursor-word-navigation");
  let seed = 7613;
  const symbols = [
    "a",
    "B",
    "C",
    "d",
    "0",
    "2",
    "_",
    ".",
    ")",
    " ",
    "\t",
    "\n",
    "\r",
    "é",
    "É",
    "😀",
  ];
  for (let sample = 0; sample < 250; sample++) {
    let text = "";
    for (let i = 0; i < 60; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += symbols[(seed >>> 16) % symbols.length];
    }
    const buffer = new TextBuffer(text),
      cursor = { editor: { buffer }, getNonWordCharacters: () => ".()_" };
    const regex = Cursor.prototype.subwordRegExp.call(cursor, { backwards: true });
    for (let end = 1; end <= text.length; end += 5) {
      const range = [[0, 0], buffer.positionForCharacterIndex(end)];
      const clippedEnd = buffer.characterIndexForPosition(buffer.clipPosition(range[1]));
      const native = new RegExp(
        require("../../src/document-search").searchPattern(
          regex.source,
          clippedEnd === text.length ||
            text[clippedEnd] === "\n" ||
            text.slice(clippedEnd, clippedEnd + 2) === "\r\n",
          false,
        ),
        "g",
      );
      const match = Array.from(text.slice(0, clippedEnd).matchAll(native)).at(-1);
      const expected = match
        ? {
            start: buffer.positionForCharacterIndex(match.index),
            end: buffer.positionForCharacterIndex(match.index + match[0].length),
          }
        : null;
      const actual = lastSubwordRange(cursor, range, regex);
      assert.deepEqual(
        actual?.serialize(),
        expected
          ? [
              [expected.start.row, expected.start.column],
              [expected.end.row, expected.end.column],
            ]
          : undefined,
        `${JSON.stringify(text)} ${end}`,
      );
    }
    buffer.destroy();
  }
});
