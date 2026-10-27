const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PieceTree, TextChangeMap, TextPatch } = require("../../src/text-model");
const TextBuffer = require("../../src/text-buffer");

test("transfer metadata composes, persists, reverses and distinguishes copied text", () => {
  const base = TextChangeMap.fromChanges([
    {
      oldStart: { row: 0, column: 0 },
      oldEnd: { row: 0, column: 0 },
      newStart: { row: 0, column: 0 },
      newEnd: { row: 1, column: 0 },
    },
  ]);
  for (const copy of [false, true]) {
    const transfers = [
      {
        start: { row: 1, column: 0 },
        end: { row: 2, column: 0 },
        target: { row: 0, column: 0 },
        copy,
      },
    ];
    const map = TextChangeMap.transfer(base, transfers);
    const restored = TextChangeMap.deserialize(JSON.parse(JSON.stringify(map.serializeSnapshot())));
    assert.deepEqual(restored.transfers, transfers);
    assert.equal(restored.invert().transfers.length, copy ? 0 : 1);
    assert.deepEqual(restored.invert().invert().transfers, transfers);
    assert.deepEqual(
      TextChangeMap.deserialize(
        JSON.parse(JSON.stringify(map.invert().serializeSnapshot())),
      ).invert().transfers,
      transfers,
    );
  }
});

test("failed text transfers restore text without publishing a partial presentation map", () => {
  const buffer = new TextBuffer("first\nsecond\n");
  let maps = 0;
  buffer.getLanguageMode().applyPresentationMap = () => maps++;
  try {
    assert.throws(
      () =>
        buffer.transact(
          {
            textTransfers: [
              {
                start: { row: 1, column: 0 },
                end: { row: 2, column: 0 },
                target: { row: 0, column: 0 },
              },
            ],
          },
          () => {
            buffer.delete([
              [1, 0],
              [2, 0],
            ]);
            throw new Error("cancel move");
          },
        ),
      /cancel move/,
    );
    assert.equal(buffer.getText(), "first\nsecond\n");
    assert.equal(buffer.presentationTransfer, undefined);
    assert.equal(maps, 0);
  } finally {
    buffer.destroy();
  }
});

test("a presentation observer failure cannot hide committed source transfers from the parser journal", () => {
  const buffer = new TextBuffer("first\nsecond\n");
  let changes;
  buffer.onDidApplyChanges((batch) => {
    changes = batch.changes;
  });
  buffer.getLanguageMode().applyPresentationMap = () => {
    throw new Error("paint observer");
  };
  try {
    assert.throws(
      () =>
        buffer.transact(
          {
            textTransfers: [
              {
                start: { row: 1, column: 0 },
                end: { row: 2, column: 0 },
                target: { row: 0, column: 0 },
              },
            ],
          },
          () => {
            buffer.delete([
              [1, 0],
              [2, 0],
            ]);
            buffer.insert([0, 0], "second\n");
          },
        ),
      /paint observer/,
    );
    assert.equal(buffer.getText(), "second\nfirst\n");
    assert.equal(changes.length, 2);
    assert.equal(buffer.presentationTransfer, undefined);
    buffer.undo();
    assert.equal(buffer.getText(), "first\nsecond\n");
  } finally {
    buffer.destroy();
  }
});

test("compressed change maps agree with sequential edits in both directions and affinities", () => {
  let seed = 12345;
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  for (let attempt = 0; attempt < 40; attempt++) {
    const before = new PieceTree("abc😀\ndefghi\n".repeat(20));
    const map = new TextChangeMap(before),
      changes = [];
    let after = before,
      start = 0,
      delta = 0;
    while (start < before.length - 8) {
      const end = start + random(5),
        text = "X\nY".slice(0, random(4));
      const oldStart = after.positionAt(start + delta),
        oldEnd = after.positionAt(end + delta);
      after = after.replace(start + delta, end + delta, text);
      changes.push({
        oldStart,
        oldEnd,
        newStart: oldStart,
        newEnd: after.positionAt(start + delta + text.length),
      });
      map.add(start, end, text.length);
      delta += text.length - (end - start);
      start = end + 1 + random(5);
    }
    map.finish(after);
    const scalar = TextChangeMap.fromChanges(changes);
    for (const [source, actual, expected] of [
      [before, map, scalar],
      [after, map.invert(), scalar.invert()],
    ])
      for (let offset = 0; offset <= source.length; offset++)
        for (const right of [false, true])
          assert.deepEqual(
            actual.mapPoint(source.positionAt(offset), right),
            expected.mapPoint(source.positionAt(offset), right),
            `${attempt}/${offset}/${right}`,
          );
  }
});

test("regular edits retain one geometry run without one record per occurrence", () => {
  const before = new PieceTree("a\n".repeat(100000));
  const map = new TextChangeMap(before);
  for (let i = 0; i < 100000; i++) map.add(i * 2, i * 2, 2);
  map.finish(new PieceTree("  a\n".repeat(100000)));
  assert.equal(map.runs.length, 1);
  assert.deepEqual(map.mapPoint({ row: 99999, column: 1 }), { row: 99999, column: 3 });
  assert.deepEqual(map.invert().mapPoint({ row: 99999, column: 3 }), { row: 99999, column: 1 });
});

