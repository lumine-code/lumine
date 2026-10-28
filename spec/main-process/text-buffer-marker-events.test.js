const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const markerEvents = require("../../src/text-buffer-marker-events");

test("prepared marker events observe final text and coalesce final marker coordinates", () => {
  const buffer = new TextBuffer("first\nsecond");
  const marker = buffer.markPosition([0, 2], { invalidate: "never" });
  const display = buffer.addDisplayLayer();
  const displayMarker = display.getMarkerLayer(marker.layer.id).getMarker(marker.id);
  const seen = [];
  const errors = [];
  marker.onDidChange((event) => seen.push(["buffer", buffer.getText(), event]));
  displayMarker.onDidChange((event) => seen.push(["display", buffer.getText(), event]));
  const scope = markerEvents.begin(buffer);
  try {
    buffer.transact(() => {
      buffer.insert([0, 2], "\n");
      marker.setHeadPosition([1, 0]);
      buffer.insert([1, 0], "  ");
      marker.setHeadPosition([1, 2]);
    });
    assert.equal(seen.length, 0);
    assert.deepEqual(marker.getHeadPosition().serialize(), [1, 2]);
    scope.flush(errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      seen.map(([type, text]) => [type, text]),
      [
        ["buffer", "fi\n  rst\nsecond"],
        ["display", "fi\n  rst\nsecond"],
      ],
    );
    assert.deepEqual(seen[0][2].oldHeadPosition.serialize(), [0, 2]);
    assert.deepEqual(seen[0][2].newHeadPosition.serialize(), [1, 2]);
    assert.deepEqual(seen[1][2].newHeadBufferPosition.serialize(), [1, 2]);
  } finally {
    scope.dispose();
    buffer.destroy();
  }
});

test("destroyed markers leave live indexes immediately and notify after publication", () => {
  const buffer = new TextBuffer("abc");
  const display = buffer.addDisplayLayer();
  const layer = display.addMarkerLayer({ destroyInvalidatedMarkers: true });
  const marker = layer.markBufferRange(
    [
      [0, 0],
      [0, 3],
    ],
    { invalidate: "inside" },
  );
  const bufferMarker = marker.bufferMarker;
  const seen = [];
  const errors = [];
  marker.onDidDestroy(() => seen.push(["display", buffer.getText()]));
  bufferMarker.onDidDestroy(() => seen.push(["buffer", buffer.getText()]));
  const scope = markerEvents.begin(buffer);
  try {
    buffer.transact(() => {
      buffer.insert([0, 1], "\n");
      assert.equal(marker.isDestroyed(), true);
      assert.equal(layer.markersById.has(marker.id), false);
      assert.equal(layer.getMarkerCount(), 0);
      assert.deepEqual(seen, []);
      buffer.insert([1, 0], "  ");
    });
    scope.flush(errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(seen, [
      ["display", "a\n  bc"],
      ["buffer", "a\n  bc"],
    ]);
    assert.equal(bufferMarker.emitter.listenerCountForEventName("did-destroy"), 0);
    assert.equal(marker.emitter.disposed, true);
    scope.flush(errors);
    assert.equal(seen.length, 2);
  } finally {
    scope.dispose();
    buffer.destroy();
  }
});

test("publication drains appended events after throwing listeners and releases its scope", () => {
  const buffer = new TextBuffer("abc");
  const first = buffer.markPosition([0, 0]);
  const second = buffer.markPosition([0, 1]);
  const failure = new Error("observer failed");
  const seen = [];
  first.onDidDestroy(() => {
    seen.push("first");
    second.destroy();
    throw failure;
  });
  second.onDidDestroy(() => seen.push("second"));
  const errors = [];
  const scope = markerEvents.begin(buffer);
  try {
    first.destroy();
    assert.deepEqual(seen, []);
    scope.flush(errors);
    assert.deepEqual(seen, ["first", "second"]);
    assert.deepEqual(errors, [failure]);
    assert.equal(first.emitter.listenerCountForEventName("did-destroy"), 0);
    assert.equal(second.emitter.listenerCountForEventName("did-destroy"), 0);
  } finally {
    scope.dispose();
  }
  const last = buffer.markPosition([0, 0]);
  last.onDidDestroy(() => seen.push("last"));
  last.destroy();
  assert.deepEqual(seen, ["first", "second", "last"]);
  buffer.destroy();
});

test("deferred changes do not outlive their destroyed marker", () => {
  const buffer = new TextBuffer("abc");
  const marker = buffer.markPosition([0, 0]);
  const changes = [];
  marker.onDidChange((event) => changes.push(event));
  const scope = markerEvents.begin(buffer);
  try {
    marker.setHeadPosition([0, 1]);
    marker.destroy();
    const errors = [];
    scope.flush(errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(changes, []);
  } finally {
    scope.dispose();
    buffer.destroy();
  }
});
