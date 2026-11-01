const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");

function trackDocument(buffer, seen) {
  const layer = buffer.addMarkerLayer({
    maintainHistory: true,
    trackRanges(entries, change) {
      seen.push({ text: buffer.getText(), inserted: change.newText });
      return entries.map(({ id }) => ({ id, range: buffer.getRange() }));
    },
  });
  return { layer, marker: layer.markRange(buffer.getRange(), { invalidate: "never" }) };
}

function observeFinal(buffers, marker, seen) {
  const read = () => seen.push(buffers.map((buffer) => buffer.getText()));
  const subscriptions = buffers.flatMap((buffer) => [
    buffer.onDidChangeText(read),
    buffer.onDidApplyChanges(read),
  ]);
  subscriptions.push(marker.onDidChange(read));
  return () => subscriptions.forEach((subscription) => subscription.dispose());
}

test("replaceAllMatches gives custom trackers live intermediate text and publishes final state once", async () => {
  const before = "x\r\ngap\nx\r\n";
  const after = "LONG\n\r\ngap\nLONG\n\r\n";
  const buffer = new TextBuffer(before);
  const tracked = [],
    seen = [],
    finalizers = [];
  const { marker } = trackDocument(buffer, tracked);
  const gap = buffer.addMarkerLayer({ maintainHistory: true }).markRange(
    [
      [1, 0],
      [1, 3],
    ],
    { invalidate: "touch" },
  );
  const originalRange = marker.getRange();
  const stop = observeFinal([buffer], marker, seen);
  try {
    assert.equal(
      await buffer.replaceAllMatches(/x/g, "LONG\n", {
        didCommit: () => finalizers.push(buffer.getText()),
      }),
      2,
    );
    assert.deepEqual(tracked, [
      { text: "LONG\n\r\ngap\nx\r\n", inserted: "LONG\n" },
      { text: after, inserted: "LONG\n" },
    ]);
    assert.deepEqual(finalizers, [after]);
    assert.ok(seen.length >= 3);
    assert.ok(seen.every((texts) => texts.length === 1 && texts[0] === after));
    assert.equal(gap.isValid(), true);
    assert.deepEqual(gap.getRange().serialize(), [
      [2, 0],
      [2, 3],
    ]);
    const finalRange = marker.getRange();
    stop();
    assert.equal(buffer.undo(), true);
    assert.equal(buffer.getText(), before);
    assert.deepEqual(marker.getRange(), originalRange);
    assert.equal(gap.isValid(), true);
    assert.deepEqual(gap.getRange().serialize(), [
      [1, 0],
      [1, 3],
    ]);
    assert.equal(buffer.undo(), false);
    assert.equal(buffer.redo(), true);
    assert.equal(buffer.getText(), after);
    assert.deepEqual(marker.getRange(), finalRange);
    assert.equal(gap.isValid(), true);
  } finally {
    stop();
    buffer.destroy();
  }
});

test("prepared replacements coordinate tracked and ordinary buffers before public observers", async () => {
  const buffers = [new TextBuffer("x gap x"), new TextBuffer("x\r\nx"), new TextBuffer("x tail")];
  const expected = ["long gap long", "long\r\nlong", "long tail"];
  const tracked = [[], []],
    seen = [],
    finalizers = [];
  const markers = buffers
    .slice(0, 2)
    .map((buffer, index) => trackDocument(buffer, tracked[index]).marker);
  const stop = observeFinal(buffers, markers[0], seen);
  let plans;
  try {
    plans = await Promise.all(
      buffers.map((buffer) => buffer.prepareReplaceAllMatches(/x/g, "long")),
    );
    assert.deepEqual(tracked, [[], []]);
    assert.deepEqual(
      buffers.map((buffer) => buffer.getText()),
      ["x gap x", "x\r\nx", "x tail"],
    );
    assert.equal(
      TextBuffer.commitPreparedReplacements(plans, {
        didCommit: () => finalizers.push(buffers.map((buffer) => buffer.getText())),
      }),
      5,
    );
    assert.deepEqual(
      tracked.map((entries) => entries.map((entry) => entry.text)),
      [
        ["long gap x", "long gap long"],
        ["long\r\nx", "long\r\nlong"],
      ],
    );
    assert.deepEqual(finalizers, [expected]);
    assert.ok(seen.length >= 7);
    for (const texts of seen) assert.deepEqual(texts, expected);
    assert.ok(plans.every((plan) => plan.snapshot === null));
    stop();
    for (const buffer of buffers) {
      assert.equal(buffer.undo(), true);
      assert.equal(buffer.undo(), false);
    }
    assert.deepEqual(
      buffers.map((buffer) => buffer.getText()),
      ["x gap x", "x\r\nx", "x tail"],
    );
    for (const buffer of buffers) assert.equal(buffer.redo(), true);
    assert.deepEqual(
      buffers.map((buffer) => buffer.getText()),
      expected,
    );
  } finally {
    stop();
    for (const plan of plans ?? []) plan.dispose();
    for (const buffer of buffers) buffer.destroy();
  }
});

