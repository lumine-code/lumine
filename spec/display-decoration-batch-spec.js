const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

describe("Decoration screen-range batches", () => {
  let editor;
  let component;
  let buffer;

  afterEach(() => {
    component?.element.remove();
    editor?.destroy();
    if (buffer && !buffer.isDestroyed()) buffer.destroy();
  });

  function build(markers = 80, text = "alpha beta/gamma delta ".repeat(100)) {
    buffer = new TextBuffer({ text });
    editor = new TextEditor({ buffer, maxScreenLineLength: 50 });
    const layer = editor.addMarkerLayer();
    const result = [];
    for (let index = 0; index < markers; index++) {
      const start = index * 3 + 1;
      const marker = layer.markBufferRange([
        [0, start],
        [0, start + 2],
      ]);
      editor.decorateMarker(marker, { type: "highlight", class: "batch-spec" });
      result.push(marker);
    }
    component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
    component.element.style.width = "800px";
    component.element.style.height = "600px";
    jasmine.attachToDOM(component.element);
    component.updateSync();
    spyOn(component, "getRenderedStartRow").and.returnValue(0);
    spyOn(component, "getRenderedEndRow").and.callFake(() => editor.getScreenLineCount());
    return result;
  }

  function captureRanges(callback) {
    const ranges = new Map();
    spyOn(component, "addDecorationToRender").and.callFake((_type, _decoration, marker, range) => {
      ranges.set(marker, range);
      callback?.(marker, range);
    });
    component.queryDecorationsToRender();
    return ranges;
  }

  it("batches uncached decorations while retaining observed marker getters", () => {
    const markers = build();
    const observed = markers.slice(0, 4);
    for (const marker of observed) marker.onDidChange(() => {});
    const expected = new Map(markers.map((marker) => [marker, marker.getScreenRange()]));
    const observedReads = observed.map((marker) =>
      spyOn(marker, "getScreenRange").and.callThrough(),
    );
    const batch = spyOn(editor.displayLayer, "translateBufferPositions").and.callThrough();
    const ranges = captureRanges();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.calls.mostRecent().args[0].length).toBe((markers.length - observed.length) * 2);
    for (const read of observedReads) expect(read).toHaveBeenCalled();
    for (const marker of markers) expect(ranges.get(marker)).toEqual(expected.get(marker));
  });

  it("keeps small decoration sets on their existing getters", () => {
    const markers = build(16);
    const reads = spyOn(markers[0], "getScreenRange").and.callThrough();
    const batch = spyOn(editor.displayLayer, "translateBufferPositions").and.callThrough();
    captureRanges();
    expect(batch).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalled();
  });

  it("does not batch identity geometry or custom width callbacks", () => {
    build();
    const batch = spyOn(editor.displayLayer, "translateBufferPositions").and.callThrough();
    editor.displayLayer.reset({ softWrapColumn: Infinity });
    captureRanges();
    expect(batch).not.toHaveBeenCalled();
    editor.displayLayer.reset({ softWrapColumn: 50, ratioForCharacter: () => 1 });
    component.queryDecorationsToRender();
    expect(batch).not.toHaveBeenCalled();
  });

  it("re-reads a marker moved reentrantly after the batch was prepared", () => {
    const markers = build();
    const first = markers[0];
    const changed = markers[1];
    let moved = false;
    const batch = spyOn(editor.displayLayer, "translateBufferPositions").and.callThrough();
    const ranges = captureRanges((marker) => {
      if (marker === first && !moved) {
        moved = true;
        changed.setBufferRange([
          [0, 1000],
          [0, 1002],
        ]);
      }
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(moved).toBe(true);
    expect(ranges.get(changed)).toEqual(changed.getScreenRange());
  });

  it("re-reads later ranges after a reentrant layout change", () => {
    const markers = build();
    let changed = false;
    const ranges = captureRanges((marker) => {
      if (marker === markers[0] && !changed) {
        changed = true;
        editor.displayLayer.reset({ softWrapColumn: 25 });
      }
    });
    expect(changed).toBe(true);
    for (const marker of markers.slice(1)) {
      expect(ranges.get(marker)).toEqual(marker.getScreenRange());
    }
  });

  it("does not bless stale marker points when cold CJK layout reenters a marker move", () => {
    buffer = new TextBuffer({ text: "a".repeat(100) + "\n我" + "a".repeat(100) });
    editor = new TextEditor({ buffer, maxScreenLineLength: 5 });
    component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
    const markers = [];
    const decorations = new Map();
    for (let index = 0; index < 40; index++) {
      const marker = editor.markBufferRange([
        [1, index + 1],
        [1, index + 2],
      ]);
      markers.push(marker);
      decorations.set(marker, [{ type: "highlight", class: "cold-cjk-spec" }]);
    }
    editor.displayLayer.reset({ softWrapColumn: 5 });
    editor.displayLayer.populateSpatialIndexIfNeeded(1, Infinity);
    const changed = markers[1];
    const originalWidth = editor.getDoubleWidthCharWidth.bind(editor);
    let moved = false;
    spyOn(editor, "getDoubleWidthCharWidth").and.callFake(() => {
      if (!moved) {
        moved = true;
        changed.setBufferRange([
          [1, 70],
          [1, 72],
        ]);
      }
      return originalWidth();
    });
    spyOn(
      editor.decorationManager,
      "decorationPropertiesByMarkerForScreenRowRange",
    ).and.returnValue(decorations);
    const ranges = captureRanges();
    expect(moved).toBe(true);
    expect(ranges.get(changed)).toEqual(changed.getScreenRange());
  });

  it("respects direct atomic-soft-tab toggles used by column selection", () => {
    const markers = build(80, "    " + "alpha beta/gamma delta ".repeat(100));
    const changed = markers[1];
    changed.setBufferRange([
      [0, 1],
      [0, 2],
    ]);
    const decorations = new Map(
      markers.map((marker) => [marker, [{ type: "highlight", class: "atomic-spec" }]]),
    );
    spyOn(
      editor.decorationManager,
      "decorationPropertiesByMarkerForScreenRowRange",
    ).and.returnValue(decorations);
    let toggled = false;
    const ranges = captureRanges((marker) => {
      if (marker === markers[0] && !toggled) {
        toggled = true;
        editor.displayLayer.atomicSoftTabs = false;
      }
    });
    expect(toggled).toBe(true);
    expect(ranges.get(changed)).toEqual([
      [0, 1],
      [0, 2],
    ]);
    expect(ranges.get(changed)).toEqual(changed.getScreenRange());
  });
});
