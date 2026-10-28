const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const TextChangeMap = require("../../src/text-change-map");
const publishPreparedInput = require("../../src/prepared-input-publication");

const source = "one gap\nunchanged middle\none tail\n";
const replacement = "OTHER\n";

function editsFor(buffer) {
  const edits = [];
  buffer.scan(/one/g, ({ range }) => edits.push({ range, text: replacement }));
  return edits;
}

async function prepareInput(buffer, mutate, transactionOptions = {}) {
  const draft = new TextBuffer({ text: buffer.getTextSnapshot() });
  try {
    const appliedChanges = [];
    draft.onDidApplyChanges(({ changes }) => appliedChanges.push(...changes));
    const checkpoint = draft.createCheckpoint();
    draft.transact(transactionOptions, () => mutate(draft));
    const changes = draft.historyProvider.getChangesSinceCheckpoint(checkpoint);
    await publishPreparedInput({
      buffer,
      appliedChanges,
      changes,
      coordinateMap: changes.coordinateMap ?? TextChangeMap.fromChanges(changes),
      finalSource: draft.getTextSnapshot(),
      check() {},
      finalize() {},
      groupingInterval: 0,
    });
  } finally {
    draft.destroy();
  }
}

const operations = [
  ["applyTextEdits", (buffer) => buffer.applyTextEdits(editsFor(buffer))],
  ["replaceAllMatches", (buffer) => buffer.replaceAllMatches(/one/g, replacement)],
  [
    "prepared input",
    (buffer) => prepareInput(buffer, (draft) => draft.replace(/one/g, replacement)),
  ],
];

for (const [name, apply] of operations) {
  test(`${name} never restores cleared provider-owned annotations`, async () => {
    const buffer = new TextBuffer(source);
    try {
      const layer = buffer.addMarkerLayer({ maintainHistory: false });
      const marker = layer.markRange(
        [
          [1, 3],
          [1, 9],
        ],
        { invalidate: "never" },
      );
      await apply(buffer);
      const edited = buffer.getText();
      assert.notEqual(edited, source);
      assert.equal(layer.getMarkerCount(), 1);
      layer.clear();
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(buffer.undo(), true);
        assert.equal(buffer.getText(), source);
        assert.equal(layer.getMarkerCount(), 0);
        assert.equal(marker.isDestroyed(), true);
        assert.equal(buffer.redo(), true);
        assert.equal(buffer.getText(), edited);
        assert.equal(layer.getMarkerCount(), 0);
        assert.equal(marker.isDestroyed(), true);
      }
    } finally {
      buffer.destroy();
    }
  });

  test(`${name} restores exact marker state when its layer opts into history`, async () => {
    const buffer = new TextBuffer(source);
    try {
      const layer = buffer.addMarkerLayer({ maintainHistory: true });
      const marker = layer.markRange(
        [
          [1, 3],
          [1, 9],
        ],
        {
          invalidate: "never",
          exclusive: true,
          reversed: true,
          owner: "history",
        },
      );
      const before = marker.getRange();
      await apply(buffer);
      const after = marker.getRange();
      assert.notDeepEqual(after, before);
      layer.clear();
      assert.equal(buffer.undo(), true);
      assert.equal(layer.getMarker(marker.id), marker);
      assert.deepEqual(marker.getRange(), before);
      assert.equal(marker.isValid(), true);
      assert.equal(marker.isReversed(), true);
      assert.equal(marker.isExclusive(), true);
      assert.deepEqual(marker.getProperties(), { owner: "history" });
      assert.equal(buffer.redo(), true);
      assert.equal(layer.getMarker(marker.id), marker);
      assert.deepEqual(marker.getRange(), after);
      assert.equal(marker.isValid(), true);
    } finally {
      buffer.destroy();
    }
  });
}

