const { spliceArray } = require("../src/helpers");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const Range = require("../src/range");

describe("Text model hot paths", () => {
  function scalarSplice(array, start, removedCount, insertedItems = []) {
    const oldLength = array.length;
    removedCount = Math.min(removedCount, oldLength - start);
    const delta = insertedItems.length - removedCount;
    const length = oldLength + delta;
    if (delta > 0) {
      array.length = length;
      for (let i = length - 1; i >= start + insertedItems.length; i--) array[i] = array[i - delta];
    } else if (delta < 0) {
      for (let i = start + insertedItems.length; i < length; i++) array[i] = array[i - delta];
      array.length = length;
    }
    for (let i = 0; i < insertedItems.length; i++) array[start + i] = insertedItems[i];
  }

  it("preserves row values across dense, sparse, large and out-of-cache splices", () => {
    let seed = 73;
    const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
    const actual = new Array(2000);
    for (let i = 0; i < actual.length; i += 7) actual[i] = i;
    const expected = actual.slice();
    for (let i = 0; i < 300; i++) {
      const start = random(actual.length + 20);
      const removed = random(1500);
      const inserted = i % 3 === 0 ? { length: random(1400) } : new Array(random(1400));
      if (Array.isArray(inserted)) for (let j = 0; j < inserted.length; j += 11) inserted[j] = i;
      spliceArray(actual, start, removed, inserted);
      scalarSplice(expected, start, removed, inserted);
      expect(Array.from(actual)).toEqual(Array.from(expected));
    }
  });

  it("snapshots aliased insertion data before changing the destination", () => {
    const actual = [1, 2, 3];
    spliceArray(actual, 1, 3, actual);
    expect(actual).toEqual([1, 1, 2, 3]);
  });

  it("invalidates only cached fold rows without materializing a large empty span", () => {
    const mode = {
      isFoldableCache: new Map([
        [2, false],
        [10, true],
        [999999, false],
      ]),
    };
    const invalidate = TreeSitterLanguageMode.prototype.emitFoldUpdate.bind(mode);
    invalidate(new Range([3, 0], [900000, 0]), { prefill: false });
    expect([...mode.isFoldableCache]).toEqual([
      [2, false],
      [999999, false],
    ]);
    invalidate(new Range([999999, 0], [999999, 1]), { prefill: false });
    expect([...mode.isFoldableCache]).toEqual([[2, false]]);
    invalidate(new Range([0, 0], [1000000, 0]), { prefill: false });
    expect(mode.isFoldableCache.size).toBe(0);
  });

  it("rebases sparse fold results once for mixed insertions and deletions", () => {
    let seed = 84;
    const random = (n) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
    for (let trial = 0; trial < 100; trial++) {
      const values = Array.from({ length: 300 }, (_, row) => (row % 5 ? undefined : row % 2 === 0));
      const mode = {
        isFoldableCache: new Map(values.flatMap((v, row) => (v == null ? [] : [[row, v]]))),
      };
      const changes = [];
      let delta = 0;
      for (let row = 2; row < 280; row += 7) {
        const oldRows = random(3);
        const newRows = random(3);
        changes.push({
          oldRange: new Range([row, 1], [row + oldRows, 1]),
          newRange: new Range([row + delta, 1], [row + delta + newRows, 1]),
        });
        values.splice(row + delta, oldRows + 1, ...new Array(newRows + 1));
        delta += newRows - oldRows;
      }
      TreeSitterLanguageMode.prototype.rebaseFoldCache.call(mode, changes);
      const expected = values.flatMap((v, row) => (v == null ? [] : [[row, v]]));
      expect([...mode.isFoldableCache]).toEqual(expected);
    }
  });

  it("invalidates replaced multiline rows even when their row count is unchanged", () => {
    const mode = {
      isFoldableCache: new Map([
        [1, false],
        [2, true],
        [4, false],
        [5, true],
        [6, false],
      ]),
    };
    TreeSitterLanguageMode.prototype.rebaseFoldCache.call(mode, [
      {
        oldRange: new Range([2, 0], [5, 0]),
        newRange: new Range([2, 0], [5, 0]),
      },
    ]);
    expect([...mode.isFoldableCache]).toEqual([
      [1, false],
      [6, false],
    ]);
  });
});