for (const kind of ["cancel", "marker", "tracker", "text"])
  test(`a ${kind} change invalidates a prepared tracked replacement without further mutation`, async () => {
    const buffer = new TextBuffer("x gap x");
    const tracked = [],
      seen = [];
    const { layer, marker } = trackDocument(buffer, tracked);
    const controller = new AbortController();
    let plan;
    try {
      plan = await buffer.prepareReplaceAllMatches(/x/g, "long", { signal: controller.signal });
      if (kind === "cancel") controller.abort();
      else if (kind === "marker")
        marker.setRange([
          [0, 2],
          [0, 5],
        ]);
      else if (kind === "tracker") layer.setRangeTracker((entries) => entries);
      else buffer.insert([0, 0], "user ");
      const text = buffer.getText(),
        range = marker.getRange(),
        revision = buffer.getTextRevision();
      tracked.length = 0;
      const subscription = buffer.onDidChangeText(() => seen.push(buffer.getText()));
      try {
        assert.throws(
          () => plan.commit(),
          (error) =>
            kind === "cancel"
              ? error.name === "AbortError"
              : ["ERR_STALE_EDIT", "ERR_STALE_SEARCH"].includes(error.code),
        );
      } finally {
        subscription.dispose();
      }
      assert.equal(buffer.getText(), text);
      assert.equal(buffer.getTextRevision(), revision);
      assert.deepEqual(marker.getRange(), range);
      assert.deepEqual(tracked, []);
      assert.deepEqual(seen, []);
      if (kind !== "text") assert.equal(buffer.undo(), false);
    } finally {
      plan?.dispose();
      buffer.destroy();
    }
  });

for (const mutateFirst of [false, true])
  test(`tracked multi-buffer history refusal restores every history stack before callbacks (${mutateFirst})`, async () => {
    const buffers = [new TextBuffer("x gap x"), new TextBuffer("x tail")];
    const tracked = [[], []],
      seen = [];
    const markers = buffers.map((buffer, index) => trackDocument(buffer, tracked[index]).marker);
    for (const buffer of buffers) {
      buffer.append("!");
      buffer.undo();
    }
    const before = buffers.map((buffer, index) => ({
      snapshot: buffer.getTextSnapshot(),
      revision: buffer.getTextRevision(),
      range: markers[index].getRange(),
      undo: buffer.historyProvider.undoStack.slice(),
      redo: buffer.historyProvider.redoStack.slice(),
    }));
    for (const entries of tracked) entries.length = 0;
    const plans = await Promise.all(
      buffers.map((buffer) => buffer.prepareReplaceAllMatches(/x/g, "long")),
    );
    const stop = observeFinal(buffers, markers[0], seen);
    const history = buffers[1].historyProvider;
    const pushPatch = history.pushPatch;
    history.pushPatch = function (patch) {
      if (mutateFirst) pushPatch.call(this, patch);
      throw new Error("history refused");
    };
    try {
      assert.throws(() => TextBuffer.commitPreparedReplacements(plans), /history refused/);
      assert.deepEqual(tracked, [[], []]);
      assert.deepEqual(seen, []);
      for (let index = 0; index < buffers.length; index++) {
        const buffer = buffers[index];
        assert.equal(buffer.getTextSnapshot(), before[index].snapshot);
        assert.equal(buffer.getTextRevision(), before[index].revision);
        assert.deepEqual(markers[index].getRange(), before[index].range);
        assert.deepEqual(buffer.historyProvider.undoStack, before[index].undo);
        assert.deepEqual(buffer.historyProvider.redoStack, before[index].redo);
        assert.equal(buffer.atomicEditContext, null);
      }
      history.pushPatch = pushPatch;
      stop();
      for (const buffer of buffers) assert.equal(buffer.redo(), true);
      assert.deepEqual(
        buffers.map((buffer) => buffer.getText()),
        ["x gap x!", "x tail!"],
      );
    } finally {
      history.pushPatch = pushPatch;
      stop();
      for (const plan of plans) plan.dispose();
      for (const buffer of buffers) buffer.destroy();
    }
  });