test("legacy transaction snapshots cannot resurrect ephemeral annotations on undo or redo", async () => {
  const buffer = new TextBuffer(source);
  try {
    const layer = buffer.addMarkerLayer();
    const marker = layer.markRange(
      [
        [1, 3],
        [1, 9],
      ],
      { invalidate: "never" },
    );
    const before = layer.createEagerSnapshot();
    await buffer.replaceAllMatches(/one/g, replacement);
    const after = layer.createEagerSnapshot();
    const transaction = buffer.historyProvider.undoStack.at(-1);
    // Older prepared publications captured all layers irrespective of opt-in.
    transaction.markerSnapshotBefore[layer.id] = before;
    transaction.markerSnapshotAfter[layer.id] = after;
    layer.clear();
    assert.equal(buffer.undo(), true);
    assert.equal(buffer.getText(), source);
    assert.equal(layer.getMarkerCount(), 0);
    assert.equal(marker.isDestroyed(), true);
    assert.equal(buffer.redo(), true);
    assert.equal(buffer.getText(), source.replace(/one/g, replacement));
    assert.equal(layer.getMarkerCount(), 0);
  } finally {
    buffer.destroy();
  }
});

test("reverting a legacy checkpoint restores opted-in markers and leaves cleared annotations retired", () => {
  const buffer = new TextBuffer(source);
  try {
    const annotations = buffer.addMarkerLayer();
    const history = buffer.addMarkerLayer({ maintainHistory: true });
    const range = [
      [1, 3],
      [1, 9],
    ];
    const ephemeral = annotations.markRange(range, { invalidate: "never" });
    const retained = history.markRange(range, { invalidate: "never" });
    const checkpoint = buffer.createCheckpoint();
    const entry = buffer.historyProvider.undoStack.find((item) => item.id === checkpoint);
    entry.snapshot[annotations.id] = annotations.createEagerSnapshot();
    buffer.insert([0, 0], "prefix\n");
    annotations.clear();
    history.clear();
    assert.equal(buffer.revertToCheckpoint(checkpoint), true);
    assert.equal(buffer.getText(), source);
    assert.equal(annotations.getMarkerCount(), 0);
    assert.equal(ephemeral.isDestroyed(), true);
    assert.equal(history.getMarker(retained.id), retained);
    assert.deepEqual(retained.getRange().serialize(), range);
  } finally {
    buffer.destroy();
  }
});

function markerState(markers) {
  return markers.map((marker) => ({
    range: marker.getRange().serialize(),
    valid: marker.isValid(),
  }));
}

function stripScalarSources(map) {
  for (const child of map.maps ?? []) stripScalarSources(child);
  if (map.base) stripScalarSources(map.base);
  for (const edit of map.edits ?? []) {
    delete edit.oldText;
    delete edit.newText;
  }
  return map;
}

test("grouped compressed replacements preserve annotations in unchanged gaps on undo and redo", async () => {
  const text = "AA gap keep\n".repeat(80);
  const actual = new TextBuffer(text);
  const reference = new TextBuffer(text);
  try {
    const markers = [actual, reference].map((buffer) => {
      const layer = buffer.addMarkerLayer();
      return Array.from({ length: 80 }, (_, row) =>
        layer.markRange(
          [
            [row, 3],
            [row, 6],
          ],
          { invalidate: "touch" },
        ),
      );
    });
    await actual.replaceAllMatches(/AA/g, "B\nC");
    await actual.replaceAllMatches(/keep/g, "KEPT");
    actual.groupLastChanges();
    reference.replace(/AA/g, "B\nC");
    reference.replace(/keep/g, "KEPT");
    reference.groupLastChanges();
    for (const action of ["undo", "redo"]) {
      assert.equal(actual[action](), true);
      assert.equal(reference[action](), true);
      assert.equal(actual.getText(), reference.getText());
      for (let index = 0; index < markers[0].length; index++) {
        assert.deepEqual(
          markerState([markers[0][index]]),
          markerState([markers[1][index]]),
          `${action}: gap annotation ${index}`,
        );
      }
    }
  } finally {
    actual.destroy();
    reference.destroy();
  }
});

