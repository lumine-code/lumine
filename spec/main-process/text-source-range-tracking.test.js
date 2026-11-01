const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");

function deferred() {
  let resolve;
  const promise = new Promise((callback) => (resolve = callback));
  return { promise, resolve };
}

function trackDocument(buffer, callback = () => {}) {
  const layer = buffer.addMarkerLayer({
    maintainHistory: true,
    trackRanges(ranges, change) {
      callback(ranges, change);
      return ranges.map(({ id }) => ({ id, range: buffer.getRange() }));
    },
  });
  const marker = layer.markRange(buffer.getRange(), { invalidate: "never" });
  return { layer, marker };
}

const twoEdits = [
  {
    range: [
      [0, 0],
      [0, 3],
    ],
    text: "LONG\n",
  },
  {
    range: [
      [2, 0],
      [2, 3],
    ],
    text: "2",
  },
];

test("streamed edits expose intermediate live text to custom trackers and preserve undo", async () => {
  const source = "one\r\nmiddle\ntwo\r\n";
  const buffer = new TextBuffer(source);
  const seen = [];
  const { marker } = trackDocument(buffer, () => seen.push(buffer.getText()));
  const gap = buffer.addMarkerLayer().markRange(
    [
      [1, 0],
      [1, 6],
    ],
    { invalidate: "touch" },
  );
  try {
    const before = marker.getRange();
    assert.equal(await buffer.applyTextEdits(twoEdits), 2);
    assert.deepEqual(seen, ["LONG\n\r\nmiddle\ntwo\r\n", "LONG\n\r\nmiddle\n2\r\n"]);
    assert.equal(gap.isValid(), true);
    assert.deepEqual(gap.getRange().serialize(), [
      [2, 0],
      [2, 6],
    ]);
    const after = marker.getRange();
    assert.equal(buffer.undo(), true);
    assert.equal(buffer.getText(), source);
    assert.deepEqual(marker.getRange(), before);
    assert.equal(gap.isValid(), true);
    assert.equal(buffer.undo(), false);
    assert.equal(buffer.redo(), true);
    assert.equal(buffer.getText(), "LONG\n\r\nmiddle\n2\r\n");
    assert.deepEqual(marker.getRange(), after);
    assert.equal(gap.isValid(), true);
  } finally {
    buffer.destroy();
  }
});

test("custom-tracker replay preserves edits which create and replace CRLF boundaries", async () => {
  const source = "A\nB\r\nC\n";
  const buffer = new TextBuffer(source);
  const seen = [];
  trackDocument(buffer, () => seen.push(buffer.getText()));
  try {
    assert.equal(
      await buffer.applyTextEdits([
        {
          range: [
            [0, 1],
            [0, 1],
          ],
          text: "\r",
        },
        {
          range: [
            [1, 1],
            [2, 0],
          ],
          text: "\n",
        },
      ]),
      2,
    );
    assert.deepEqual(seen, ["A\r\nB\r\nC\n", "A\r\nB\nC\n"]);
    buffer.undo();
    assert.equal(buffer.getText(), source);
    buffer.redo();
    assert.equal(buffer.getText(), "A\r\nB\nC\n");
  } finally {
    buffer.destroy();
  }
});

test("custom trackers replay beyond the bounded syntax journal without consuming the producer twice", async () => {
  const count = 4100;
  const source = "x\n".repeat(count);
  const buffer = new TextBuffer(source);
  let iterations = 0;
  let produced = 0;
  let callbacks = 0;
  let firstTail;
  trackDocument(buffer, () => {
    callbacks++;
    if (callbacks === 1) firstTail = buffer.lineForRow(count - 1);
  });
  const edits = {
    [Symbol.asyncIterator]() {
      assert.equal(++iterations, 1);
      return (async function* () {
        for (let row = 0; row < count; row++) {
          produced++;
          yield {
            range: [
              [row, 0],
              [row, 1],
            ],
            text: "yy",
          };
        }
      })();
    },
  };
  try {
    assert.equal(await buffer.applyTextEdits(edits), count);
    assert.equal(produced, count);
    assert.equal(callbacks, count);
    assert.equal(firstTail, "x");
    assert.equal(buffer.getText(), "yy\n".repeat(count));
    assert.equal(buffer.undo(), true);
    assert.equal(buffer.getText(), source);
    assert.equal(buffer.undo(), false);
  } finally {
    buffer.destroy();
  }
});

