const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");

const edits = [
  {
    range: [
      [0, 0],
      [0, 1],
    ],
    text: "long",
  },
  {
    range: [
      [0, 6],
      [0, 7],
    ],
    text: "long",
  },
];

function fixture(kind) {
  const buffer = new TextBuffer("x gap x");
  const tracking = buffer.addMarkerLayer({
    trackRanges: (entries) => entries.map(({ id }) => ({ id, range: buffer.getRange() })),
  });
  tracking.markRange(buffer.getRange(), { invalidate: "never" });
  const destroying = buffer.addMarkerLayer({
    destroyInvalidatedMarkers: true,
    ...(kind === "custom" ? { trackRanges: () => [] } : {}),
  });
  const first = destroying.markRange(
    [
      [0, 0],
      [0, 1],
    ],
    { invalidate: "touch" },
  );
  const last = destroying.markRange(
    [
      [0, 6],
      [0, 7],
    ],
    { invalidate: "touch" },
  );
  const selection = buffer.markPosition([0, 0], { invalidate: "never" });
  return { buffer, destroying, first, last, selection };
}

function contains(error, expected) {
  return (
    error === expected ||
    error?.errors?.some((entry) => contains(entry, expected)) ||
    (error?.cause && contains(error.cause, expected))
  );
}

for (const kind of ["ordinary", "custom"]) {
  test(`streamed edits defer ${kind} marker destruction until final text and selection publication`, async () => {
    const { buffer, first, last, selection } = fixture(kind);
    const seen = [];
    let presentationFinished = false;
    const record = (name) =>
      seen.push({
        name,
        text: buffer.getText(),
        selection: selection.getHeadPosition().serialize(),
        presentationFinished,
      });
    first.onDidDestroy(() => record("first"));
    last.onDidDestroy(() => record("last"));
    try {
      assert.equal(
        await buffer.applyTextEdits(edits, {
          didCommit: () => selection.setHeadPosition([0, 13]),
          withCommit(commit) {
            const result = commit();
            presentationFinished = true;
            return result;
          },
        }),
        2,
      );
      assert.deepEqual(
        seen,
        ["first", "last"].map((name) => ({
          name,
          text: "long gap long",
          selection: [0, 13],
          presentationFinished: true,
        })),
      );
      assert.equal(buffer.undo(), true);
      assert.equal(buffer.getText(), "x gap x");
      assert.equal(buffer.undo(), false);
      assert.equal(buffer.redo(), true);
      assert.equal(buffer.getText(), "long gap long");
    } finally {
      buffer.destroy();
    }
  });

  test(`throwing ${kind} destruction observers keep the complete streamed edit committed`, async () => {
    const { buffer, first, last } = fixture(kind);
    const failures = [
      new Error("first destruction observer"),
      new Error("last destruction observer"),
    ];
    const seen = [];
    const subscriptions = [
      first.onDidDestroy(() => {
        seen.push(buffer.getText());
        throw failures[0];
      }),
      last.onDidDestroy(() => {
        seen.push(buffer.getText());
        throw failures[1];
      }),
    ];
    try {
      await assert.rejects(
        buffer.applyTextEdits(edits),
        (error) =>
          error.code === "ERR_EDIT_OBSERVER_FAILED" &&
          error.committed === true &&
          error.editCount === 2 &&
          failures.every((failure) => contains(error, failure)),
      );
      assert.deepEqual(seen, ["long gap long", "long gap long"]);
      assert.equal(buffer.getText(), "long gap long");
      assert.equal(buffer.undo(), true);
      assert.equal(buffer.getText(), "x gap x");
      assert.equal(buffer.undo(), false);
      assert.equal(buffer.redo(), true);
      assert.equal(buffer.getText(), "long gap long");
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      buffer.destroy();
    }
  });

  test(`aborted streamed edits discard queued ${kind} destruction notifications and release their scope`, async () => {
    const { buffer, destroying, first, last } = fixture(kind);
    const seen = [];
    const batches = [];
    const changes = [];
    const displayChanges = [];
    const display = buffer.addDisplayLayer();
    const displayLayer = display.getMarkerLayer(destroying.id);
    const displayMarker = displayLayer.getMarker(first.id);
    displayMarker.onDidDestroy(() => seen.push("display"));
    displayMarker.onDidChange(() =>
      displayChanges.push(displayMarker.getBufferRange().serialize()),
    );
    first.onDidDestroy(() => seen.push("first"));
    last.onDidDestroy(() => seen.push("last"));
    first.onDidChange(() => changes.push(first.getRange().serialize()));
    const observation = buffer.onDidApplyChanges(() =>
      batches.push({
        text: buffer.getText(),
        first: destroying.getMarker(first.id) === first && !first.isDestroyed(),
        last: destroying.getMarker(last.id) === last && !last.isDestroyed(),
      }),
    );
    const failure = new Error("selection finalizer failed");
    try {
      await assert.rejects(
        buffer.applyTextEdits(edits, {
          didCommit() {
            throw failure;
          },
        }),
        (error) => error === failure && error.committed !== true,
      );
      assert.equal(buffer.getText(), "x gap x");
      assert.deepEqual(seen, []);
      assert.equal(first.isDestroyed(), false);
      assert.equal(last.isDestroyed(), false);
      assert.equal(destroying.getMarker(first.id), first);
      assert.equal(destroying.getMarker(last.id), last);
      assert.equal(displayMarker.isDestroyed(), false);
      assert.equal(displayLayer.getMarker(first.id), displayMarker);
      assert.equal(displayMarker.emitter.disposed, false);
      assert.deepEqual(first.getRange().serialize(), [
        [0, 0],
        [0, 1],
      ]);
      assert.deepEqual(last.getRange().serialize(), [
        [0, 6],
        [0, 7],
      ]);
      assert.deepEqual(batches, [{ text: "x gap x", first: true, last: true }]);
      assert.equal(buffer.undo(), false);
      first.setRange([
        [0, 1],
        [0, 2],
      ]);
      assert.deepEqual(changes, [
        [
          [0, 1],
          [0, 2],
        ],
      ]);
      assert.deepEqual(displayChanges, [
        [
          [0, 1],
          [0, 2],
        ],
      ]);
      first.destroy();
      last.destroy();
      const fresh = destroying.markPosition([0, 0]);
      fresh.onDidDestroy(() => seen.push("fresh"));
      fresh.destroy();
      assert.deepEqual(seen, ["display", "first", "last", "fresh"]);
    } finally {
      observation.dispose();
      buffer.destroy();
    }
  });
}
