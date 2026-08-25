const TextBuffer = require("../src/text-buffer");
const SampleText = require("./text-buffer-helpers/sample-text");

describe("DisplayMarkerLayer", function () {
  beforeEach(() =>
    jasmine.addCustomEqualityTester(require("@lumine-code/underscore-plus").isEqual),
  );

  it("allows DisplayMarkers to be created and manipulated in screen coordinates", function () {
    const buffer = new TextBuffer({ text: "abc\ndef\nghi\nj\tk\tl\nmno" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const markerLayer = displayLayer.addMarkerLayer();

    const marker = markerLayer.markScreenRange([
      [3, 4],
      [4, 2],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [3, 4],
      [4, 2],
    ]);
    expect(marker.getBufferRange()).toEqual([
      [3, 2],
      [4, 2],
    ]);

    let markerChangeEvents = [];
    marker.onDidChange((change) => markerChangeEvents.push(change));

    marker.setScreenRange([
      [3, 8],
      [4, 3],
    ]);

    expect(marker.getBufferRange()).toEqual([
      [3, 4],
      [4, 3],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [3, 8],
      [4, 3],
    ]);
    expect(markerChangeEvents[0]).toEqual({
      oldHeadBufferPosition: [4, 2],
      newHeadBufferPosition: [4, 3],
      oldTailBufferPosition: [3, 2],
      newTailBufferPosition: [3, 4],
      oldHeadScreenPosition: [4, 2],
      newHeadScreenPosition: [4, 3],
      oldTailScreenPosition: [3, 4],
      newTailScreenPosition: [3, 8],
      wasValid: true,
      isValid: true,
      textChanged: false,
    });

    markerChangeEvents = [];
    buffer.insert([4, 0], "\t");

    expect(marker.getBufferRange()).toEqual([
      [3, 4],
      [4, 4],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [3, 8],
      [4, 7],
    ]);
    expect(markerChangeEvents[0]).toEqual({
      oldHeadBufferPosition: [4, 3],
      newHeadBufferPosition: [4, 4],
      oldTailBufferPosition: [3, 4],
      newTailBufferPosition: [3, 4],
      oldHeadScreenPosition: [4, 3],
      newHeadScreenPosition: [4, 7],
      oldTailScreenPosition: [3, 8],
      newTailScreenPosition: [3, 8],
      wasValid: true,
      isValid: true,
      textChanged: true,
    });

    expect(markerLayer.getMarker(marker.id)).toBe(marker);

    markerChangeEvents = [];
    const foldId = displayLayer.foldBufferRange([
      [0, 2],
      [2, 2],
    ]);

    expect(marker.getBufferRange()).toEqual([
      [3, 4],
      [4, 4],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [1, 8],
      [2, 7],
    ]);
    expect(markerChangeEvents[0]).toEqual({
      oldHeadBufferPosition: [4, 4],
      newHeadBufferPosition: [4, 4],
      oldTailBufferPosition: [3, 4],
      newTailBufferPosition: [3, 4],
      oldHeadScreenPosition: [4, 7],
      newHeadScreenPosition: [2, 7],
      oldTailScreenPosition: [3, 8],
      newTailScreenPosition: [1, 8],
      wasValid: true,
      isValid: true,
      textChanged: false,
    });

    markerChangeEvents = [];
    displayLayer.destroyFold(foldId);

    expect(marker.getBufferRange()).toEqual([
      [3, 4],
      [4, 4],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [3, 8],
      [4, 7],
    ]);
    expect(markerChangeEvents[0]).toEqual({
      oldHeadBufferPosition: [4, 4],
      newHeadBufferPosition: [4, 4],
      oldTailBufferPosition: [3, 4],
      newTailBufferPosition: [3, 4],
      oldHeadScreenPosition: [2, 7],
      newHeadScreenPosition: [4, 7],
      oldTailScreenPosition: [1, 8],
      newTailScreenPosition: [3, 8],
      wasValid: true,
      isValid: true,
      textChanged: false,
    });

    markerChangeEvents = [];
    displayLayer.reset({ tabLength: 3 });

    expect(marker.getBufferRange()).toEqual([
      [3, 4],
      [4, 4],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [3, 6],
      [4, 6],
    ]);
    expect(markerChangeEvents[0]).toEqual({
      oldHeadBufferPosition: [4, 4],
      newHeadBufferPosition: [4, 4],
      oldTailBufferPosition: [3, 4],
      newTailBufferPosition: [3, 4],
      oldHeadScreenPosition: [4, 7],
      newHeadScreenPosition: [4, 6],
      oldTailScreenPosition: [3, 8],
      newTailScreenPosition: [3, 6],
      wasValid: true,
      isValid: true,
      textChanged: false,
    });
  });

  it("caches observed positions and invalidates the cache during buffer edits", function () {
    const buffer = new TextBuffer({ text: "abc\ndef\nghi" });
    const displayLayer = buffer.addDisplayLayer();
    const markerLayer = displayLayer.addMarkerLayer();
    const marker = markerLayer.markBufferRange([
      [1, 1],
      [2, 2],
    ]);
    marker.onDidChange(() => {});

    const rangeReads = spyOn(marker.bufferMarker, "getRange").and.callThrough();
    const translations = spyOn(displayLayer, "translateBufferPosition").and.callThrough();

    expect(marker.getBufferRange()).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(rangeReads).not.toHaveBeenCalled();
    expect(translations).not.toHaveBeenCalled();

    buffer.transact(() => {
      buffer.insert([0, 0], "new\n");
      rangeReads.calls.reset();
      expect(marker.getBufferRange()).toEqual([
        [2, 1],
        [3, 2],
      ]);
      expect(rangeReads).toHaveBeenCalled();
    });

    rangeReads.calls.reset();
    translations.calls.reset();
    expect(marker.getBufferRange()).toEqual([
      [2, 1],
      [3, 2],
    ]);
    expect(marker.getScreenRange()).toEqual([
      [2, 1],
      [3, 2],
    ]);
    expect(rangeReads).not.toHaveBeenCalled();
    expect(translations).not.toHaveBeenCalled();

    const cachedHead = marker.getHeadBufferPosition();
    cachedHead.column = 99;
    expect(marker.getHeadBufferPosition()).toEqual([3, 2]);
  });

  it("only translates endpoints that move in a direct marker change", function () {
    const buffer = new TextBuffer({ text: "abcdef" });
    const displayLayer = buffer.addDisplayLayer();
    const marker = displayLayer.addMarkerLayer().markBufferRange([
      [0, 1],
      [0, 3],
    ]);
    marker.onDidChange(() => {});
    const translations = spyOn(displayLayer, "translateBufferPosition").and.callThrough();

    marker.setHeadBufferPosition([0, 4]);

    expect(translations.calls.count()).toBe(1);
    expect(marker.getScreenRange()).toEqual([
      [0, 1],
      [0, 4],
    ]);
  });

  it("keeps every display marker current after a reentrant buffer-marker change", function () {
    const buffer = new TextBuffer({ text: "abcdef" });
    const bufferMarkerLayer = buffer.addMarkerLayer();
    const bufferMarker = bufferMarkerLayer.markPosition([0, 0]);
    const displayMarker1 = buffer
      .addDisplayLayer()
      .getMarkerLayer(bufferMarkerLayer.id)
      .getMarker(bufferMarker.id);
    const displayMarker2 = buffer
      .addDisplayLayer()
      .getMarkerLayer(bufferMarkerLayer.id)
      .getMarker(bufferMarker.id);
    let movedReentrantly = false;
    const secondMarkerPositionsDuringFirstCallbacks = [];
    displayMarker1.onDidChange(() => {
      secondMarkerPositionsDuringFirstCallbacks.push(displayMarker2.getHeadBufferPosition());
      if (!movedReentrantly) {
        movedReentrantly = true;
        bufferMarker.setHeadPosition([0, 2]);
      }
    });
    displayMarker2.onDidChange(() => {});

    bufferMarker.setHeadPosition([0, 1]);

    expect(bufferMarker.getHeadPosition()).toEqual([0, 2]);
    expect(secondMarkerPositionsDuringFirstCallbacks).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(displayMarker1.getHeadBufferPosition()).toEqual([0, 2]);
    expect(displayMarker2.getHeadBufferPosition()).toEqual([0, 2]);
  });

  it("invalidates cached screen positions before reset observers run", function () {
    const buffer = new TextBuffer({ text: "a\tb" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const marker = displayLayer.addMarkerLayer().markBufferPosition([0, 2]);
    marker.onDidChange(() => {});
    expect(marker.getHeadScreenPosition()).toEqual([0, 4]);
    let positionDuringReset = null;
    displayLayer.onDidReset(() => {
      positionDuringReset = marker.getHeadScreenPosition();
    });

    displayLayer.reset({ tabLength: 2 });

    expect(positionDuringReset).toEqual([0, 2]);
    expect(marker.getHeadScreenPosition()).toEqual([0, 2]);
  });

  it("lazily refreshes screen positions when an edit changes only the display mapping", function () {
    const buffer = new TextBuffer({ text: "ab" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const marker = displayLayer.addMarkerLayer().markBufferPosition([0, 2]);
    marker.onDidChange(() => {});
    expect(marker.getHeadScreenPosition()).toEqual([0, 2]);

    buffer.setTextInRange(
      [
        [0, 0],
        [0, 1],
      ],
      "\t",
    );

    expect(marker.getHeadBufferPosition()).toEqual([0, 2]);
    expect(marker.getHeadScreenPosition()).toEqual([0, 5]);
  });

  it("does not reuse an endpoint cached before a display-only text change", function () {
    const buffer = new TextBuffer({ text: "abcd" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const marker = displayLayer.addMarkerLayer().markBufferRange([
      [0, 1],
      [0, 2],
    ]);
    marker.onDidChange(() => {});
    expect(marker.getScreenRange()).toEqual([
      [0, 1],
      [0, 2],
    ]);

    buffer.setTextInRange(
      [
        [0, 0],
        [0, 1],
      ],
      "\t",
    );
    marker.setHeadBufferPosition([0, 3]);

    expect(marker.getScreenRange()).toEqual([
      [0, 4],
      [0, 6],
    ]);
  });

  it("invalidates generations again for a reentrant text change", function () {
    const buffer = new TextBuffer({ text: "xabc" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const marker = displayLayer.addMarkerLayer().markBufferPosition([0, 4]);
    let changedReentrantly = false;
    marker.onDidChange(() => {
      if (!changedReentrantly) {
        changedReentrantly = true;
        buffer.setTextInRange(
          [
            [0, 1],
            [0, 2],
          ],
          "\t",
        );
      }
    });

    buffer.insert([0, 0], "y");

    expect(buffer.getText()).toBe("y\tabc");
    expect(marker.getHeadBufferPosition()).toEqual([0, 5]);
    expect(marker.getHeadScreenPosition()).toEqual([0, 7]);
  });

  it("invalidates cached screen positions before fold-change observers run", function () {
    const buffer = new TextBuffer({ text: "abc\ndef\nghi" });
    const displayLayer = buffer.addDisplayLayer();
    const marker = displayLayer.addMarkerLayer().markBufferPosition([2, 1]);
    marker.onDidChange(() => {});
    expect(marker.getHeadScreenPosition()).toEqual([2, 1]);
    let positionDuringChange = null;
    displayLayer.onDidChange(() => {
      positionDuringChange = marker.getHeadScreenPosition();
    });

    displayLayer.foldBufferRange([
      [0, 1],
      [1, 1],
    ]);

    expect(positionDuringChange).toEqual([1, 1]);
    expect(marker.getHeadScreenPosition()).toEqual([1, 1]);
  });

  it("keeps buffer-position caches dirty when a change observer throws", function () {
    const buffer = new TextBuffer({ text: "abcdef" });
    const displayLayer = buffer.addDisplayLayer();
    const markerLayer = displayLayer.addMarkerLayer();
    const marker1 = markerLayer.markBufferPosition([0, 1]);
    const marker2 = markerLayer.markBufferPosition([0, 3]);
    marker1.onDidChange(() => {
      throw new Error("marker observer");
    });
    marker2.onDidChange(() => {});

    expect(() => buffer.insert([0, 0], "x")).toThrowError("marker observer");

    expect(markerLayer.bufferMarkerPositionsDirty).toBe(true);
    expect(marker2.getHeadBufferPosition()).toEqual(marker2.bufferMarker.getHeadPosition());
    expect(marker2.getHeadBufferPosition()).toEqual([0, 4]);
  });

  it("keeps screen-position caches dirty when a fold observer throws", function () {
    const buffer = new TextBuffer({ text: "abc\ndef\nghi\njkl" });
    const displayLayer = buffer.addDisplayLayer();
    const markerLayer = displayLayer.addMarkerLayer();
    const marker1 = markerLayer.markBufferPosition([2, 0]);
    const marker2 = markerLayer.markBufferPosition([3, 1]);
    marker1.onDidChange(() => {
      throw new Error("fold observer");
    });
    marker2.onDidChange(() => {});

    expect(() =>
      displayLayer.foldBufferRange([
        [0, 1],
        [1, 1],
      ]),
    ).toThrowError("fold observer");

    expect(markerLayer.screenPositionsDirty).toBe(true);
    expect(marker2.getHeadScreenPosition()).toEqual(
      displayLayer.translateBufferPosition(marker2.bufferMarker.getHeadPosition()),
    );
    expect(marker2.getHeadScreenPosition()).toEqual([2, 1]);
  });

  it("does not create duplicate DisplayMarkers when it has onDidCreateMarker observers (regression)", function () {
    const buffer = new TextBuffer({ text: "abc\ndef\nghi\nj\tk\tl\nmno" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const markerLayer = displayLayer.addMarkerLayer();

    let emittedMarker = null;
    markerLayer.onDidCreateMarker((marker) => (emittedMarker = marker));

    const createdMarker = markerLayer.markBufferRange([
      [0, 1],
      [2, 3],
    ]);
    expect(createdMarker).toBe(emittedMarker);
  });

  it("emits events when markers are created and destroyed", function () {
    const buffer = new TextBuffer({ text: "hello world" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const markerLayer = displayLayer.addMarkerLayer();
    const createdMarkers = [];
    markerLayer.onDidCreateMarker((m) => createdMarkers.push(m));
    const marker = markerLayer.markScreenRange([
      [0, 4],
      [1, 4],
    ]);

    expect(createdMarkers).toEqual([marker]);

    let destroyEventCount = 0;
    marker.onDidDestroy(() => destroyEventCount++);

    marker.destroy();
    expect(destroyEventCount).toBe(1);
  });

  it("emits update events when markers are created, updated directly, updated indirectly, or destroyed", function (done) {
    const buffer = new TextBuffer({ text: "hello world" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const markerLayer = displayLayer.addMarkerLayer();
    let marker = null;

    let updateEventCount = 0;
    markerLayer.onDidUpdate(function () {
      updateEventCount++;
      if (updateEventCount === 1) {
        marker.setScreenRange([
          [0, 5],
          [1, 0],
        ]);
      } else if (updateEventCount === 2) {
        buffer.insert([0, 0], "\t");
      } else if (updateEventCount === 3) {
        marker.destroy();
      } else if (updateEventCount === 4) {
        done();
      }
    });

    buffer.transact(
      () =>
        (marker = markerLayer.markScreenRange([
          [0, 4],
          [1, 4],
        ])),
    );
  });

  it("allows markers to be copied", function () {
    const buffer = new TextBuffer({ text: "\ta\tbc\tdef\tg\n\th" });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const markerLayer = displayLayer.addMarkerLayer();

    const markerA = markerLayer.markScreenRange(
      [
        [0, 4],
        [1, 4],
      ],
      { a: 1, b: 2 },
    );
    const markerB = markerA.copy({ b: 3, c: 4 });

    expect(markerB.id).not.toBe(markerA.id);
    expect(markerB.getProperties()).toEqual({ a: 1, b: 3, c: 4 });
    expect(markerB.getScreenRange()).toEqual(markerA.getScreenRange());
  });

  describe("::destroy()", function () {
    it("only destroys the underlying buffer MarkerLayer if the DisplayMarkerLayer was created by calling addMarkerLayer on its parent DisplayLayer", function () {
      const buffer = new TextBuffer({ text: "abc\ndef\nghi\nj\tk\tl\nmno" });
      const displayLayer1 = buffer.addDisplayLayer({ tabLength: 2 });
      const displayLayer2 = buffer.addDisplayLayer({ tabLength: 4 });
      const bufferMarkerLayer = buffer.addMarkerLayer();
      const bufferMarker1 = bufferMarkerLayer.markRange([
        [2, 1],
        [2, 2],
      ]);
      const displayMarkerLayer1 = displayLayer1.getMarkerLayer(bufferMarkerLayer.id);
      const displayMarker1 = displayMarkerLayer1.markBufferRange([
        [1, 0],
        [1, 2],
      ]);
      const displayMarkerLayer2 = displayLayer2.getMarkerLayer(bufferMarkerLayer.id);
      const displayMarker2 = displayMarkerLayer2.markBufferRange([
        [2, 0],
        [2, 1],
      ]);
      const displayMarkerLayer3 = displayLayer2.addMarkerLayer();
      const displayMarker3 = displayMarkerLayer3.markBufferRange([
        [0, 0],
        [0, 0],
      ]);

      let displayMarkerLayer1DestroyEventCount = 0;
      displayMarkerLayer1.onDidDestroy(() => displayMarkerLayer1DestroyEventCount++);
      let displayMarkerLayer2DestroyEventCount = 0;
      displayMarkerLayer2.onDidDestroy(() => displayMarkerLayer2DestroyEventCount++);
      let displayMarkerLayer3DestroyEventCount = 0;
      displayMarkerLayer3.onDidDestroy(() => displayMarkerLayer3DestroyEventCount++);

      displayMarkerLayer1.destroy();
      expect(bufferMarkerLayer.isDestroyed()).toBe(false);
      expect(displayMarkerLayer1.isDestroyed()).toBe(true);
      expect(displayMarkerLayer1DestroyEventCount).toBe(1);
      expect(bufferMarker1.isDestroyed()).toBe(false);
      expect(displayMarker1.isDestroyed()).toBe(true);
      expect(displayMarker2.isDestroyed()).toBe(false);
      expect(displayMarker3.isDestroyed()).toBe(false);

      displayMarkerLayer2.destroy();
      expect(bufferMarkerLayer.isDestroyed()).toBe(false);
      expect(displayMarkerLayer2.isDestroyed()).toBe(true);
      expect(displayMarkerLayer2DestroyEventCount).toBe(1);
      expect(bufferMarker1.isDestroyed()).toBe(false);
      expect(displayMarker1.isDestroyed()).toBe(true);
      expect(displayMarker2.isDestroyed()).toBe(true);
      expect(displayMarker3.isDestroyed()).toBe(false);

      bufferMarkerLayer.destroy();
      expect(bufferMarkerLayer.isDestroyed()).toBe(true);
      expect(displayMarkerLayer1DestroyEventCount).toBe(1);
      expect(displayMarkerLayer2DestroyEventCount).toBe(1);
      expect(bufferMarker1.isDestroyed()).toBe(true);
      expect(displayMarker1.isDestroyed()).toBe(true);
      expect(displayMarker2.isDestroyed()).toBe(true);
      expect(displayMarker3.isDestroyed()).toBe(false);

      displayMarkerLayer3.destroy();
      expect(displayMarkerLayer3.bufferMarkerLayer.isDestroyed()).toBe(true);
      expect(displayMarkerLayer3.isDestroyed()).toBe(true);
      expect(displayMarkerLayer3DestroyEventCount).toBe(1);
      expect(displayMarker3.isDestroyed()).toBe(true);
    });

    it("destroys the layer's markers", function () {
      const buffer = new TextBuffer();
      const displayLayer = buffer.addDisplayLayer();
      const displayMarkerLayer = displayLayer.addMarkerLayer();

      const marker1 = displayMarkerLayer.markBufferRange([
        [0, 0],
        [0, 0],
      ]);
      const marker2 = displayMarkerLayer.markBufferRange([
        [0, 0],
        [0, 0],
      ]);

      const destroyListener = jasmine.createSpy("onDidDestroy listener");
      marker1.onDidDestroy(destroyListener);

      displayMarkerLayer.destroy();

      expect(destroyListener).toHaveBeenCalled();
      expect(marker1.isDestroyed()).toBe(true);

      // Markers states are updated regardless of whether they have an
      // ::onDidDestroy listener
      expect(marker2.isDestroyed()).toBe(true);
    });
  });

  it("destroys display markers when their underlying buffer markers are destroyed", function () {
    const buffer = new TextBuffer({ text: "\tabc" });
    const displayLayer1 = buffer.addDisplayLayer({ tabLength: 2 });
    const displayLayer2 = buffer.addDisplayLayer({ tabLength: 4 });
    const bufferMarkerLayer = buffer.addMarkerLayer();
    const displayMarkerLayer1 = displayLayer1.getMarkerLayer(bufferMarkerLayer.id);
    const displayMarkerLayer2 = displayLayer2.getMarkerLayer(bufferMarkerLayer.id);

    const bufferMarker = bufferMarkerLayer.markRange([
      [0, 1],
      [0, 2],
    ]);

    const displayMarker1 = displayMarkerLayer1.getMarker(bufferMarker.id);
    const displayMarker2 = displayMarkerLayer2.getMarker(bufferMarker.id);
    expect(displayMarker1.getScreenRange()).toEqual([
      [0, 2],
      [0, 3],
    ]);
    expect(displayMarker2.getScreenRange()).toEqual([
      [0, 4],
      [0, 5],
    ]);

    let displayMarker1DestroyCount = 0;
    let displayMarker2DestroyCount = 0;
    displayMarker1.onDidDestroy(() => displayMarker1DestroyCount++);
    displayMarker2.onDidDestroy(() => displayMarker2DestroyCount++);

    bufferMarker.destroy();
    expect(displayMarker1DestroyCount).toBe(1);
    expect(displayMarker2DestroyCount).toBe(1);
  });

  it("does not throw exceptions when buffer markers are destroyed that don't have corresponding display markers", function () {
    const buffer = new TextBuffer({ text: "\tabc" });
    const displayLayer1 = buffer.addDisplayLayer({ tabLength: 2 });
    const displayLayer2 = buffer.addDisplayLayer({ tabLength: 4 });
    const bufferMarkerLayer = buffer.addMarkerLayer();
    displayLayer1.getMarkerLayer(bufferMarkerLayer.id);
    displayLayer2.getMarkerLayer(bufferMarkerLayer.id);

    const bufferMarker = bufferMarkerLayer.markRange([
      [0, 1],
      [0, 2],
    ]);
    bufferMarker.destroy();
  });

  it("destroys itself when the underlying buffer marker layer is destroyed", function () {
    const buffer = new TextBuffer({ text: "abc\ndef\nghi\nj\tk\tl\nmno" });
    const displayLayer1 = buffer.addDisplayLayer({ tabLength: 2 });
    const displayLayer2 = buffer.addDisplayLayer({ tabLength: 4 });

    const bufferMarkerLayer = buffer.addMarkerLayer();
    const displayMarkerLayer1 = displayLayer1.getMarkerLayer(bufferMarkerLayer.id);
    const displayMarkerLayer2 = displayLayer2.getMarkerLayer(bufferMarkerLayer.id);
    let displayMarkerLayer1DestroyEventCount = 0;
    displayMarkerLayer1.onDidDestroy(() => displayMarkerLayer1DestroyEventCount++);
    let displayMarkerLayer2DestroyEventCount = 0;
    displayMarkerLayer2.onDidDestroy(() => displayMarkerLayer2DestroyEventCount++);

    bufferMarkerLayer.destroy();
    expect(displayMarkerLayer1.isDestroyed()).toBe(true);
    expect(displayMarkerLayer1DestroyEventCount).toBe(1);
    expect(displayMarkerLayer2.isDestroyed()).toBe(true);
    expect(displayMarkerLayer2DestroyEventCount).toBe(1);
  });

  describe("findMarkers(params)", function () {
    let markerLayer, displayLayer;

    beforeEach(function () {
      const buffer = new TextBuffer({ text: SampleText });
      displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
      markerLayer = displayLayer.addMarkerLayer();
    });

    it("allows the startBufferRow and endBufferRow to be specified", function () {
      const marker1 = markerLayer.markBufferRange(
        [
          [0, 0],
          [3, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [0, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      const marker3 = markerLayer.markBufferRange(
        [
          [9, 0],
          [10, 0],
        ],
        { class: "b" },
      );

      expect(markerLayer.findMarkers({ class: "a", startBufferRow: 0 })).toEqual([
        marker2,
        marker1,
      ]);
      expect(markerLayer.findMarkers({ class: "a", startBufferRow: 0, endBufferRow: 3 })).toEqual([
        marker1,
      ]);
      expect(markerLayer.findMarkers({ endBufferRow: 10 })).toEqual([marker3]);
    });

    it("allows the startScreenRow and endScreenRow to be specified", function () {
      const marker1 = markerLayer.markBufferRange(
        [
          [6, 0],
          [7, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [9, 0],
          [10, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(markerLayer.findMarkers({ class: "a", startScreenRow: 6, endScreenRow: 7 })).toEqual([
        marker2,
      ]);

      displayLayer.destroyFoldsIntersectingBufferRange([
        [4, 0],
        [7, 0],
      ]);
      displayLayer.foldBufferRange([
        [0, 20],
        [12, 2],
      ]);
      const marker3 = markerLayer.markBufferRange(
        [
          [12, 0],
          [12, 0],
        ],
        { class: "a" },
      );
      expect(markerLayer.findMarkers({ class: "a", startScreenRow: 0 })).toEqual([
        marker1,
        marker2,
        marker3,
      ]);
      expect(markerLayer.findMarkers({ class: "a", endScreenRow: 0 })).toEqual([
        marker1,
        marker2,
        marker3,
      ]);
    });

    it("allows the startsInBufferRange/endsInBufferRange and startsInScreenRange/endsInScreenRange to be specified", function () {
      const marker1 = markerLayer.markBufferRange(
        [
          [5, 2],
          [5, 4],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 2],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          startsInBufferRange: [
            [5, 1],
            [5, 3],
          ],
        }),
      ).toEqual([marker1]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          endsInBufferRange: [
            [8, 1],
            [8, 3],
          ],
        }),
      ).toEqual([marker2]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          startsInScreenRange: [
            [4, 0],
            [4, 1],
          ],
        }),
      ).toEqual([marker1]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          endsInScreenRange: [
            [5, 1],
            [5, 3],
          ],
        }),
      ).toEqual([marker2]);
    });

    it("allows intersectsBufferRowRange to be specified", function () {
      const marker1 = markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(markerLayer.findMarkers({ class: "a", intersectsBufferRowRange: [5, 6] })).toEqual([
        marker1,
      ]);
    });

    it("allows intersectsScreenRowRange to be specified", function () {
      const marker1 = markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(markerLayer.findMarkers({ class: "a", intersectsScreenRowRange: [5, 10] })).toEqual([
        marker2,
      ]);

      displayLayer.destroyAllFolds();
      displayLayer.foldBufferRange([
        [0, 20],
        [12, 2],
      ]);
      expect(markerLayer.findMarkers({ class: "a", intersectsScreenRowRange: [0, 0] })).toEqual([
        marker1,
        marker2,
      ]);

      displayLayer.destroyAllFolds();
      displayLayer.reset({ softWrapColumn: 10 });
      marker1.setHeadScreenPosition([6, 5]);
      marker2.setHeadScreenPosition([9, 2]);
      expect(markerLayer.findMarkers({ class: "a", intersectsScreenRowRange: [5, 7] })).toEqual([
        marker1,
      ]);
    });

    it("allows containedInScreenRange to be specified", function () {
      markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          containedInScreenRange: [
            [5, 0],
            [7, 0],
          ],
        }),
      ).toEqual([marker2]);
    });

    it("allows intersectsBufferRange to be specified", function () {
      const marker1 = markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          intersectsBufferRange: [
            [5, 0],
            [6, 0],
          ],
        }),
      ).toEqual([marker1]);
    });

    it("allows intersectsScreenRange to be specified", function () {
      markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          intersectsScreenRange: [
            [5, 0],
            [10, 0],
          ],
        }),
      ).toEqual([marker2]);
    });

    it("allows containsBufferPosition to be specified", function () {
      markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(markerLayer.findMarkers({ class: "a", containsBufferPosition: [8, 0] })).toEqual([
        marker2,
      ]);
    });

    it("allows containsScreenPosition to be specified", function () {
      markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 0],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 0],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(markerLayer.findMarkers({ class: "a", containsScreenPosition: [5, 0] })).toEqual([
        marker2,
      ]);
    });

    it("allows containsBufferRange to be specified", function () {
      markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 10],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 10],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          containsBufferRange: [
            [8, 2],
            [8, 4],
          ],
        }),
      ).toEqual([marker2]);
    });

    it("allows containsScreenRange to be specified", function () {
      markerLayer.markBufferRange(
        [
          [5, 0],
          [5, 10],
        ],
        { class: "a" },
      );
      const marker2 = markerLayer.markBufferRange(
        [
          [8, 0],
          [8, 10],
        ],
        { class: "a" },
      );
      displayLayer.foldBufferRange([
        [4, 0],
        [7, 0],
      ]);
      expect(
        markerLayer.findMarkers({
          class: "a",
          containsScreenRange: [
            [5, 2],
            [5, 4],
          ],
        }),
      ).toEqual([marker2]);
    });

    it("works when used from within a Marker.onDidDestroy callback (regression)", function () {
      const displayMarker = markerLayer.markBufferRange([
        [0, 3],
        [0, 6],
      ]);
      displayMarker.onDidDestroy(() =>
        expect(markerLayer.findMarkers({ containsBufferPosition: [0, 4] })).not.toContain(
          displayMarker,
        ),
      );
      displayMarker.destroy();
    });
  });
});