for (const kind of ["cancel", "text", "marker", "tracker", "producer"]) {
  test(`custom-tracker preparation leaves live state intact on ${kind} failure`, async () => {
    const source = "one\r\nmiddle\ntwo\r\n";
    const buffer = new TextBuffer(source);
    const entered = deferred();
    const resume = deferred();
    const controller = new AbortController();
    let callbacks = 0;
    const { layer, marker } = trackDocument(buffer, () => callbacks++);
    try {
      const pending = buffer.applyTextEdits(
        (async function* () {
          yield twoEdits[0];
          entered.resolve();
          await resume.promise;
          if (kind === "producer") throw new Error("Producer failed");
          yield twoEdits[1];
        })(),
        { signal: controller.signal },
      );
      await entered.promise;
      assert.equal(callbacks, 0);
      assert.equal(buffer.getText(), source);
      if (kind === "cancel") controller.abort();
      if (kind === "text") buffer.insert([1, 0], "user ");
      if (kind === "marker")
        marker.setRange([
          [0, 0],
          [0, 1],
        ]);
      if (kind === "tracker") layer.setRangeTracker((ranges) => ranges);
      const expectedText = buffer.getText();
      const expectedRange = marker.getRange();
      callbacks = 0;
      resume.resolve();
      await assert.rejects(pending, (error) =>
        kind === "cancel"
          ? error.name === "AbortError"
          : kind === "producer"
            ? error.message === "Producer failed"
            : error.code === "ERR_STALE_EDIT",
      );
      assert.equal(callbacks, 0);
      assert.equal(buffer.getText(), expectedText);
      assert.deepEqual(marker.getRange(), expectedRange);
    } finally {
      resume.resolve();
      buffer.destroy();
    }
  });
}

test("a failed streamed-edit finalizer rolls custom-tracker text and marker changes back", async () => {
  const source = "one\r\nmiddle\ntwo\r\n";
  const buffer = new TextBuffer(source);
  const { marker } = trackDocument(buffer);
  const before = marker.getRange();
  try {
    await assert.rejects(
      buffer.applyTextEdits(twoEdits, {
        didCommit() {
          marker.setRange([
            [0, 0],
            [0, 1],
          ]);
          throw new Error("Finalizer failed");
        },
      }),
      (error) => error.message === "Finalizer failed" && error.committed !== true,
    );
    assert.equal(buffer.getText(), source);
    assert.deepEqual(marker.getRange(), before);
    assert.equal(marker.isValid(), true);
    assert.equal(buffer.undo(), false);
  } finally {
    buffer.destroy();
  }
});

test("custom-tracker publication rechecks markers changed by a will-change observer", async () => {
  const source = "one\r\nmiddle\ntwo\r\n";
  const buffer = new TextBuffer(source);
  let callbacks = 0;
  const { layer } = trackDocument(buffer, () => callbacks++);
  const replacementTracker = (ranges) => ranges;
  const subscription = buffer.onWillChange(() => layer.setRangeTracker(replacementTracker));
  try {
    await assert.rejects(buffer.applyTextEdits(twoEdits), { code: "ERR_STALE_EDIT" });
    assert.equal(buffer.getText(), source);
    assert.equal(callbacks, 0);
    assert.equal(buffer.undo(), false);
  } finally {
    subscription.dispose();
    buffer.destroy();
  }
});