test("tracked replacement observer failure reports complete publication and continues other buffers", async () => {
  const buffers = [new TextBuffer("x gap x"), new TextBuffer("x tail")];
  const tracked = [],
    seen = [],
    finalizers = [];
  const { marker } = trackDocument(buffers[0], tracked);
  const stop = observeFinal(buffers, marker, seen);
  const failure = new Error("change observer failed");
  const subscription = buffers[0].onDidApplyChanges(() => {
    throw failure;
  });
  let plans;
  try {
    plans = await Promise.all(
      buffers.map((buffer) => buffer.prepareReplaceAllMatches(/x/g, "long")),
    );
    assert.throws(
      () =>
        TextBuffer.commitPreparedReplacements(plans, {
          didCommit: () => finalizers.push(buffers.map((buffer) => buffer.getText())),
        }),
      (error) =>
        error.code === "ERR_REPLACE_OBSERVER_FAILED" &&
        error.committed === true &&
        error.replacementCount === 3 &&
        error.cause.errors.includes(failure),
    );
    const expected = ["long gap long", "long tail"];
    assert.deepEqual(finalizers, [expected]);
    assert.ok(seen.length >= 5);
    for (const texts of seen) assert.deepEqual(texts, expected);
    assert.deepEqual(
      tracked.map((entry) => entry.text),
      ["long gap x", "long gap long"],
    );
    for (const buffer of buffers) assert.equal(buffer.atomicEditContext, null);
    subscription.dispose();
    stop();
    for (const buffer of buffers) assert.equal(buffer.undo(), true);
    assert.deepEqual(
      buffers.map((buffer) => buffer.getText()),
      ["x gap x", "x tail"],
    );
  } finally {
    subscription.dispose();
    stop();
    for (const plan of plans ?? []) plan.dispose();
    for (const buffer of buffers) buffer.destroy();
  }
});

test("a tracked replaceAllMatches finalizer failure reports committed text and keeps one undo step", async () => {
  const buffer = new TextBuffer("x gap x");
  const tracked = [],
    seen = [],
    finalizers = [];
  const { marker } = trackDocument(buffer, tracked);
  const originalRange = marker.getRange();
  const stop = observeFinal([buffer], marker, seen);
  const failure = new Error("model finalizer failed");
  try {
    await assert.rejects(
      buffer.replaceAllMatches(/x/g, "long", {
        didCommit() {
          finalizers.push(buffer.getText());
          throw failure;
        },
      }),
      (error) =>
        error.code === "ERR_REPLACE_OBSERVER_FAILED" &&
        error.committed === true &&
        error.replacementCount === 2 &&
        error.cause.errors.includes(failure),
    );
    assert.deepEqual(finalizers, ["long gap long"]);
    assert.ok(seen.length >= 3);
    for (const texts of seen) assert.deepEqual(texts, ["long gap long"]);
    stop();
    assert.equal(buffer.undo(), true);
    assert.equal(buffer.getText(), "x gap x");
    assert.deepEqual(marker.getRange(), originalRange);
    assert.equal(buffer.undo(), false);
    assert.equal(buffer.redo(), true);
    assert.equal(buffer.getText(), "long gap long");
  } finally {
    stop();
    buffer.destroy();
  }
});
