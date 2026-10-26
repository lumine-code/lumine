const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");

async function pair() {
  const left = new TextBuffer("x gap x"),
    right = new TextBuffer("x tail");
  const marker = left.markRange(
    [
      [0, 2],
      [0, 5],
    ],
    { invalidate: "never" },
  );
  const plans = await Promise.all([
    left.prepareReplaceAllMatches(/x/g, "long"),
    right.prepareReplaceAllMatches(/x/g, "long"),
  ]);
  return { left, right, marker, plans };
}

test("prepared batch publishes every root and exact marker geometry before callbacks", async () => {
  const { left, right, marker, plans } = await pair();
  const seen = [];
  marker.onDidChange(() =>
    seen.push([left.getText(), right.getText(), marker.getRange().serialize()]),
  );
  right.onDidChangeText(() =>
    seen.push([left.getText(), right.getText(), marker.getRange().serialize()]),
  );
  assert.equal(TextBuffer.commitPreparedReplacements(plans), 3);
  assert.deepEqual(
    seen,
    Array(2).fill([
      "long gap long",
      "long tail",
      [
        [0, 5],
        [0, 8],
      ],
    ]),
  );
  assert.equal(plans[0].snapshot, null);
  left.undo();
  right.undo();
  assert.equal(left.getText(), "x gap x");
  assert.equal(right.getText(), "x tail");
  left.destroy();
  right.destroy();
});

test("cross-buffer will-change mutation, last-plan cancellation and stale markers abort before publication", async () => {
  for (const mode of ["edit", "cancel", "marker"]) {
    const { left, right, marker, plans } = await pair(),
      controller = new AbortController();
    right.onWillChange(() => {
      if (mode === "edit") left.setText("bad");
      else if (mode === "cancel") controller.abort();
      else
        marker.setRange([
          [0, 0],
          [0, 1],
        ]);
    });
    assert.throws(() =>
      TextBuffer.commitPreparedReplacements(plans, { signal: controller.signal }),
    );
    assert.equal(left.getText(), "x gap x");
    assert.equal(right.getText(), "x tail");
    assert.equal(left.undo(), false);
    assert.equal(right.undo(), false);
    left.destroy();
    right.destroy();
  }
});

test("observer failures keep all roots committed and flush other participants with locks and emitter methods restored", async () => {
  const { left, right, marker, plans } = await pair();
  const original = left.emitter.emit;
  let reached = false;
  marker.onDidChange(() => right.undo());
  left.onDidChangeText(() => right.destroy());
  right.onDidChangeText(() => {
    reached = true;
    assert.equal(left.getText(), "long gap long");
  });
  assert.throws(
    () => TextBuffer.commitPreparedReplacements(plans),
    (error) => error.committed === true && error.replacementCount === 3,
  );
  assert.equal(reached, true);
  assert.equal(right.isDestroyed(), false);
  assert.equal(left.emitter.emit, original);
  assert.equal(left.getText(), "long gap long");
  assert.equal(right.getText(), "long tail");
  left.emitter.clear();
  right.emitter.clear();
  marker.emitter.clear();
  left.undo();
  right.undo();
  assert.equal(left.getText(), "x gap x");
  assert.equal(right.getText(), "x tail");
  left.destroy();
  right.destroy();
});

test("a storage commit or history preparation failure restores all roots and history before observation", async () => {
  for (const mode of ["storage", "history"]) {
    const { left, right, plans } = await pair();
    let observed = false;
    left.onDidChangeText(() => {
      observed = true;
    });
    if (mode === "history")
      right.historyProvider.pushPatch = () => {
        throw new Error("history refused");
      };
    else {
      const prepare = right.buffer.prepareEdit.bind(right.buffer);
      right.buffer.prepareEdit = (...args) => {
        const edit = prepare(...args);
        edit.commit = () => {
          throw new Error("storage refused");
        };
        return edit;
      };
    }
    assert.throws(() => TextBuffer.commitPreparedReplacements(plans), /refused/);
    assert.equal(left.getText(), "x gap x");
    assert.equal(right.getText(), "x tail");
    assert.equal(observed, false);
    assert.equal(left.undo(), false);
    assert.equal(right.undo(), false);
    left.destroy();
    right.destroy();
  }
});

test("a model finalizer failure reports complete text publication rather than rollback", async () => {
  const { left, right, plans } = await pair();
  assert.throws(
    () =>
      TextBuffer.commitPreparedReplacements(plans, {
        didCommit() {
          throw new Error("model observer");
        },
      }),
    (error) => error.committed === true,
  );
  assert.equal(left.getText(), "long gap long");
  assert.equal(right.getText(), "long tail");
  left.undo();
  right.undo();
  assert.equal(left.getText(), "x gap x");
  assert.equal(right.getText(), "x tail");
  left.destroy();
  right.destroy();
});
