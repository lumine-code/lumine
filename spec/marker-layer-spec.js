const { uniq, times } = require("@lumine-code/underscore-plus");
const TextBuffer = require("../src/text-buffer");

describe("MarkerLayer", function () {
  let buffer, layer1, layer2;

  beforeEach(function () {
    jasmine.addCustomEqualityTester(require("@lumine-code/underscore-plus").isEqual);
    buffer = new TextBuffer({ text: "abcdefghijklmnopqrstuvwxyz" });
    layer1 = buffer.addMarkerLayer();
    layer2 = buffer.addMarkerLayer();
  });

  it("ensures that marker ids are unique across layers", function () {
    times(5, function () {
      buffer.markRange([
        [0, 3],
        [0, 6],
      ]);
      layer1.markRange([
        [0, 4],
        [0, 7],
      ]);
      layer2.markRange([
        [0, 5],
        [0, 8],
      ]);
    });

    const ids = buffer
      .getMarkers()
      .concat(layer1.getMarkers())
      .concat(layer2.getMarkers())
      .map((marker) => marker.id);

    expect(uniq(ids).length).toEqual(ids.length);
  });

  it("skips empty indexes while retaining update events and later marker movement", function () {
    const splice = spyOn(layer1.index, "splicePacked").and.callThrough();
    const updated = jasmine.createSpy("updated");
    layer1.onDidUpdate(updated);
    buffer.transact(() => {
      for (let i = 0; i < 100; i++) buffer.insert([0, 0], " ");
    });
    expect(splice).not.toHaveBeenCalled();
    expect(updated.calls.count()).toBe(1);
    const marker = layer1.markRange(
      [
        [0, 102],
        [0, 105],
      ],
      { invalidate: "never" },
    );
    buffer.insert([0, 0], "abc");
    expect(splice.calls.count()).toBe(1);
    expect(marker.getRange()).toEqual([
      [0, 105],
      [0, 108],
    ]);
    buffer.undo();
    expect(marker.getRange()).toEqual([
      [0, 102],
      [0, 105],
    ]);
    marker.destroy();
    splice.calls.reset();
    buffer.insert([0, 0], "next");
    expect(splice).not.toHaveBeenCalled();
  });

  it("updates each layer's markers when the text changes", function () {
    const defaultMarker = buffer.markRange([
      [0, 3],
      [0, 6],
    ]);
    const layer1Marker = layer1.markRange([
      [0, 4],
      [0, 7],
    ]);
    const layer2Marker = layer2.markRange([
      [0, 5],
      [0, 8],
    ]);

    buffer.setTextInRange(
      [
        [0, 1],
        [0, 2],
      ],
      "BBB",
    );
    expect(defaultMarker.getRange()).toEqual([
      [0, 5],
      [0, 8],
    ]);
    expect(layer1Marker.getRange()).toEqual([
      [0, 6],
      [0, 9],
    ]);
    expect(layer2Marker.getRange()).toEqual([
      [0, 7],
      [0, 10],
    ]);

    layer2.destroy();
    expect(layer2.isAlive()).toBe(false);
    expect(layer2.isDestroyed()).toBe(true);

    expect(layer1.isAlive()).toBe(true);
    expect(layer1.isDestroyed()).toBe(false);

    buffer.undo();
    expect(defaultMarker.getRange()).toEqual([
      [0, 3],
      [0, 6],
    ]);
    expect(layer1Marker.getRange()).toEqual([
      [0, 4],
      [0, 7],
    ]);

    expect(layer2Marker.isDestroyed()).toBe(true);
    expect(layer2Marker.getRange()).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("emits onDidCreateMarker events synchronously when markers are created", function () {
    const createdMarkers = [];
    layer1.onDidCreateMarker((marker) => createdMarkers.push(marker));
    const marker = layer1.markRange([
      [0, 1],
      [2, 3],
    ]);
    expect(createdMarkers).toEqual([marker]);
  });

  it("does not emit marker events on the TextBuffer for non-default layers", function () {
    let updateEventCount;
    let createEventCount = (updateEventCount = 0);
    buffer.onDidCreateMarker(() => createEventCount++);
    buffer.onDidUpdateMarkers(() => updateEventCount++);

    const marker1 = buffer.markRange([
      [0, 1],
      [0, 2],
    ]);
    marker1.setRange([
      [0, 1],
      [0, 3],
    ]);

    expect(createEventCount).toBe(1);
    expect(updateEventCount).toBe(2);

    const marker2 = layer1.markRange([
      [0, 1],
      [0, 2],
    ]);
    marker2.setRange([
      [0, 1],
      [0, 3],
    ]);

    expect(createEventCount).toBe(1);
    expect(updateEventCount).toBe(2);
  });

  describe("when destroyInvalidatedMarkers is enabled for the layer", () => {
    it("destroys markers when they are invalidated via a splice", function () {
      const layer3 = buffer.addMarkerLayer({ destroyInvalidatedMarkers: true });

      const marker1 = layer3.markRange(
        [
          [0, 0],
          [0, 3],
        ],
        { invalidate: "inside" },
      );
      const marker2 = layer3.markRange(
        [
          [0, 2],
          [0, 6],
        ],
        { invalidate: "inside" },
      );

      const destroyedMarkers = [];
      marker1.onDidDestroy(() => destroyedMarkers.push(marker1));
      marker2.onDidDestroy(() => destroyedMarkers.push(marker2));

      buffer.insert([0, 5], "x");

      expect(destroyedMarkers).toEqual([marker2]);
      expect(marker2.isDestroyed()).toBe(true);
      expect(marker1.isDestroyed()).toBe(false);
    });
  });

  describe("when maintainHistory is enabled for the layer", function () {
    let layer3 = null;

    beforeEach(() => (layer3 = buffer.addMarkerLayer({ maintainHistory: true })));

    // History snapshots read the layer's shadow ranges instead of paying the
    // index dump. The shadow is bookkeeping duplicated from the index,
    // so pin their agreement across every mutation shape here; the randomized
    // referee is `LUMINE_VERIFY_MARKER_SNAPSHOTS=1`, which compares the two on
    // every snapshot the whole suite takes.
    describe("history snapshot shadow", () => {
      const MarkerLayer = require("../src/marker-layer");

      const expectShadowAgreesWithIndex = (layer) => {
        const lazy = MarkerLayer.materializeSnapshot(layer.createSnapshot());
        const eager = layer.createEagerSnapshot();
        expect(Object.keys(lazy).sort()).toEqual(Object.keys(eager).sort());
        for (const id of Object.keys(eager)) {
          expect(lazy[id].range).toEqual(eager[id].range);
          expect(lazy[id].valid).toBe(eager[id].valid);
          expect(lazy[id].marker).toBe(eager[id].marker);
        }
      };

      it("updates row-local history without visiting markers elsewhere in the file", () => {
        buffer.setText("abcdefghij\n".repeat(1000));
        for (let row = 0; row < 1000; row++) {
          layer3.markRange([
            [row, 7],
            [row, 9],
          ]);
        }
        // Spanning markers and endpoints touching the edit use the index's
        // affinity rules; only untouched starts on the last row translate.
        for (const range of [
          [
            [498, 1],
            [501, 9],
          ],
          [
            [499, 1],
            [500, 8],
          ],
          [
            [500, 8],
            [501, 9],
          ],
          [
            [500, 1],
            [500, 3],
          ],
          [
            [500, 3],
            [500, 3],
          ],
          [
            [500, 3],
            [500, 5],
          ],
        ]) {
          for (const exclusive of [false, true]) layer3.markRange(range, { exclusive });
        }
        const retained = layer3.createSnapshot();
        const expected = MarkerLayer.materializeSnapshot(retained);
        const iteration = spyOn(layer3.historyShadow, Symbol.iterator).and.throwError(
          "Row-local edit scanned the full history map",
        );
        buffer.insert([500, 3], "XY");
        buffer.setTextInRange(
          [
            [499, 4],
            [500, 4],
          ],
          "x\nyyyyy",
        );
        buffer.setTextInRange(
          [
            [500, 1],
            [500, 6],
          ],
          "",
        );
        expect(iteration.calls.count()).toBe(0);
        expectShadowAgreesWithIndex(layer3);
        expect(MarkerLayer.materializeSnapshot(retained)).toEqual(expected);
        for (let i = 0; i < 3; i++) {
          buffer.undo();
          expectShadowAgreesWithIndex(layer3);
        }
        for (let i = 0; i < 3; i++) {
          buffer.redo();
          expectShadowAgreesWithIndex(layer3);
        }
      });

      it("reuses splice intersections for history without querying them twice", () => {
        buffer.setText("abcdefghij\n".repeat(20));
        for (const invalidate of ["never", "touch", "inside", "overlap", "surround"]) {
          for (const exclusive of [false, true]) {
            layer3.markRange(
              [
                [1, 2],
                [3, 7],
              ],
              { invalidate, exclusive },
            );
            layer3.markPosition([2, 4], { invalidate, exclusive });
          }
        }
        const query = spyOn(layer3.index, "findIntersecting").and.throwError("Redundant query");
        buffer.setTextInRange(
          [
            [1, 5],
            [3, 1],
          ],
          "x\ny",
        );
        expectShadowAgreesWithIndex(layer3);
        buffer.undo();
        expectShadowAgreesWithIndex(layer3);
        buffer.redo();
        expectShadowAgreesWithIndex(layer3);
        expect(query).not.toHaveBeenCalled();
      });

      it("stays exact through creates, destroys, explicit moves and splices", () => {
        buffer.setText("one two\nthree four\nfive six\n");
        const kept = layer3.markRange([
          [0, 0],
          [0, 3],
        ]);
        const doomed = layer3.markRange([
          [1, 0],
          [1, 5],
        ]);
        layer3.markRange(
          [
            [2, 0],
            [2, 4],
          ],
          { invalidate: "never" },
        );
        expectShadowAgreesWithIndex(layer3);

        // A deletion collapsing one marker, shifting another.
        buffer.transact(() =>
          buffer.setTextInRange(
            [
              [1, 2],
              [2, 2],
            ],
            "",
          ),
        );
        expectShadowAgreesWithIndex(layer3);

        kept.setRange([
          [0, 1],
          [1, 1],
        ]);
        doomed.destroy();
        expectShadowAgreesWithIndex(layer3);

        buffer.undo();
        expectShadowAgreesWithIndex(layer3);
        buffer.redo();
        expectShadowAgreesWithIndex(layer3);

        layer3.clear();
        expectShadowAgreesWithIndex(layer3);
      });

      it("is rebuilt when history is enabled on a layer built without it", () => {
        const layer = buffer.addMarkerLayer();
        layer.markRange([
          [0, 2],
          [0, 9],
        ]);
        expect(layer.historyShadow).toBeNull();

        layer.enableHistorySnapshots();
        expect(layer.maintainHistory).toBe(true);
        expectShadowAgreesWithIndex(layer);
      });

      it("keeps retained snapshots unchanged through range, property and lifetime changes", () => {
        buffer.setText("abcd\n".repeat(320));
        const markers = Array.from({ length: 300 }, (_, row) =>
          layer3.markRange(
            [
              [row, 0],
              [row, 2],
            ],
            { label: `marker-${row}` },
          ),
        );
        const before = layer3.createSnapshot();
        const expected = MarkerLayer.materializeSnapshot(before);
        markers[0].setRange([
          [0, 1],
          [0, 3],
        ]);
        markers[128].setProperties({ label: "changed" });
        markers[256].destroy();
        buffer.insert([0, 0], "new\n");
        expectShadowAgreesWithIndex(layer3);
        layer3.clear();
        layer3.markPosition([1, 1]);
        expectShadowAgreesWithIndex(layer3);
        const retained = MarkerLayer.materializeSnapshot(before);
        expect(Object.keys(retained)).toEqual(Object.keys(expected));
        for (const id of Object.keys(expected)) {
          expect(retained[id].range).toEqual(expected[id].range);
          expect(retained[id].properties).toEqual(expected[id].properties);
          expect(retained[id].marker).toBe(expected[id].marker);
        }
        layer3.restoreFromSnapshot(before);
        expectShadowAgreesWithIndex(layer3);
        for (const marker of markers) {
          expect(layer3.getMarker(marker.id)).toBe(marker);
          expect(marker.getRange()).toEqual(expected[marker.id].range);
          expect(marker.getProperties()).toEqual(expected[marker.id].properties);
        }
      });

      it("preserves earlier snapshots across deterministic edits, undo, redo and nested aborts", () => {
        buffer.setText("abcd\n".repeat(320));
        for (let row = 0; row < 300; row++) {
          layer3.markRange(
            [
              [row, 0],
              [row, 2],
            ],
            { invalidate: "never" },
          );
        }
        let seed = 19;
        const random = (limit) => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed % limit;
        };
        const retained = [];
        for (let step = 0; step < 80; step++) {
          if (step % 10 === 0) {
            const snapshot = layer3.createSnapshot();
            retained.push([snapshot, MarkerLayer.materializeSnapshot(snapshot)]);
          }
          const row = random(buffer.getLineCount() - 1);
          buffer.transact(() => {
            buffer.insert([row, 1], step % 3 === 0 ? "x\ny" : "x");
            buffer.transact(() => {
              buffer.insert([0, 0], "discarded\n");
              buffer.abortTransaction();
            });
          });
          expectShadowAgreesWithIndex(layer3);
          if (step % 4 === 0) {
            buffer.undo();
            expectShadowAgreesWithIndex(layer3);
            buffer.redo();
            expectShadowAgreesWithIndex(layer3);
          }
        }
        for (const [snapshot, expected] of retained) {
          const actual = MarkerLayer.materializeSnapshot(snapshot);
          for (const id of Object.keys(expected)) {
            expect(actual[id].range).toEqual(expected[id].range);
            expect(actual[id].marker).toBe(expected[id].marker);
          }
        }
      });
    });

    it("restores the state of all markers in the layer on undo and redo", function () {
      buffer.setText("");
      buffer.transact(() => buffer.append("foo"));
      layer3 = buffer.addMarkerLayer({ maintainHistory: true });

      const marker1 = layer3.markRange(
        [
          [0, 0],
          [0, 0],
        ],
        { invalidate: "never" },
      );
      const marker2 = layer3.markRange(
        [
          [0, 0],
          [0, 0],
        ],
        { invalidate: "never" },
      );

      let marker2ChangeCount = 0;
      marker2.onDidChange(() => marker2ChangeCount++);

      buffer.transact(function () {
        buffer.append("\n");
        buffer.append("bar");

        marker1.destroy();
        marker2.setRange([
          [0, 2],
          [0, 3],
        ]);
        layer3.markRange(
          [
            [0, 0],
            [0, 3],
          ],
          { invalidate: "never" },
        );
        layer3.markRange(
          [
            [1, 0],
            [1, 3],
          ],
          { invalidate: "never" },
        );
        expect(marker2ChangeCount).toBe(1);
      });

      let createdMarker = null;
      layer3.onDidCreateMarker((m) => (createdMarker = m));
      buffer.undo();

      expect(buffer.getText()).toBe("foo");
      expect(marker1.isDestroyed()).toBe(false);
      expect(createdMarker).toBe(marker1);
      let markers = layer3.findMarkers({});
      expect(markers.length).toBe(2);
      expect(markers[0]).toBe(marker1);
      expect(markers[0].getRange()).toEqual([
        [0, 0],
        [0, 0],
      ]);
      expect(markers[1].getRange()).toEqual([
        [0, 0],
        [0, 0],
      ]);
      expect(marker2ChangeCount).toBe(2);

      buffer.redo();

      expect(buffer.getText()).toBe("foo\nbar");
      markers = layer3.findMarkers({});
      expect(markers.length).toBe(3);
      expect(markers[0].getRange()).toEqual([
        [0, 0],
        [0, 3],
      ]);
      expect(markers[1].getRange()).toEqual([
        [0, 2],
        [0, 3],
      ]);
      expect(markers[2].getRange()).toEqual([
        [1, 0],
        [1, 3],
      ]);
    });

    it("does not undo marker manipulations that aren't associated with text changes", function () {
      const marker = layer3.markRange([
        [0, 6],
        [0, 9],
      ]);

      // Can't undo changes in a transaction without other buffer changes
      buffer.transact(() =>
        marker.setRange([
          [0, 4],
          [0, 20],
        ]),
      );
      buffer.undo();
      expect(marker.getRange()).toEqual([
        [0, 4],
        [0, 20],
      ]);

      // Can undo changes in a transaction with other buffer changes
      buffer.transact(function () {
        marker.setRange([
          [0, 5],
          [0, 9],
        ]);
        buffer.setTextInRange(
          [
            [0, 2],
            [0, 3],
          ],
          "XYZ",
        );
        marker.setRange([
          [0, 8],
          [0, 12],
        ]);
      });

      buffer.undo();
      expect(marker.getRange()).toEqual([
        [0, 4],
        [0, 20],
      ]);

      buffer.redo();
      expect(marker.getRange()).toEqual([
        [0, 8],
        [0, 12],
      ]);
    });

    it("ignores snapshot references to marker layers that no longer exist", function () {
      layer3.markRange([
        [0, 6],
        [0, 9],
      ]);
      buffer.append("stuff");
      layer3.destroy();

      // Should not throw an exception
      buffer.undo();
    });
  });

  describe("when a role is provided for the layer", () => {
    it("getRole() returns its role and keeps track of ids of 'selections' role", function () {
      expect(buffer.selectionsMarkerLayerIds.size).toBe(0);

      const selectionsMarkerLayer1 = buffer.addMarkerLayer({ role: "selections" });
      expect(selectionsMarkerLayer1.getRole()).toBe("selections");

      expect(buffer.addMarkerLayer({ role: "role-1" }).getRole()).toBe("role-1");
      expect(buffer.addMarkerLayer().getRole()).toBe(undefined);

      expect(buffer.selectionsMarkerLayerIds.size).toBe(1);
      expect(buffer.selectionsMarkerLayerIds.has(selectionsMarkerLayer1.id)).toBe(true);

      const selectionsMarkerLayer2 = buffer.addMarkerLayer({ role: "selections" });
      expect(selectionsMarkerLayer2.getRole()).toBe("selections");

      expect(buffer.selectionsMarkerLayerIds.size).toBe(2);
      expect(buffer.selectionsMarkerLayerIds.has(selectionsMarkerLayer2.id)).toBe(true);

      selectionsMarkerLayer1.destroy();
      selectionsMarkerLayer2.destroy();
      expect(buffer.selectionsMarkerLayerIds.size).toBe(2);
      expect(buffer.selectionsMarkerLayerIds.has(selectionsMarkerLayer1.id)).toBe(true);
      expect(buffer.selectionsMarkerLayerIds.has(selectionsMarkerLayer2.id)).toBe(true);
    });
  });

  describe("::findMarkers(params)", () => {
    it("does not find markers from other layers", () => {
      const defaultMarker = buffer.markRange([
        [0, 3],
        [0, 6],
      ]);
      const layer1Marker = layer1.markRange([
        [0, 3],
        [0, 6],
      ]);
      const layer2Marker = layer2.markRange([
        [0, 3],
        [0, 6],
      ]);

      expect(buffer.findMarkers({ containsPoint: [0, 4] })).toEqual([defaultMarker]);
      expect(layer1.findMarkers({ containsPoint: [0, 4] })).toEqual([layer1Marker]);
      expect(layer2.findMarkers({ containsPoint: [0, 4] })).toEqual([layer2Marker]);
    });

    it("does not mutate the params object, so it can be reused across calls", () => {
      const marker1 = layer1.markRange(
        [
          [0, 3],
          [0, 6],
        ],
        { class: "a" },
      );
      layer1.markRange(
        [
          [0, 10],
          [0, 12],
        ],
        { class: "b" },
      );

      const params = { containsPoint: [0, 4], class: "a" };
      expect(layer1.findMarkers(params)).toEqual([marker1]);
      expect(params).toEqual({ containsPoint: [0, 4], class: "a" });
      expect(layer1.findMarkers(params)).toEqual([marker1]);
    });
  });

  describe("::onDidUpdate", () => {
    it("notifies observers at the end of the outermost transaction when markers are created, updated, or destroyed", function () {
      let marker1, marker2;

      const displayLayer = buffer.addDisplayLayer();
      let displayLayerDidChange = false;

      let changeCount = 0;
      buffer.onDidChange(() => changeCount++);

      let updateCount = 0;
      layer1.onDidUpdate(function () {
        updateCount++;
        if (updateCount === 1) {
          expect(changeCount).toBe(0);
          buffer.transact(function () {
            marker1.setRange([
              [1, 2],
              [3, 4],
            ]);
            marker2.setRange([
              [4, 5],
              [6, 7],
            ]);
          });
        } else if (updateCount === 2) {
          expect(changeCount).toBe(0);
          buffer.transact(function () {
            buffer.insert([0, 1], "xxx");
            buffer.insert([0, 1], "yyy");
          });
        } else if (updateCount === 3) {
          expect(changeCount).toBe(1);
          marker1.destroy();
          marker2.destroy();
        } else if (updateCount === 7) {
          expect(changeCount).toBe(2);
          expect(displayLayerDidChange).toBe(true, "Display layer was updated after marker layer.");
        }
      });

      buffer.transact(() =>
        buffer.transact(function () {
          marker1 = layer1.markRange([
            [0, 2],
            [0, 4],
          ]);
          marker2 = layer1.markRange([
            [0, 6],
            [0, 8],
          ]);
        }),
      );

      expect(updateCount).toBe(5);

      // update events happen immediately when there is no parent transaction
      layer1.markRange([
        [0, 2],
        [0, 4],
      ]);
      expect(updateCount).toBe(6);

      // update events happen after updating display layers when there is no parent transaction.
      displayLayer.onDidChange(() => (displayLayerDidChange = true));
      buffer.undo();
      expect(updateCount).toBe(7);
    });
  });

  describe("::clear()", () => {
    it("destroys all of the layer's markers", function (done) {
      buffer = new TextBuffer({ text: "abc" });
      const displayLayer = buffer.addDisplayLayer();
      const markerLayer = buffer.addMarkerLayer();
      const displayMarkerLayer = displayLayer.getMarkerLayer(markerLayer.id);
      const marker1 = markerLayer.markRange([
        [0, 1],
        [0, 2],
      ]);
      const marker2 = markerLayer.markRange([
        [0, 1],
        [0, 2],
      ]);
      const marker3 = markerLayer.markRange([
        [0, 1],
        [0, 2],
      ]);
      const displayMarker1 = displayMarkerLayer.getMarker(marker1.id);
      // intentionally omit a display marker for marker2 just to cover that case
      const displayMarker3 = displayMarkerLayer.getMarker(marker3.id);

      let marker1DestroyCount = 0;
      let marker2DestroyCount = 0;
      let displayMarker1DestroyCount = 0;
      let displayMarker3DestroyCount = 0;
      let markerLayerUpdateCount = 0;
      let displayMarkerLayerUpdateCount = 0;
      marker1.onDidDestroy(() => marker1DestroyCount++);
      marker2.onDidDestroy(() => marker2DestroyCount++);
      displayMarker1.onDidDestroy(() => displayMarker1DestroyCount++);
      displayMarker3.onDidDestroy(() => displayMarker3DestroyCount++);
      markerLayer.onDidUpdate(function () {
        markerLayerUpdateCount++;
        if (markerLayerUpdateCount === 1 && displayMarkerLayerUpdateCount === 1) {
          done();
        }
      });
      displayMarkerLayer.onDidUpdate(function () {
        displayMarkerLayerUpdateCount++;
        if (markerLayerUpdateCount === 1 && displayMarkerLayerUpdateCount === 1) {
          done();
        }
      });

      markerLayer.clear();
      expect(marker1.isDestroyed()).toBe(true);
      expect(marker2.isDestroyed()).toBe(true);
      expect(marker3.isDestroyed()).toBe(true);
      expect(displayMarker1.isDestroyed()).toBe(true);
      expect(displayMarker3.isDestroyed()).toBe(true);
      expect(marker1DestroyCount).toBe(1);
      expect(marker2DestroyCount).toBe(1);
      expect(displayMarker1DestroyCount).toBe(1);
      expect(displayMarker3DestroyCount).toBe(1);
      expect(markerLayer.getMarkers()).toEqual([]);
      expect(displayMarkerLayer.getMarkers()).toEqual([]);
      expect(displayMarkerLayer.getMarker(displayMarker3.id)).toBeUndefined();
    });
  });

  describe("::copy", function () {
    it("creates a new marker layer with markers in the same states", function () {
      const originalLayer = buffer.addMarkerLayer({ maintainHistory: true });
      originalLayer.markRange([
        [0, 1],
        [0, 3],
      ]);
      originalLayer.markPosition([0, 2]);

      const copy = originalLayer.copy();
      expect(copy).not.toBe(originalLayer);

      const markers = copy.getMarkers();
      expect(markers.length).toBe(2);
      expect(markers[0].getRange()).toEqual([
        [0, 1],
        [0, 3],
      ]);
      expect(markers[1].getRange()).toEqual([
        [0, 2],
        [0, 2],
      ]);
      expect(markers[1].hasTail()).toBe(false);
    });

    it("copies the marker layer role", function () {
      const originalLayer = buffer.addMarkerLayer({ maintainHistory: true, role: "selections" });
      const copy = originalLayer.copy();
      expect(copy).not.toBe(originalLayer);
      expect(copy.getRole()).toBe("selections");
      expect(buffer.selectionsMarkerLayerIds.has(originalLayer.id)).toBe(true);
      expect(buffer.selectionsMarkerLayerIds.has(copy.id)).toBe(true);
      expect(buffer.selectionsMarkerLayerIds.size).toBe(2);
    });
  });

  describe("::destroy", () => {
    it("destroys the layer's markers", () => {
      buffer = new TextBuffer();
      const markerLayer = buffer.addMarkerLayer();

      const marker1 = markerLayer.markRange([
        [0, 0],
        [0, 0],
      ]);
      const marker2 = markerLayer.markRange([
        [0, 0],
        [0, 0],
      ]);

      const destroyListener = jasmine.createSpy("onDidDestroy listener");
      marker1.onDidDestroy(destroyListener);

      markerLayer.destroy();

      expect(destroyListener).toHaveBeenCalled();
      expect(marker1.isDestroyed()).toBe(true);

      // Markers states are updated regardless of whether they have an
      // `::onDidDestroy` listener.
      expect(marker2.isDestroyed()).toBe(true);
    });
  });

  describe("trackDestructionInOnDidCreateMarkerCallbacks", () => {
    it("stores a stack trace when destroy is called during onDidCreateMarker callbacks", function () {
      layer1.onDidCreateMarker(function (m) {
        if (destroyInCreateCallback) {
          return m.destroy();
        }
      });

      layer1.trackDestructionInOnDidCreateMarkerCallbacks = true;
      var destroyInCreateCallback = true;
      const marker1 = layer1.markPosition([0, 0]);
      expect(marker1.isDestroyed()).toBe(true);
      expect(marker1.destroyStackTrace).toBeDefined();

      destroyInCreateCallback = false;
      const marker2 = layer1.markPosition([0, 0]);
      expect(marker2.isDestroyed()).toBe(false);
      expect(marker2.destroyStackTrace).toBeUndefined();
      marker2.destroy();
      expect(marker2.isDestroyed()).toBe(true);
      expect(marker2.destroyStackTrace).toBeUndefined();

      destroyInCreateCallback = true;
      layer1.trackDestructionInOnDidCreateMarkerCallbacks = false;
      const marker3 = layer1.markPosition([0, 0]);
      expect(marker3.isDestroyed()).toBe(true);
      expect(marker3.destroyStackTrace).toBeUndefined();
    });
  });
});
