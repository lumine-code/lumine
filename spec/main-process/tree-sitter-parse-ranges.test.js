const assert = require("node:assert/strict");
const { test } = require("node:test");
const { smallFragmentRegions, splitIncludedRanges } = require("../../src/tree-sitter-parse-ranges");

const point = (column) => ({ row: 0, column });
const range = (startIndex, endIndex) => ({
  startIndex,
  endIndex,
  startPosition: point(startIndex),
  endPosition: point(endIndex),
});
const boundary = (index) => ({ index, position: point(index) });

test("keeps grammar ranges unchanged when there are no useful parse boundaries", () => {
  const ranges = [range(0, 10)];
  assert.equal(splitIncludedRanges(ranges, []), ranges);
  assert.equal(splitIncludedRanges(ranges, [boundary(0), boundary(10)]), ranges);
  assert.equal(splitIncludedRanges(null, []), null);
  const empty = [];
  assert.equal(splitIncludedRanges(empty, [boundary(5)]), empty);
});

test("subdivides ranges without changing their union or filling excluded source gaps", () => {
  const ranges = [range(4, 20), range(30, 45)];
  const cuts = [boundary(40), boundary(6), boundary(12), boundary(25), boundary(32)];
  const split = splitIncludedRanges(ranges, cuts, 1);
  assert.deepEqual(
    split.map(({ startIndex, endIndex }) => [startIndex, endIndex]),
    [
      [4, 6],
      [6, 12],
      [12, 20],
      [30, 32],
      [32, 40],
      [40, 45],
    ],
  );
  assert.deepEqual(split[0].startPosition, ranges[0].startPosition);
  assert.deepEqual(split[2].endPosition, ranges[0].endPosition);
  assert.deepEqual(split[3].startPosition, ranges[1].startPosition);
  assert.deepEqual(split[5].endPosition, ranges[1].endPosition);
  assert.deepEqual(ranges, [range(4, 20), range(30, 45)]);
});

test("keeps an unrestricted document unrestricted at EOF", () => {
  const split = splitIncludedRanges(null, [boundary(4096), boundary(8192)]);
  assert.equal(split[0].startIndex, 0);
  assert.equal(split[0].endIndex, 4096);
  assert.equal(split[1].endIndex, 8192);
  assert.equal(split.at(-1).endIndex, 0x7fffffff);
  assert.equal(split.at(-1).endPosition.row, 0x7fffffff);
});

test("prunes duplicate and tiny cuts accumulated by repeated edits", () => {
  const split = splitIncludedRanges(
    [range(0, 20000)],
    [
      boundary(4096),
      boundary(4097),
      boundary(4097),
      boundary(4100),
      boundary(8196),
      boundary(12292),
    ],
  );
  assert.deepEqual(
    split.map(({ endIndex }) => endIndex),
    [4096, 8196, 12292, 20000],
  );
});

test("rejects malformed boundary indices and points without changing source coverage", () => {
  const ranges = [range(0, 10000)];
  const split = splitIncludedRanges(ranges, [
    { index: -1, position: point(-1) },
    { index: 2048.5, position: point(2048) },
    { index: Infinity, position: point(2048) },
    { index: 4096, position: { row: -1, column: 0 } },
    { index: 8192, position: { row: 0, column: NaN } },
    boundary(6144),
  ]);
  assert.deepEqual(
    split.map(({ startIndex, endIndex }) => [startIndex, endIndex]),
    [
      [0, 6144],
      [6144, 10000],
    ],
  );
});

test("consolidates dense contiguous tiny fragments with coordinate-preserving edits", () => {
  const fragments = Array.from({ length: 200 }, (_, index) => range(index, index + 1));
  const regions = smallFragmentRegions(fragments);
  assert.equal(regions.length, 3);
  assert.deepEqual(
    regions.map(({ startIndex, oldEndIndex }) => [startIndex, oldEndIndex]),
    [
      [0, 64],
      [64, 128],
      [128, 192],
    ],
  );
  for (const edit of regions) {
    assert.equal(edit.oldEndIndex, edit.newEndIndex);
    assert.deepEqual(edit.oldEndPosition, edit.newEndPosition);
  }
});

test("limits consolidation work and preserves gaps and large fragment boundaries", () => {
  assert.equal(
    smallFragmentRegions(Array.from({ length: 2000 }, (_, index) => range(index, index + 1)))
      .length,
    8,
  );
  assert.deepEqual(
    smallFragmentRegions(
      Array.from({ length: 100 }, (_, index) => range(index * 2, index * 2 + 1)),
    ),
    [],
  );
  assert.deepEqual(
    smallFragmentRegions(
      Array.from({ length: 100 }, (_, index) => range(index * 100, index * 100 + 100)),
    ),
    [],
  );
  assert.deepEqual(
    smallFragmentRegions(
      Array.from({ length: 100 }, (_, index) => range(index * 1024, index * 1024 + 1024)),
    ),
    [],
  );
});