for (const serialization of ["live", "current", "legacy"]) {
  for (const ordering of ["bulk then scalar", "scalar then bulk", "bulk then transfer"]) {
    test(`grouped ${ordering} preserves annotations through ${serialization} history`, async () => {
      const text = Array.from(
        { length: 80 },
        (_, row) => `AA gap ${String(row).padStart(2, "0")}\n`,
      ).join("");
      const actual = new TextBuffer(text);
      const reference = new TextBuffer(text);
      try {
        const markers = [actual, reference].map((buffer) => {
          const layer = buffer.addMarkerLayer();
          return Array.from({ length: 80 }, (_, row) =>
            layer.markRange(
              [
                [row, 3],
                [row, 6],
              ],
              { invalidate: "touch" },
            ),
          );
        });
        const scalar = (buffer) => buffer.insert([1, 0], "prefix ");
        if (ordering === "scalar then bulk") {
          await prepareInput(actual, scalar);
          scalar(reference);
        }
        await actual.replaceAllMatches(/AA/g, "B\nC");
        reference.replace(/AA/g, "B\nC");
        if (ordering === "bulk then scalar") {
          await prepareInput(actual, scalar);
          scalar(reference);
        } else if (ordering === "bulk then transfer") {
          const move = (buffer) => {
            const moved = buffer.getTextSnapshotInRange([
              [0, 0],
              [2, 0],
            ]);
            buffer.delete([
              [0, 0],
              [2, 0],
            ]);
            buffer.insert([158, 0], moved);
          };
          await prepareInput(actual, move, {
            textTransfers: [
              {
                start: { row: 0, column: 0 },
                end: { row: 2, column: 0 },
                target: { row: 158, column: 0 },
              },
            ],
          });
          reference.transact(() => move(reference));
        }
        assert.equal(actual.groupLastChanges(), true);
        assert.equal(reference.groupLastChanges(), true);
        const map = actual.historyProvider.undoStack.at(-1).patch.coordinateMap;
        assert.equal(map.maps.length, 2);
        if (ordering === "bulk then transfer") assert.equal(map.maps[1].transfers.length, 1);
        if (serialization !== "live") {
          const data = JSON.parse(JSON.stringify(map.serializeSnapshot(false)));
          if (serialization === "legacy") stripScalarSources(data);
          const restored = TextChangeMap.deserialize(data);
          assert.equal(
            require("../../src/text-change-map-edits").canReplay(restored),
            serialization !== "legacy",
          );
          actual.historyProvider.undoStack.at(-1).patch.coordinateMap = restored;
        }
        for (const action of ["before history", "undo", "redo", "undo", "redo"]) {
          if (action !== "before history") {
            assert.equal(actual[action](), true);
            assert.equal(reference[action](), true);
          }
          assert.equal(actual.getText(), reference.getText());
          for (let index = 0; index < markers[0].length; index++) {
            if (ordering === "bulk then transfer" && index === 0) {
              // Deleting the transferred source retires this annotation. Its
              // collapsed invalid range is not a live diagnostic location.
              assert.equal(markers[0][index].isValid(), false);
              assert.equal(markers[1][index].isValid(), false);
              continue;
            }
            assert.deepEqual(
              markerState([markers[0][index]]),
              markerState([markers[1][index]]),
              `${action}: gap annotation ${index}`,
            );
          }
        }
      } finally {
        actual.destroy();
        reference.destroy();
      }
    });
  }
}

for (const destroyInvalidatedMarkers of [false, true]) {
  test(`legacy history retires only touched custom-tracked annotations without inventing intermediate text (${destroyInvalidatedMarkers})`, async () => {
    const original = "AA gap\n".repeat(4);
    const buffer = new TextBuffer(original);
    try {
      await buffer.replaceAllMatches(/AA/g, "B\nC");
      buffer.insert([1, 0], "prefix ");
      buffer.groupLastChanges();
      const transaction = buffer.historyProvider.undoStack.at(-1);
      transaction.patch.coordinateMap = TextChangeMap.deserialize(
        stripScalarSources(
          JSON.parse(JSON.stringify(transaction.patch.coordinateMap.serializeSnapshot(false))),
        ),
      );
      // A provider can publish these after a session restored old history.
      let calls = 0;
      const layer = buffer.addMarkerLayer({
        destroyInvalidatedMarkers,
        trackRanges() {
          calls++;
          throw new Error("Intermediate text was not retained by legacy history");
        },
      });
      const touched = layer.markRange(
        [
          [1, 0],
          [1, 6],
        ],
        { invalidate: "never" },
      );
      const gap = layer.markRange(
        [
          [3, 2],
          [3, 5],
        ],
        { invalidate: "never" },
      );
      const destroyedAt = [];
      touched.onDidDestroy(() => destroyedAt.push(buffer.getText()));
      assert.equal(buffer.undo(), true);
      assert.equal(buffer.getText(), original);
      assert.equal(calls, 0);
      assert.equal(touched.isValid(), false);
      assert.equal(touched.isDestroyed(), destroyInvalidatedMarkers);
      assert.equal(gap.isValid(), true);
      assert.deepEqual(gap.getRange().serialize(), [
        [1, 3],
        [1, 6],
      ]);
      assert.deepEqual(destroyedAt, destroyInvalidatedMarkers ? [original] : []);
      assert.equal(buffer.redo(), true);
      assert.equal(calls, 0);
      assert.equal(gap.isValid(), true);
      assert.deepEqual(gap.getRange().serialize(), [
        [3, 2],
        [3, 5],
      ]);
    } finally {
      buffer.destroy();
    }
  });
}

