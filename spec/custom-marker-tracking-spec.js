const fs = require("fs");
const TextBuffer = require("../src/text-buffer");
const temp = require("./text-buffer-helpers/temp");

describe("custom marker range tracking", () => {
  let buffer, buffers;
  const keepRanges = (ranges) => ranges;
  const mark = (
    layer,
    range = [
      [0, 0],
      [0, 4],
    ],
    options = {},
  ) => layer.markRange(range, { invalidate: "never", exclusive: true, ...options });

  function spyOnIndex(index, method) {
    const original = index[method].bind(index);
    const spy = jasmine.createSpy(method).and.callFake(original);
    Object.defineProperty(index, method, { configurable: true, value: spy });
    return spy;
  }

  beforeEach(() => {
    jasmine.addCustomEqualityTester(require("@lumine-code/underscore-plus").isEqual);
    buffer = new TextBuffer("spri func\nsecond\n");
    buffers = [buffer];
  });

  afterEach(() => {
    for (const owned of buffers) owned.destroy();
  });

  it("leaves native marker defaults and custom properties independent of tracking", () => {
    const layer = buffer.addMarkerLayer({ trackRanges: keepRanges });
    const marker = layer.markRange(
      [
        [0, 0],
        [0, 4],
      ],
      { kind: "annotation" },
    );
    expect(marker.getInvalidationStrategy()).toBe("overlap");
    expect(marker.isExclusive()).toBe(false);
    expect(marker.getProperties()).toEqual({ kind: "annotation" });
    expect(Object.hasOwn(marker.getSnapshot(marker.getRange(), false), "trackRanges")).toBe(false);
    expect(layer.getRangeTracker()).toBe(keepRanges);
  });

  it("receives sorted immutable pre-edit ranges and applied edit coordinates", () => {
    const calls = [];
    const layer = buffer.addMarkerLayer({
      trackRanges(ranges, change) {
        calls.push({ ranges, change });
        return ranges;
      },
    });
    const smaller = mark(layer, [
      [0, 2],
      [0, 4],
    ]);
    const larger = mark(layer);
    const point = layer.markPosition([0, 3], { invalidate: "never" });
    const untouched = mark(layer, [
      [1, 0],
      [1, 6],
    ]);
    buffer.insert([0, 3], "x\ny");
    expect(calls.length).toBe(1);
    expect(calls[0].ranges.map((entry) => entry.id)).toEqual([larger.id, smaller.id, point.id]);
    expect(calls[0].ranges[0].range).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(calls[0].change.oldRange).toEqual([
      [0, 3],
      [0, 3],
    ]);
    expect(calls[0].change.newRange).toEqual([
      [0, 3],
      [1, 1],
    ]);
    expect(calls[0].change.newText).toBe("x\ny");
    expect(Object.isFrozen(calls[0].ranges)).toBe(true);
    expect(Object.isFrozen(calls[0].change)).toBe(true);
    for (const entry of calls[0].ranges) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.range)).toBe(true);
      expect(Object.isFrozen(entry.range.start)).toBe(true);
      expect(Object.isFrozen(entry.range.end)).toBe(true);
    }
    expect(untouched.getRange()).toEqual([
      [2, 0],
      [2, 6],
    ]);
  });

  it("lets a custom policy retain, replace, or invalidate arbitrary multiline geometry", () => {
    const layer = buffer.addMarkerLayer({
      trackRanges: (ranges) =>
        ranges.map(({ id }) => ({
          id,
          range: [
            [0, 1],
            [1, 3],
          ],
        })),
    });
    const marker = mark(layer);
    buffer.insert([0, 2], "x");
    expect(marker.getRange()).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(marker.isValid()).toBe(true);
    layer.setRangeTracker((ranges) => ranges.map(({ id }) => ({ id, range: null })));
    buffer.insert([1, 2], "x");
    expect(marker.isValid()).toBe(false);
    expect(marker.isDestroyed()).toBe(false);
  });

  it("counts exact boundary contact and leaves untouched ranges to the native index", () => {
    const tracker = jasmine.createSpy("range tracker").and.callFake(keepRanges);
    const layer = buffer.addMarkerLayer({ trackRanges: tracker });
    const marker = mark(layer);
    const later = mark(layer, [
      [1, 0],
      [1, 6],
    ]);
    buffer.insert([0, 4], " ");
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    buffer.insert([0, 4], "\n");
    expect(tracker).toHaveBeenCalledTimes(2);
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(later.getRange()).toEqual([
      [2, 0],
      [2, 6],
    ]);
  });

  it("preserves ordinary invalidation strategies independently of custom geometry", () => {
    const layer = buffer.addMarkerLayer({ trackRanges: keepRanges });
    const marker = mark(layer, undefined, { invalidate: "inside" });
    buffer.insert([0, 2], "x");
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(marker.isValid()).toBe(false);
  });

  it("destroys omitted markers once according to the layer's invalidation policy", () => {
    const layer = buffer.addMarkerLayer({ trackRanges: () => [], destroyInvalidatedMarkers: true });
    const marker = mark(layer);
    const onDestroy = jasmine.createSpy("destroyed");
    marker.onDidDestroy(onDestroy);
    buffer.insert([0, 2], "x");
    expect(marker.isDestroyed()).toBe(true);
    expect(onDestroy).toHaveBeenCalledTimes(1);
    expect(layer.getMarkerCount()).toBe(0);
  });

  it("does no extra indexed search or range materialization without a callback", () => {
    const layer = buffer.addMarkerLayer();
    const marker = mark(layer);
    const find = spyOnIndex(layer.index, "findIntersecting");
    const ranges = spyOnIndex(layer.index, "getRange");
    const dump = spyOnIndex(layer.index, "dump");
    buffer.insert([0, 2], "x");
    expect(find).not.toHaveBeenCalled();
    expect(ranges).not.toHaveBeenCalled();
    expect(dump).not.toHaveBeenCalled();
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 5],
    ]);
  });

  it("materializes only indexed touched candidates from a sparse 10000-marker layer", () => {
    buffer.setText("spri\n".repeat(10000));
    const tracker = jasmine.createSpy("range tracker").and.callFake(keepRanges);
    const layer = buffer.addMarkerLayer({ trackRanges: tracker });
    const markers = Array.from({ length: 10000 }, (_, row) =>
      mark(layer, [
        [row, 0],
        [row, 4],
      ]),
    );
    const reads = spyOnIndex(layer.index, "getRange");
    const dump = spyOnIndex(layer.index, "dump");
    buffer.insert([5000, 2], "x");
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(tracker.calls.mostRecent().args[0].map(({ id }) => id)).toEqual([markers[5000].id]);
    expect(reads.calls.count()).toBeLessThan(4);
    expect(dump).not.toHaveBeenCalled();
    buffer.insert([5000, 6], "\n");
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(markers[5001].getRange()).toEqual([
      [5002, 0],
      [5002, 4],
    ]);
  });

  it("can attach and remove a tracker without changing marker options", () => {
    const layer = buffer.addMarkerLayer();
    const marker = mark(layer);
    layer.setRangeTracker(keepRanges);
    buffer.insert([0, 2], "x");
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    layer.setRangeTracker(null);
    expect(layer.getRangeTracker()).toBe(null);
    buffer.insert([0, 2], "x");
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 5],
    ]);
    expect(marker.getInvalidationStrategy()).toBe("never");
    expect(marker.isExclusive()).toBe(true);
  });

  it("preserves callback identity in layer copies and releases it on destruction", () => {
    const layer = buffer.addMarkerLayer({ trackRanges: keepRanges });
    const marker = mark(layer);
    const copy = layer.copy();
    const [copied] = copy.getMarkers();
    expect(copy.getRangeTracker()).toBe(keepRanges);
    buffer.insert([0, 2], "x");
    expect(copied.getRange()).toEqual(marker.getRange());
    layer.clear();
    expect(layer.getRangeTracker()).toBe(keepRanges);
    layer.destroy();
    expect(layer.getRangeTracker()).toBe(null);
    expect(() => layer.setRangeTracker(keepRanges)).toThrowError();
    expect(copy.getRangeTracker()).toBe(keepRanges);
  });

  it("rejects nonfunction trackers while preserving the current registration", () => {
    const layer = buffer.addMarkerLayer({ trackRanges: keepRanges });
    expect(() => layer.setRangeTracker("token")).toThrowError();
    expect(layer.getRangeTracker()).toBe(keepRanges);
    expect(() => buffer.addMarkerLayer({ trackRanges: true })).toThrowError();
  });

  it("restores ranges and validity through history while retaining the runtime callback", () => {
    const tracker = () => [];
    const layer = buffer.addMarkerLayer({
      trackRanges: tracker,
      maintainHistory: true,
      destroyInvalidatedMarkers: true,
    });
    const marker = mark(layer);
    buffer.clearUndoStack();
    buffer.delete([
      [0, 0],
      [0, 4],
    ]);
    expect(marker.isDestroyed()).toBe(true);
    buffer.undo();
    expect(layer.getMarker(marker.id)).toBe(marker);
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(marker.isValid()).toBe(true);
    expect(layer.getRangeTracker()).toBe(tracker);
    buffer.redo();
    expect(marker.isDestroyed()).toBe(true);
    buffer.undo();
    buffer.insert([0, 2], "x");
    expect(marker.isDestroyed()).toBe(true);
  });

  it("keeps lazy history snapshots exact after custom multiline range overrides", () => {
    const layer = buffer.addMarkerLayer({
      maintainHistory: true,
      trackRanges: (ranges) =>
        ranges.map(({ id }) => ({
          id,
          range: [
            [0, 1],
            [1, 3],
          ],
        })),
    });
    const marker = mark(layer);
    buffer.insert([0, 2], "x");
    const snapshot = layer.createSnapshot();
    layer.verifyHistorySnapshot(snapshot);
    marker.setRange([
      [0, 0],
      [0, 1],
    ]);
    layer.restoreFromSnapshot(snapshot);
    expect(marker.getRange()).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(layer.getRangeTracker()).not.toBe(null);
  });

  it("serializes only marker data and explicitly reattaches callbacks after deserialization", async () => {
    const layer = buffer.addMarkerLayer({ trackRanges: keepRanges, persistent: true });
    const marker = mark(layer, undefined, { kind: "annotation" });
    expect(layer.serialize().trackRanges).toBeUndefined();
    const restored = await TextBuffer.deserialize(JSON.parse(JSON.stringify(buffer.serialize())));
    buffers.push(restored);
    const restoredLayer = restored.getMarkerLayer(layer.id);
    const restoredMarker = restoredLayer.getMarker(marker.id);
    expect(restoredLayer.getRangeTracker()).toBe(null);
    expect(restoredMarker.getProperties()).toEqual({ kind: "annotation" });
    restoredLayer.setRangeTracker(keepRanges);
    restored.insert([0, 2], "x");
    expect(restoredMarker.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("forwards runtime registration through display layers and refreshes display caches", () => {
    const display = buffer.addDisplayLayer();
    const layer = display.addMarkerLayer({ trackRanges: keepRanges });
    const marker = layer.markBufferRange(
      [
        [0, 0],
        [0, 4],
      ],
      { invalidate: "never", exclusive: true },
    );
    expect(layer.getRangeTracker()).toBe(keepRanges);
    expect(marker.getBufferRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    layer.setRangeTracker((ranges) =>
      ranges.map(({ id }) => ({
        id,
        range: [
          [0, 1],
          [1, 3],
        ],
      })),
    );
    buffer.insert([0, 2], "x");
    expect(marker.getBufferRange()).toEqual([
      [0, 1],
      [1, 3],
    ]);
    expect(marker.getScreenRange()).toEqual(marker.getBufferRange());
    layer.setRangeTracker(null);
    expect(layer.getRangeTracker()).toBe(null);
  });

  it("finishes text, native marker, display, and history updates if a callback throws", () => {
    const error = new Error("custom tracker failed");
    const logged = spyOn(console, "error");
    const layer = buffer.addMarkerLayer({
      maintainHistory: true,
      trackRanges() {
        throw error;
      },
    });
    const affected = mark(layer);
    const otherLayer = buffer.addMarkerLayer();
    const other = mark(otherLayer, [
      [1, 0],
      [1, 6],
    ]);
    const applied = jasmine.createSpy("applied");
    buffer.onDidApplyChanges(applied);
    buffer.clearUndoStack();
    expect(() => buffer.insert([0, 2], "x\n")).not.toThrow();
    expect(buffer.getText()).toBe("spx\nri func\nsecond\n");
    expect(affected.isValid()).toBe(false);
    expect(other.getRange()).toEqual([
      [2, 0],
      [2, 6],
    ]);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("Error tracking marker ranges", error);
    layer.verifyHistorySnapshot(layer.createSnapshot());
    buffer.undo();
    expect(buffer.getText()).toBe("spri func\nsecond\n");
    expect(affected.isValid()).toBe(true);
    expect(affected.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
  });

  it("validates the complete result before mutating the index", () => {
    const logged = spyOn(console, "error");
    const layer = buffer.addMarkerLayer({
      trackRanges: (ranges) => [
        {
          id: ranges[0].id,
          range: [
            [0, 0],
            [0, 1],
          ],
        },
        {
          id: 99999999,
          range: [
            [0, 0],
            [0, 2],
          ],
        },
      ],
    });
    const marker = mark(layer);
    buffer.insert([0, 2], "x");
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 5],
    ]);
    expect(marker.isValid()).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate ids, async results, and unsafe or inverted native coordinates", () => {
    const logged = spyOn(console, "error");
    const invalid = [
      (id) => [
        {
          id,
          range: [
            [0, 0],
            [0, 1],
          ],
        },
        { id, range: null },
      ],
      () => Promise.resolve([]),
      () => null,
      (id) => [
        {
          id,
          range: [
            [0, 0],
            [0, NaN],
          ],
        },
      ],
      (id) => [
        {
          id,
          range: [
            [0, 0],
            [0, Infinity],
          ],
        },
      ],
      (id) => [
        {
          id,
          range: [
            [0, -1],
            [0, 1],
          ],
        },
      ],
      (id) => [
        {
          id,
          range: [
            [0, 0],
            [0, 1.5],
          ],
        },
      ],
      (id) => [
        {
          id,
          range: [
            [0, 0],
            [0, 0x100000000],
          ],
        },
      ],
      (id) => [
        {
          id,
          range: [
            [1, 0],
            [0, 1],
          ],
        },
      ],
    ];
    for (const result of invalid) {
      const layer = buffer.addMarkerLayer({ trackRanges: ([{ id }]) => result(id) });
      const marker = mark(layer);
      expect(() => buffer.insert([0, 2], "x")).not.toThrow();
      expect(marker.isValid()).toBe(false);
      layer.destroy();
    }
    expect(logged).toHaveBeenCalledTimes(invalid.length);
  });

  it("emits one change with final custom geometry per transaction", () => {
    const layer = buffer.addMarkerLayer({
      trackRanges: (ranges, { newText }) =>
        ranges.map(({ id, range }) => ({
          id,
          range: [range.start, [range.end.row, range.end.column + newText.length]],
        })),
    });
    const marker = mark(layer);
    const events = [];
    marker.onDidChange((event) => events.push(event));
    buffer.transact(() => {
      buffer.insert([0, 2], "x");
      buffer.insert([0, 2], "y");
    });
    expect(events.length).toBe(1);
    expect(events[0].textChanged).toBe(true);
    expect(events[0].newHeadPosition).toEqual([0, 6]);
    expect(marker.getRange()).toEqual([
      [0, 0],
      [0, 6],
    ]);
  });

  it("reports applied edits for transactions with unchanged final text", () => {
    const original = buffer.getText();
    const batches = [];
    const consolidated = jasmine.createSpy("consolidated change");
    buffer.onDidApplyChanges((event) => batches.push(event));
    buffer.onDidChange(consolidated);
    buffer.transact(() => {
      buffer.insert([0, 2], "\n");
      buffer.delete([
        [0, 2],
        [1, 0],
      ]);
    });
    expect(buffer.getText()).toBe(original);
    expect(consolidated).not.toHaveBeenCalled();
    expect(batches.length).toBe(1);
    expect(batches[0].changes.map(({ oldText, newText }) => [oldText, newText])).toEqual([
      ["", "\n"],
      ["\n", ""],
    ]);
    expect(batches[0].changes[0].oldRange).toEqual([
      [0, 2],
      [0, 2],
    ]);
    expect(batches[0].changes[0].newRange).toEqual([
      [0, 2],
      [1, 0],
    ]);
    expect(batches[0].changes[1].oldRange).toEqual(batches[0].changes[0].newRange);
    expect(Object.isFrozen(batches[0].changes)).toBe(true);
    for (const change of batches[0].changes) {
      expect(Object.isFrozen(change)).toBe(true);
      expect(Object.isFrozen(change.oldRange)).toBe(true);
      expect(Object.isFrozen(change.newRange.end)).toBe(true);
    }
  });

  it("reports applied coordinates before consolidated and marker change events", () => {
    buffer.setText("spri\nfunc");
    const layer = buffer.addMarkerLayer({ trackRanges: keepRanges });
    const marker = mark(layer, [
      [1, 0],
      [1, 4],
    ]);
    const order = [];
    let applied, consolidated;
    buffer.onDidApplyChanges((event) => {
      applied = event.changes;
      order.push("applied");
      expect(marker.getRange()).toEqual([
        [2, 0],
        [2, 4],
      ]);
    });
    buffer.onDidChange((event) => {
      consolidated = event.changes;
      order.push("consolidated");
    });
    marker.onDidChange(() => order.push("marker"));
    buffer.transact(() => {
      buffer.insert([0, 0], "\n");
      buffer.insert([2, 4], "_");
    });
    expect(order).toEqual(["applied", "consolidated", "marker"]);
    expect(applied.length).toBe(2);
    expect(applied[1].oldRange).toEqual([
      [2, 4],
      [2, 4],
    ]);
    expect(consolidated[1].oldRange).toEqual([
      [1, 4],
      [1, 4],
    ]);
  });

  it("delivers reentrant applied batches in FIFO order with a current revision check", () => {
    const replay = new TextBuffer(buffer.getText());
    buffers.push(replay);
    let mutated = false;
    const order = [];
    const current = [];
    buffer.onDidApplyChanges(({ changes }) => {
      order.push(`mutator:${changes[0].newText}`);
      if (mutated) return;
      mutated = true;
      buffer.insert([0, 2], "\n");
    });
    buffer.onDidApplyChanges(({ changes, isCurrent }) => {
      order.push(`tracker:${changes[0].newText}`);
      current.push(isCurrent());
      for (const change of changes) {
        expect(replay.getTextInRange(change.oldRange)).toBe(change.oldText);
        replay.setTextInRange(change.oldRange, change.newText);
      }
      if (isCurrent()) expect(replay.getText()).toBe(buffer.getText());
    });
    buffer.insert([0, 4], "_");
    expect(order).toEqual(["mutator:_", "tracker:_", "mutator:\n", "tracker:\n"]);
    expect(current).toEqual([false, true]);
    expect(replay.getText()).toBe(buffer.getText());
  });

  it("reports replayable applied edits and unclipped intermediate geometry on disk reload", async () => {
    jasmine.useRealClock();
    const original = "spri\nunchanged-a\nunchanged-b\nfunc\nend\n";
    const changed = "prefix\nspri\nunchanged-a\nunchanged-b\nfunc_\nend\n";
    const filePath = temp.openSync("custom-marker-reload").path;
    fs.writeFileSync(filePath, original);
    const fileBuffer = TextBuffer.loadSync(filePath);
    buffers.push(fileBuffer);
    const layer = fileBuffer.addMarkerLayer({ trackRanges: keepRanges });
    const first = mark(layer);
    const second = mark(layer, [
      [3, 0],
      [3, 4],
    ]);
    const batches = [];
    fileBuffer.onDidApplyChanges((event) => batches.push(event));
    fs.writeFileSync(filePath, changed);
    await fileBuffer.reload();
    expect(fileBuffer.getText()).toBe(changed);
    expect(batches.length).toBe(1);
    expect(batches[0].changes.length).toBeGreaterThan(1);
    const replay = new TextBuffer(original);
    buffers.push(replay);
    for (const change of batches[0].changes) {
      expect(replay.getTextInRange(change.oldRange)).toBe(change.oldText);
      expect(replay.setTextInRange(change.oldRange, change.newText)).toEqual(change.newRange);
    }
    expect(replay.getText()).toBe(changed);
    expect(first.getRange()).toEqual([
      [0, 0],
      [0, 4],
    ]);
    expect(second.getRange()).toEqual([
      [4, 0],
      [4, 4],
    ]);
  });
});
