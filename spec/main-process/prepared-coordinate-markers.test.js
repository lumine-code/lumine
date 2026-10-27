const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const CoordinateMarkerPlan = require("../../src/coordinate-marker-plan");
const { createPlan } = require("../../src/prepared-text-replacements");

for (const ending of ["\n", "\r\n"])
  test(`prepared coordinates preserve scalar marker geometry and invalidation (${JSON.stringify(ending)})`, async () => {
    const text = ["first", "  second 🦉", "third", "    fourth", "last", ""].join(ending);
    const original = new TextBuffer(text),
      reference = new TextBuffer(text);
    const source = original.getTextSnapshot();
    const markerPairs = [];
    try {
      for (const invalidate of ["never", "touch", "inside", "overlap", "surround"])
        for (const exclusive of [false, true])
          for (const range of [
            [
              [0, 0],
              [5, 0],
            ],
            [
              [1, 1],
              [1, 6],
            ],
            [
              [2, 0],
              [2, 0],
            ],
            [
              [3, 0],
              [4, 2],
            ],
          ]) {
            markerPairs.push([
              original.markRange(range, { invalidate, exclusive }),
              reference.markRange(range, { invalidate, exclusive }),
            ]);
          }
      const checkpoint = reference.createCheckpoint();
      reference.transact(
        {
          textTransfers: [
            {
              start: { row: 3, column: 0 },
              end: { row: 4, column: 0 },
              target: { row: 1, column: 0 },
            },
          ],
        },
        () => {
          const moved = reference.getTextSnapshotInRange([
            [3, 0],
            [4, 0],
          ]);
          reference.delete([
            [3, 0],
            [4, 0],
          ]);
          reference.insert([1, 0], moved);
        },
      );
      await reference.applyTextEdits([
        {
          range: [
            [1, 0],
            [1, 4],
          ],
          text: "  ",
        },
        {
          range: [
            [2, 0],
            [2, 2],
          ],
          text: "    ",
        },
      ]);
      const changes = reference.historyProvider.getChangesSinceCheckpoint(checkpoint);
      const markerPlan = new CoordinateMarkerPlan(original, source);
      await markerPlan.apply(changes.coordinateMap, () => {});
      assert.equal(original.getText(), text);
      const snapshot = reference.getTextSnapshot();
      createPlan({
        buffer: original,
        before: source,
        snapshot,
        range: original.getRange(),
        inserted: snapshot,
        count: changes.length,
        markerPlan,
        coordinateMap: changes.coordinateMap,
        check: () => {},
      }).commit();
      assert.equal(original.getText(), reference.getText());
      for (const [actual, expected] of markerPairs) {
        assert.deepEqual(actual.getRange().serialize(), expected.getRange().serialize());
        assert.equal(actual.isValid(), expected.isValid());
      }
      original.undo();
      assert.equal(original.getText(), text);
    } finally {
      original.destroy();
      reference.destroy();
    }
  });