test("a throwing legacy annotation destruction observer cannot interrupt undo publication or later redo", async () => {
  const original = "AA gap\n".repeat(4);
  const buffer = new TextBuffer(original);
  const failure = new Error("annotation observer failed");
  try {
    const history = buffer.addMarkerLayer({ maintainHistory: true });
    const retained = history.markRange(
      [
        [1, 3],
        [1, 6],
      ],
      { invalidate: "never" },
    );
    await buffer.replaceAllMatches(/AA/g, "B\nC");
    buffer.insert([1, 0], "prefix ");
    buffer.groupLastChanges();
    const edited = buffer.getText();
    const retainedAfter = retained.getRange().serialize();
    const transaction = buffer.historyProvider.undoStack.at(-1);
    transaction.patch.coordinateMap = TextChangeMap.deserialize(
      stripScalarSources(
        JSON.parse(JSON.stringify(transaction.patch.coordinateMap.serializeSnapshot(false))),
      ),
    );
    const layer = buffer.addMarkerLayer({
      destroyInvalidatedMarkers: true,
      trackRanges() {
        throw new Error("Legacy history must not invoke the custom tracker");
      },
    });
    const first = layer.markRange(
      [
        [1, 0],
        [1, 2],
      ],
      { invalidate: "never" },
    );
    const second = layer.markRange(
      [
        [1, 3],
        [1, 6],
      ],
      { invalidate: "never" },
    );
    const gap = layer.markRange(
      [
        [3, 2],
        [3, 5],
      ],
      { invalidate: "never" },
    );
    const destroyed = [],
      moved = [],
      applied = [],
      changed = [];
    first.onDidDestroy(() => {
      destroyed.push(["first", buffer.getText()]);
      throw failure;
    });
    second.onDidDestroy(() => destroyed.push(["second", buffer.getText()]));
    gap.onDidChange((event) => moved.push([buffer.getText(), event.newHeadPosition.serialize()]));
    buffer.onDidApplyChanges((event) =>
      applied.push([event.origin, buffer.getText(), event.changes.length]),
    );
    buffer.onDidChangeText((event) => changed.push([event.origin, buffer.getText()]));
    // An independent marker adjustment must still be replaced by the opted-in
    // history snapshot even when an earlier teardown callback throws.
    retained.setRange([
      [6, 0],
      [6, 1],
    ]);
    assert.throws(
      () => buffer.undo(),
      (error) => error instanceof AggregateError && error.errors.includes(failure),
    );
    assert.equal(buffer.getText(), original);
    assert.equal(buffer.transactCallDepth, 0);
    assert.equal(first.isDestroyed(), true);
    assert.equal(second.isDestroyed(), true);
    assert.equal(layer.getMarkerCount(), 1);
    assert.deepEqual(destroyed, [
      ["first", original],
      ["second", original],
    ]);
    assert.equal(gap.isValid(), true);
    assert.deepEqual(gap.getRange().serialize(), [
      [1, 3],
      [1, 6],
    ]);
    assert.deepEqual(retained.getRange().serialize(), [
      [1, 3],
      [1, 6],
    ]);
    assert.deepEqual(moved, [[original, [1, 6]]]);
    assert.deepEqual(changed, [["undo", original]]);
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0].slice(0, 2), ["undo", original]);
    assert.ok(applied[0][2] > 0);
    assert.equal(buffer.redo(), true);
    assert.equal(buffer.getText(), edited);
    assert.equal(gap.isValid(), true);
    assert.deepEqual(gap.getRange().serialize(), [
      [3, 2],
      [3, 5],
    ]);
    assert.deepEqual(retained.getRange().serialize(), retainedAfter);
    assert.deepEqual(changed, [
      ["undo", original],
      ["redo", edited],
    ]);
    assert.equal(applied.length, 2);
    assert.deepEqual(applied[1].slice(0, 2), ["redo", edited]);
    assert.equal(destroyed.length, 2);
  } finally {
    buffer.destroy();
  }
});

