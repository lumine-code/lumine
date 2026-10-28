const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const TextStore = require("../../src/text-store");
const TextChangeMap = require("../../src/text-change-map");
const DefaultHistoryProvider = require("../../src/default-history-provider");
const publish = require("../../src/prepared-input-publication");
const { Writable } = require("node:stream");

async function candidate(buffer, mutate) {
  const draft = new TextBuffer({ text: buffer.getTextSnapshot() });
  const checkpoint = draft.createCheckpoint();
  const appliedChanges = [];
  draft.onDidApplyChanges((batch) => appliedChanges.push(...batch.changes));
  await mutate(draft);
  const changes = draft.historyProvider.getChangesSinceCheckpoint(checkpoint);
  return {
    buffer,
    changes,
    appliedChanges,
    coordinateMap: changes.coordinateMap ?? TextChangeMap.fromChanges(changes),
    finalSource: draft.getTextSnapshot(),
    check() {},
    finalize() {},
    dispose: () => draft.destroy(),
  };
}

test("sparse prepared edits update only local layout and notify observers after the complete transaction", async (t) => {
  const text = "value = 1\n".repeat(1200);
  const buffer = new TextBuffer(text);
  const display = buffer.addDisplayLayer({ softWrapColumn: 5 });
  display.getScreenLineCount();
  const spans = [];
  const update = display.updateSpatialIndex;
  t.mock.method(display, "updateSpatialIndex", function (start, oldEnd, newEnd, ...args) {
    spans.push(Math.max(oldEnd, newEnd) - start);
    return update.call(this, start, oldEnd, newEnd, ...args);
  });
  const input = await candidate(buffer, async (draft) => {
    for (const row of [1190, 600, 10]) draft.insert([row, 9], "\n");
    await draft.applyTextEdits(
      [11, 602, 1193].map((row) => ({
        range: [
          [row, 0],
          [row, 0],
        ],
        text: "  ",
      })),
    );
  });
  assert.equal(
    input.changes.length,
    1,
    "Indentation can coalesce distant changes into one history span",
  );
  const publications = [];
  buffer.onDidApplyChanges(() => publications.push(buffer.getTextSnapshot()));
  display.onDidChange(() => publications.push(buffer.getTextSnapshot()));
  try {
    await publish(input);
    assert.ok(spans.length >= 3);
    assert.ok(
      spans.every((span) => span <= 3),
      JSON.stringify(spans),
    );
    assert.ok(publications.length > 0);
    assert.ok(publications.every((snapshot) => snapshot.equals(input.finalSource)));
    const reference = new TextBuffer({ text: input.finalSource });
    try {
      const fresh = reference.addDisplayLayer({ softWrapColumn: 5 });
      assert.equal(display.getScreenLineCount(), fresh.getScreenLineCount());
      for (const row of [10, 11, 601, 602, 1192, 1193])
        assert.deepEqual(
          display.translateBufferPosition([row, 2]),
          fresh.translateBufferPosition([row, 2]),
        );
    } finally {
      reference.destroy();
    }
    buffer.undo();
    assert.equal(buffer.getText(), text);
    buffer.redo();
    assert.ok(buffer.getTextSnapshot().equals(input.finalSource));
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

test("a later sparse layout observer failure still finishes every edit and history", async (t) => {
  const text = "value\n".repeat(1200);
  const buffer = new TextBuffer(text);
  const input = await candidate(buffer, (draft) => {
    for (const row of [1190, 600, 10]) draft.insert([row, 5], "\n");
  });
  const prepare = buffer.prepareDisplayLayersForChange;
  let count = 0;
  t.mock.method(buffer, "prepareDisplayLayersForChange", function (...args) {
    if (++count === 2) throw new Error("projection observer failed");
    return prepare.apply(this, args);
  });
  try {
    await assert.rejects(publish(input), { code: "ERR_EDIT_OBSERVER_FAILED", committed: true });
    assert.equal(count, 3);
    assert.ok(buffer.getTextSnapshot().equals(input.finalSource));
    buffer.undo();
    assert.equal(buffer.getText(), text);
    buffer.redo();
    assert.ok(buffer.getTextSnapshot().equals(input.finalSource));
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

for (const observerThrows of [false, true])
  test(`history wrappers can be released after publication without changing the transaction owner (${observerThrows})`, async () => {
    const buffer = new TextBuffer("abc");
    const original = buffer.historyProvider;
    let grouped = false;
    const wrapper = new Proxy(original, {
      get(target, key) {
        if (key === "groupChangesSinceCheckpoint")
          return (...args) => {
            assert.equal(buffer.historyProvider, wrapper);
            grouped = true;
            return target.groupChangesSinceCheckpoint(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    buffer.setHistoryProvider(wrapper);
    const marker = buffer.markPosition([0, 0]);
    const input = await candidate(buffer, (draft) => draft.insert([0, 3], "\n  "));
    input.finalize = () => marker.setHeadPosition([1, 2]);
    const subscription = marker.onDidChange(() => {
      assert.equal(buffer.getText(), "abc\n  ");
      assert.equal(grouped, false);
      buffer.setHistoryProvider(original);
      assert.equal(buffer.historyProvider, wrapper);
      if (observerThrows) throw new Error("observer failed after releasing history");
    });
    try {
      if (observerThrows)
        await assert.rejects(publish(input), { code: "ERR_EDIT_OBSERVER_FAILED", committed: true });
      else await publish(input);
      assert.equal(grouped, true);
      assert.equal(buffer.historyProvider, original);
      subscription.dispose();
      buffer.undo();
      assert.equal(buffer.getText(), "abc");
      buffer.redo();
      assert.equal(buffer.getText(), "abc\n  ");
    } finally {
      subscription.dispose();
      input.dispose();
      buffer.destroy();
    }
  });

test("prepared input tracks intermediate live text and publishes one final batch", async () => {
  const buffer = new TextBuffer("abc\ntail");
  const tracked = [];
  const layer = buffer.addMarkerLayer({
    trackRanges(ranges, change) {
      tracked.push([buffer.getText(), change.newText]);
      return ranges;
    },
  });
  const marker = layer.markRange(
    [
      [0, 0],
      [1, 4],
    ],
    { invalidate: "never" },
  );
  const seen = [];
  buffer.onDidApplyChanges((batch) => seen.push([buffer.getText(), batch.changes.length]));
  const input = await candidate(buffer, (draft) => {
    draft.insert([0, 3], "\n");
    draft.insert([1, 0], "  ");
  });
  try {
    await publish(input);
    assert.deepEqual(tracked, [
      ["abc\n\ntail", "\n"],
      ["abc\n  \ntail", "  "],
    ]);
    assert.deepEqual(seen, [["abc\n  \ntail", 2]]);
    assert.equal(layer.getMarker(marker.id), marker);
    buffer.undo();
    assert.equal(buffer.getText(), "abc\ntail");
    buffer.redo();
    assert.equal(buffer.getText(), "abc\n  \ntail");
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

for (const mutateFirst of [false, true])
  test(`history refusal leaves roots, markers and both history stacks intact (${mutateFirst})`, async () => {
    const buffer = new TextBuffer("abc");
    class RefusingHistory extends DefaultHistoryProvider {
      pushPatch(patch) {
        if (this.refuse) {
          if (mutateFirst) super.pushPatch(patch);
          throw new Error("history refused");
        }
        return super.pushPatch(patch);
      }
    }
    const history = new RefusingHistory(buffer);
    buffer.setHistoryProvider(history);
    buffer.insert([0, 3], "x");
    buffer.undo();
    const marker = buffer.markRange(
      [
        [0, 0],
        [0, 3],
      ],
      { invalidate: "inside" },
    );
    const before = buffer.getTextSnapshot();
    const revision = buffer.getTextRevision();
    const undo = history.undoStack.slice(),
      redo = history.redoStack.slice();
    const seen = [];
    buffer.onDidApplyChanges((batch) => seen.push(batch));
    const input = await candidate(buffer, (draft) => draft.insert([0, 1], "\n  "));
    history.refuse = true;
    try {
      await assert.rejects(publish(input), /history refused/);
      assert.equal(buffer.getTextSnapshot(), before);
      assert.equal(buffer.getTextRevision(), revision);
      assert.equal(marker.isValid(), true);
      assert.deepEqual(marker.getRange().serialize(), [
        [0, 0],
        [0, 3],
      ]);
      assert.deepEqual(history.undoStack, undo);
      assert.deepEqual(history.redoStack, redo);
      assert.deepEqual(seen, []);
      assert.equal(buffer.atomicEditContext, null);
      history.refuse = false;
      buffer.redo();
      assert.equal(buffer.getText(), "abcx");
    } finally {
      input.dispose();
      buffer.destroy();
    }
  });

test("a later storage preparation failure never changes live roots or marker lifecycles", async () => {
  const buffer = new TextBuffer("abc");
  const layer = buffer.addMarkerLayer({ destroyInvalidatedMarkers: true });
  const marker = layer.markRange(
    [
      [0, 0],
      [0, 3],
    ],
    { invalidate: "inside" },
  );
  const input = await candidate(buffer, (draft) => {
    draft.insert([0, 1], "\n");
    draft.insert([1, 0], "  ");
  });
  const original = TextStore.prototype.prepareEditFromChange;
  let prepared = 0,
    destroyed = false;
  marker.onDidDestroy(() => {
    destroyed = true;
  });
  TextStore.prototype.prepareEditFromChange = function (...args) {
    const edit = original.apply(this, args);
    if (++prepared === 2)
      edit.commit = () => {
        throw new Error("storage refused");
      };
    return edit;
  };
  try {
    await assert.rejects(publish(input), /storage refused/);
    assert.equal(buffer.getText(), "abc");
    assert.equal(buffer.getTextRevision(), 0);
    assert.equal(marker.isValid(), true);
    assert.equal(destroyed, false);
    assert.equal(buffer.undo(), false);
    assert.equal(buffer.buffer.isModified(), false);
  } finally {
    TextStore.prototype.prepareEditFromChange = original;
    input.dispose();
    buffer.destroy();
  }
});

test("throwing destruction observers see the completed input and cannot undo its publication", async () => {
  const buffer = new TextBuffer("abc\ntail");
  const layer = buffer.addMarkerLayer({ destroyInvalidatedMarkers: true });
  const marker = layer.markRange(
    [
      [0, 0],
      [0, 3],
    ],
    { invalidate: "inside" },
  );
  const following = buffer.markPosition([1, 1], { invalidate: "never" });
  const seen = [];
  marker.onDidDestroy(() => {
    seen.push(buffer.getText());
    buffer.undo();
  });
  const input = await candidate(buffer, (draft) => {
    draft.insert([0, 1], "\n");
    draft.insert([1, 0], "  ");
  });
  try {
    await assert.rejects(publish(input), (error) => error.committed === true);
    assert.equal(buffer.getText(), "a\n  bc\ntail");
    assert.deepEqual(seen, ["a\n  bc\ntail"]);
    assert.deepEqual(following.getHeadPosition().serialize(), [2, 1]);
    buffer.undo();
    assert.equal(buffer.getText(), "abc\ntail");
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

test("compressed indentation journals preserve annotations in unchanged gaps", async () => {
  const buffer = new TextBuffer("row\ngap\n".repeat(4200));
  const marker = buffer.markRange(
    [
      [3999, 1],
      [3999, 2],
    ],
    { invalidate: "inside" },
  );
  const before = marker.getRange().serialize();
  const original = buffer.getTextSnapshot();
  const input = await candidate(buffer, (draft) =>
    draft.applyTextEdits(
      Array.from({ length: 4200 }, (_, row) => ({
        range: [
          [row * 2, 0],
          [row * 2, 0],
        ],
        text: "  ",
      })),
    ),
  );
  try {
    assert.equal(input.appliedChanges.length, 1);
    assert.ok(input.appliedChanges[0].coordinateMap.runs);
    await publish(input);
    assert.equal(marker.isValid(), true);
    assert.deepEqual(marker.getRange().serialize(), before);
    assert.equal(buffer.getTextSnapshot().equals(input.finalSource), true);
    buffer.undo();
    assert.equal(buffer.getTextSnapshot().equals(original), true);
    assert.deepEqual(marker.getRange().serialize(), before);
    assert.equal(marker.isValid(), true);
    buffer.redo();
    assert.equal(buffer.getTextSnapshot().equals(input.finalSource), true);
    assert.deepEqual(marker.getRange().serialize(), before);
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

test("prepared storage rebases modified-state patches when a save finishes before publication", async () => {
  const store = new TextStore("saved");
  store.setText("abc");
  const draft = new TextBuffer("abc");
  const edits = [];
  draft.onDidApplyChanges((batch) => edits.push(...batch.changes));
  draft.insert([0, 1], "x");
  const prepared = await store.preparePublication(edits);
  try {
    await store.save(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    );
    assert.equal(store.isModified(), false);
    prepared.validate();
    for (const edit of prepared.edits) edit.commit();
    assert.equal(store.getText(), "axbc");
    assert.equal(store.isModified(), true);
    store.setText("abc");
    assert.equal(store.isModified(), false);
  } finally {
    prepared.dispose();
    draft.destroy();
  }
});

test("physical CRLF boundaries survive prepared local replay and history", async () => {
  const buffer = new TextBuffer("abc\ndef\r\nend");
  const original = buffer.getText();
  const input = await candidate(buffer, (draft) => {
    draft.insert([0, 3], "\r", { normalizeLineEndings: false });
    draft.insert([1, 3], "\n  ", { normalizeLineEndings: false });
  });
  try {
    await publish(input);
    assert.equal(buffer.getTextSnapshot().equals(input.finalSource), true);
    buffer.undo();
    assert.equal(buffer.getText(), original);
    buffer.redo();
    assert.equal(buffer.getTextSnapshot().equals(input.finalSource), true);
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

test("cancellation during storage preparation leaves public state and history unchanged", async () => {
  const buffer = new TextBuffer("x\n".repeat(1000));
  const input = await candidate(buffer, (draft) => {
    for (let row = 0; row < 1000; row++) draft.insert([row, 0], " ");
  });
  let checks = 0;
  input.check = () => {
    if (++checks === 70) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  };
  const original = buffer.getTextSnapshot();
  try {
    await assert.rejects(publish(input), { name: "AbortError" });
    assert.equal(buffer.getTextSnapshot(), original);
    assert.equal(buffer.getTextRevision(), 0);
    assert.equal(buffer.undo(), false);
  } finally {
    input.dispose();
    buffer.destroy();
  }
});

test("pre-change cancellation does not suppress independently changed marker notifications", async () => {
  const buffer = new TextBuffer("abc");
  const marker = buffer.markPosition([0, 0]);
  const seen = [];
  marker.onDidChange(() => seen.push(marker.getHeadPosition().serialize()));
  const input = await candidate(buffer, (draft) => draft.insert([0, 1], "x"));
  let changed = false;
  buffer.onWillChange(() => {
    marker.setHeadPosition([0, 2]);
    changed = true;
  });
  input.check = () => {
    if (changed) throw new Error("owner changed");
  };
  try {
    await assert.rejects(publish(input), /owner changed/);
    assert.equal(buffer.getText(), "abc");
    assert.deepEqual(seen, [[0, 2]]);
    assert.equal(buffer.undo(), false);
  } finally {
    input.dispose();
    buffer.destroy();
  }
});