test("patch copy, composition and inversion retain the local map around subsequent typing", () => {
  const before = new PieceTree("abc\ndef\nghi"),
    after = before.replace(0, 1, "long");
  const map = new TextChangeMap(before);
  map.add(0, 1, 4);
  map.finish(after);
  const first = new TextPatch();
  first.splice(
    { row: 0, column: 0 },
    before.positionAt(before.length),
    after.positionAt(after.length),
    before,
    after,
  );
  first.coordinateMap = map;
  const second = new TextPatch();
  second.splice({ row: 2, column: 1 }, { row: 0, column: 0 }, { row: 0, column: 1 }, "", "!");
  const composed = TextPatch.compose([first.copy(), second]);
  assert.deepEqual(composed.getChanges().coordinateMap.mapPoint({ row: 2, column: 2 }), {
    row: 2,
    column: 3,
  });
  assert.deepEqual(composed.invert().getChanges().coordinateMap.mapPoint({ row: 2, column: 3 }), {
    row: 2,
    column: 2,
  });
  for (const saved of [
    composed.serialize(),
    composed.serializeSnapshot(false),
    composed.serializeSnapshot(true),
  ]) {
    const restored = TextPatch.deserialize(saved);
    assert.deepEqual(restored.getChanges().coordinateMap.mapPoint({ row: 2, column: 2 }), {
      row: 2,
      column: 3,
    });
    assert.deepEqual(restored.invert().getChanges().coordinateMap.mapPoint({ row: 2, column: 3 }), {
      row: 2,
      column: 2,
    });
  }
});

test("identity Replace All retains match counts without publishing text or invalidating markers", async () => {
  const buffer = new TextBuffer("asset-1\nasset-2\n");
  const marker = buffer.markRange(
    [
      [0, 0],
      [1, 7],
    ],
    { invalidate: "touch" },
  );
  const revision = buffer.getTextRevision();
  let applied = 0;
  buffer.onDidApplyChanges(() => applied++);
  try {
    assert.equal(await buffer.replaceAllMatches(/asset-\d/g, "$&"), 2);
    assert.equal(buffer.getTextRevision(), revision);
    assert.equal(applied, 0);
    assert(marker.isValid());
    assert.equal(buffer.undo(), false);
  } finally {
    buffer.destroy();
  }
});

test("identity streams publish no revision, events, invalidated markers or undo entry", async () => {
  const buffer = new TextBuffer("asset-1\nasset-2\n");
  const marker = buffer.markRange(
    [
      [0, 0],
      [1, 7],
    ],
    { invalidate: "touch" },
  );
  const revision = buffer.getTextRevision();
  const events = [];
  buffer.onWillChange(() => events.push("will"));
  buffer.onDidApplyChanges(() => events.push("applied"));
  try {
    assert.equal(
      await buffer.applyTextEdits([
        {
          range: [
            [0, 0],
            [0, 7],
          ],
          text: "asset-1",
        },
        {
          range: [
            [1, 0],
            [1, 7],
          ],
          text: new PieceTree("asset-2"),
        },
      ]),
      0,
    );
    assert.equal(buffer.getTextRevision(), revision);
    assert.deepEqual(events, []);
    assert(marker.isValid());
    assert.equal(buffer.undo(), false);
  } finally {
    buffer.destroy();
  }
});

test("identity replacement finalizers keep the atomic publication lock without editing text", async () => {
  const buffer = new TextBuffer("same");
  const marker = buffer.markPosition([0, 0]);
  const revision = buffer.getTextRevision();
  let finalized = 0;
  try {
    const plan = await buffer.prepareReplaceAllMatches(/same/g, "same");
    assert.equal(
      plan.commit({
        didCommit() {
          finalized++;
          assert.throws(() => buffer.append("unexpected"));
          marker.setRange([
            [0, 4],
            [0, 4],
          ]);
        },
      }),
      1,
    );
    assert.equal(finalized, 1);
    assert.equal(buffer.getText(), "same");
    assert.equal(buffer.getTextRevision(), revision);
    assert.equal(marker.getStartPosition().column, 4);
    assert.equal(buffer.undo(), false);
  } finally {
    buffer.destroy();
  }
});

test("streamed edits publish an exact local parser journal with CRLF and multiline replacements", async () => {
  const original = "a\rb\ncd\r\nef\n";
  const buffer = new TextBuffer(original),
    replay = new TextBuffer(original);
  let received;
  buffer.onDidApplyChanges((batch) => {
    received = batch;
  });
  try {
    await buffer.applyTextEdits([
      {
        range: [
          [0, 2],
          [0, 3],
        ],
        text: "",
      },
      {
        range: [
          [1, 1],
          [1, 2],
        ],
        text: "\r",
      },
      {
        range: [
          [2, 1],
          [2, 2],
        ],
        text: "😀\nx",
      },
    ]);
    assert.equal(received.changes.length, 3);
    for (const change of received.changes) {
      assert.equal(
        replay.getTextSnapshot().subtext(change.startIndex, change.oldEndIndex).toString(),
        change.oldTextSource.toString(),
      );
      replay.applyChange(
        replay.buffer.prepareEditFromChange({
          oldStart: change.oldRange.start,
          oldEnd: change.oldRange.end,
          newStart: change.newRange.start,
          oldTextSource: change.oldTextSource,
          newTextSource: change.newTextSource,
        }),
      );
    }
    assert.equal(replay.getText(), buffer.getText());
    assert.equal(received.afterRevision - received.beforeRevision, 1);
  } finally {
    buffer.destroy();
    replay.destroy();
  }
});