for (const ending of ["\n", "\r\n"]) {
  for (const operation of ["applyTextEdits", "replaceAllMatches"]) {
    test(`${operation} replays compressed maps locally for gap markers and custom trackers (${JSON.stringify(ending)})`, async () => {
      const count = 80;
      const original = ("AA keep😀" + ending).repeat(count) + "tail";
      const inserted = "B" + ending + "C";
      const actual = new TextBuffer(original);
      const reference = new TextBuffer(original);
      try {
        const layers = [actual, reference].map((buffer) => buffer.addMarkerLayer());
        const gaps = layers.map((layer) =>
          Array.from({ length: count }, (_, row) =>
            layer.markRange(
              [
                [row, 3],
                [row, 7],
              ],
              { invalidate: "touch" },
            ),
          ),
        );
        if (operation === "applyTextEdits") {
          await actual.applyTextEdits(
            Array.from({ length: count }, (_, row) => ({
              range: [
                [row, 0],
                [row, 2],
              ],
              text: inserted,
            })),
          );
        } else await actual.replaceAllMatches(/AA/g, inserted);
        reference.replace(/AA/g, inserted);
        const transaction = actual.historyProvider.undoStack.at(-1);
        assert.equal(transaction.patch.coordinateMap.runs.length, 1);
        assert.equal(transaction.patch.coordinateMap.runs[0].count, count);
        assert.equal(actual.getText(), reference.getText());
        assert.deepEqual(markerState(gaps[0]), markerState(gaps[1]));

        // Trackers can appear after a prepared edit (for example a language
        // server activates). Undo must replay local splices, not the enclosing
        // replacement span, or it incorrectly touches every marker in a gap.
        const gapCalls = [0, 0];
        layers.forEach((layer, index) =>
          layer.setRangeTracker((ranges) => {
            gapCalls[index]++;
            return ranges;
          }),
        );
        const traces = [[], []];
        const tracked = [actual, reference].map((buffer, index) => {
          const layer = buffer.addMarkerLayer({
            trackRanges(ranges, change) {
              traces[index].push({
                old: change.oldRange.serialize(),
                next: change.newRange.serialize(),
                text: change.newText,
                liveText: buffer.getTextInRange(change.newRange),
              });
              return ranges.map(({ id }) => ({ id, range: change.newRange }));
            },
          });
          return Array.from({ length: count }, (_, row) =>
            layer.markRange(
              [
                [row * 2, 0],
                [row * 2 + 1, 1],
              ],
              { invalidate: "never" },
            ),
          );
        });
        for (const action of ["undo", "redo", "undo", "redo"]) {
          traces.forEach((trace) => {
            trace.length = 0;
          });
          assert.equal(actual[action](), true);
          assert.equal(reference[action](), true);
          assert.equal(actual.getText(), reference.getText());
          assert.deepEqual(markerState(gaps[0]), markerState(gaps[1]));
          assert.deepEqual(markerState(tracked[0]), markerState(tracked[1]));
          assert.deepEqual(gapCalls, [0, 0]);
          assert.equal(traces[0].length, count);
          assert.deepEqual(traces[0], traces[1]);
          for (const change of traces[0]) assert.equal(change.liveText, change.text);
        }
      } finally {
        actual.destroy();
        reference.destroy();
      }
    });
  }
}
