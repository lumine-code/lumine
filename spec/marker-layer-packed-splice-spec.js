const TextBuffer = require("../src/text-buffer");
const MarkerLayer = require("../src/marker-layer");
const Point = require("../src/point");

const Flags = { touch: 1, inside: 2, overlap: 4, surround: 8 };
const Strategies = ["never", "surround", "overlap", "inside", "touch", "custom"];

// Exercise the facade with an older installed addon as well. Once the native
// method is installed, the same scenarios call it directly on each index.
function encodeInvalidations(invalidated) {
  if (invalidated.touch.size === 0) return null;
  const result = new Uint32Array(invalidated.touch.size * 2);
  let offset = 0;
  for (const id of invalidated.touch) {
    result[offset++] = id;
    let flags = 0;
    for (const [strategy, flag] of Object.entries(Flags)) {
      if (invalidated[strategy].has(id)) flags |= flag;
    }
    result[offset++] = flags;
  }
  return result;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("MarkerLayer packed splice", () => {
  let contexts;

  beforeEach(() => {
    contexts = [];
  });

  afterEach(() => {
    for (const context of contexts) context.buffer.destroy();
  });

  function createContext(packed, options) {
    const buffer = new TextBuffer({ text: "abcdefghij\nklmnopqrst\nuvwxyzabcd\n0123456789" });
    const layer = buffer.addMarkerLayer({ maintainHistory: true, persistent: true, ...options });
    const displayLayer = buffer.addDisplayLayer({ tabLength: 4 });
    const displayMarkerLayer = displayLayer.getMarkerLayer(layer.id);
    const context = {
      buffer,
      layer,
      displayMarkerLayer,
      markers: [],
      trace: [],
      packedResults: [],
    };
    contexts.push(context);
    const { trace } = context;
    const index = layer.index;
    const splice = index.splice.bind(index);
    const splicePacked = index.splicePacked?.bind(index);
    const recordSplice = (start, oldExtent, newExtent) => {
      trace.push(["splice", start.serialize(), oldExtent.serialize(), newExtent.serialize()]);
    };

    Object.defineProperty(index, "splicePacked", {
      configurable: true,
      value: packed
        ? (start, oldExtent, newExtent) => {
            recordSplice(start, oldExtent, newExtent);
            const result = splicePacked
              ? splicePacked(start, oldExtent, newExtent)
              : encodeInvalidations(splice(start, oldExtent, newExtent));
            context.packedResults.push(result === null ? null : [...result]);
            return result;
          }
        : undefined,
    });
    Object.defineProperty(index, "splice", {
      configurable: true,
      value: (start, oldExtent, newExtent) => {
        if (packed) throw new Error("Packed facade called the legacy splice method");
        recordSplice(start, oldExtent, newExtent);
        return splice(start, oldExtent, newExtent);
      },
    });
    const findIntersecting = index.findIntersecting.bind(index);
    Object.defineProperty(index, "findIntersecting", {
      configurable: true,
      value: (start, end) => {
        trace.push(["intersect", start.serialize(), end.serialize()]);
        return findIntersecting(start, end);
      },
    });
    for (const method of ["bufferMarkerRangesDidChange", "didEmitBufferMarkerChangeEvents"]) {
      const original = displayMarkerLayer[method].bind(displayMarkerLayer);
      spyOn(displayMarkerLayer, method).and.callFake(() => {
        trace.push([method]);
        return original();
      });
    }
    layer.onDidUpdate(() => trace.push(["layer-update"]));
    layer.onDidCreateMarker((marker) => trace.push(["marker-create", marker.id]));
    buffer.onDidChange((event) => trace.push(["buffer-change", plain(event)]));
    displayLayer.onDidChange((event) => trace.push(["display-change", plain(event)]));

    context.mark = (range, markerOptions = {}, position = false) => {
      const marker = position
        ? layer.markPosition(range, markerOptions)
        : layer.markRange(range, markerOptions);
      context.markers.push(marker);
      for (const method of ["getInvalidationStrategy", "refreshHistoryProps", "destroy"]) {
        const original = marker[method].bind(marker);
        spyOn(marker, method).and.callFake((...args) => {
          trace.push([method, marker.id]);
          return original(...args);
        });
      }
      marker.onDidChange((event) => trace.push(["marker-change", marker.id, plain(event)]));
      marker.onDidDestroy(() => trace.push(["marker-destroy", marker.id]));
      const displayMarker = displayMarkerLayer.getMarker(marker.id);
      displayMarker.onDidChange((event) =>
        trace.push(["display-marker-change", marker.id, plain(event)]),
      );
      displayMarker.onDidDestroy(() => trace.push(["display-marker-destroy", marker.id]));
      // Populate the observed-position caches before the text changes.
      displayMarker.getHeadBufferPosition();
      displayMarker.getTailBufferPosition();
      displayMarker.getHeadScreenPosition();
      displayMarker.getTailScreenPosition();
      return marker;
    };
    return context;
  }

  function pair(setup, options) {
    const result = [createContext(false, options), createContext(true, options)];
    for (const context of result) {
      setup(context);
      context.trace.length = 0;
    }
    return result;
  }

  function state(context) {
    const { buffer, layer, markers, displayMarkerLayer } = context;
    for (const marker of markers) {
      if (!marker.isDestroyed()) expect(layer.getMarker(marker.id)).toBe(marker);
    }
    return {
      text: buffer.getText(),
      serialized: plain(layer.serialize()),
      markers: markers.map((marker) => ({
        id: marker.id,
        destroyed: marker.isDestroyed(),
        range: marker.getRange().serialize(),
        valid: marker.isValid(),
        historyValid: marker.historyProps?.valid,
      })),
      historyShadow: layer.historyShadow ? [...layer.historyShadow] : null,
      displayRanges: markers.map((marker) =>
        marker.isDestroyed()
          ? null
          : displayMarkerLayer.getMarker(marker.id).getScreenRange().serialize(),
      ),
      bufferPositionsDirty: displayMarkerLayer.bufferMarkerPositionsDirty,
      screenPositionsDirty: displayMarkerLayer.screenPositionsDirty,
      bufferGeneration: displayMarkerLayer.bufferMarkerPositionGeneration,
      screenGeneration: displayMarkerLayer.screenPositionGeneration,
    };
  }

  function compare(result, action) {
    for (const context of result) action(context);
    expect(result[1].trace).toEqual(result[0].trace);
    expect(state(result[1])).toEqual(state(result[0]));
  }

  for (const destroyInvalidatedMarkers of [false, true]) {
    it(`preserves invalidation, boundary, history and event semantics with destruction ${destroyInvalidatedMarkers}`, () => {
      const result = pair(
        ({ mark }) => {
          for (const invalidate of Strategies) {
            for (const exclusive of [false, true]) {
              for (const range of [
                [
                  [0, 0],
                  [0, 1],
                ],
                [
                  [0, 2],
                  [0, 4],
                ],
                [
                  [0, 2],
                  [0, 8],
                ],
                [
                  [0, 5],
                  [0, 6],
                ],
                [
                  [0, 7],
                  [0, 9],
                ],
                [
                  [1, 2],
                  [1, 5],
                ],
                [
                  [0, 4],
                  [0, 4],
                ],
              ]) {
                mark(range, { invalidate, exclusive, reversed: !exclusive, label: invalidate });
              }
              mark([0, 4], { invalidate, exclusive }, true);
              mark([0, 7], { invalidate, exclusive }, true);
            }
          }
        },
        { destroyInvalidatedMarkers },
      );
      for (const [range, text] of [
        [
          [
            [0, 4],
            [0, 4],
          ],
          "X",
        ],
        [
          [
            [0, 4],
            [0, 7],
          ],
          "YZ",
        ],
        [
          [
            [0, 4],
            [1, 4],
          ],
          "Q\nRS",
        ],
      ]) {
        compare(result, ({ buffer }) => buffer.setTextInRange(range, text));
        compare(result, ({ buffer }) => buffer.undo());
        compare(result, ({ buffer }) => buffer.redo());
        compare(result, ({ buffer }) => buffer.undo());
      }
      expect(result[1].packedResults.length).toBeGreaterThan(0);
      const trace = result[1].trace;
      const firstSplice = trace.findIndex(([event]) => event === "splice");
      expect(trace[firstSplice - 1]).toEqual(["bufferMarkerRangesDidChange"]);
      expect(trace[firstSplice - 2][0]).toBe("intersect");
    });
  }

  for (const maintainHistory of [false, true]) {
    it(`keeps null-result geometry changes and display events with history ${maintainHistory}`, () => {
      const result = pair(
        ({ mark }) => {
          mark(
            [
              [1, 2],
              [1, 5],
            ],
            { invalidate: "never" },
          );
          mark([2, 2], { invalidate: "touch" }, true);
        },
        { maintainHistory },
      );
      compare(result, ({ buffer }) => buffer.insert([0, 1], "XX\nYY"));
      expect(result[1].packedResults).toEqual([null]);
      expect(result[1].markers[0].getRange().serialize()).toEqual([
        [2, 2],
        [2, 5],
      ]);
      expect(result[1].trace.some(([event]) => event === "marker-change")).toBe(true);
      expect(result[1].displayMarkerLayer.bufferMarkerPositionsDirty).toBe(false);
      compare(result, ({ buffer }) => buffer.undo());
      compare(result, ({ buffer }) => buffer.redo());
    });
  }

  it("restores marker identities and properties after nested transactions and serialization", () => {
    const result = pair(({ mark }) => {
      mark(
        [
          [0, 3],
          [0, 8],
        ],
        { invalidate: "inside", label: "initial" },
      );
      mark([1, 2], { invalidate: "never" }, true);
    });
    compare(result, ({ buffer, markers, mark }) => {
      buffer.transact(() => {
        buffer.insert([0, 2], "XYZ");
        buffer.transact(() => {
          markers[0].setProperties({ label: "changed" });
          markers[1].setHeadPosition([2, 3]);
          buffer.delete([
            [1, 1],
            [1, 5],
          ]);
          mark(
            [
              [2, 1],
              [2, 5],
            ],
            { invalidate: "touch" },
          );
        });
        markers[1].destroy();
      });
    });
    compare(result, ({ buffer }) => buffer.undo());
    for (const { layer, markers } of result) {
      expect(layer.getMarker(markers[0].id)).toBe(markers[0]);
      expect(layer.getMarker(markers[1].id)).toBe(markers[1]);
      expect(markers[0].getProperties()).toEqual({ label: "initial" });
    }
    compare(result, ({ buffer }) => buffer.redo());
    const restored = result.map(({ buffer, layer }) => {
      const targetBuffer = new TextBuffer({ text: buffer.getText() });
      contexts.push({ buffer: targetBuffer });
      return MarkerLayer.deserialize(targetBuffer, plain(layer.serialize()));
    });
    expect(plain(restored[1].serialize())).toEqual(plain(restored[0].serialize()));
    for (let index = 0; index < restored.length; index++) {
      expect(plain(restored[index].serialize())).toEqual(plain(result[index].layer.serialize()));
      restored[index].destroy();
    }
  });

  it("keeps throwing change listeners and later display caches identical", () => {
    const result = pair(({ mark }) => {
      mark([1, 2], { invalidate: "never" }, true);
      mark([2, 3], { invalidate: "never" }, true);
    });
    const subscriptions = result.map(({ markers }) =>
      markers[0].onDidChange(() => {
        throw new Error("marker observer");
      }),
    );
    compare(result, ({ buffer }) => {
      expect(() => buffer.insert([0, 0], "X\n")).toThrowError("marker observer");
    });
    for (const { displayMarkerLayer, markers } of result) {
      expect(displayMarkerLayer.bufferMarkerPositionsDirty).toBe(true);
      expect(
        displayMarkerLayer.getMarker(markers[1].id).getHeadBufferPosition().serialize(),
      ).toEqual(markers[1].getHeadPosition().serialize());
    }
    for (const subscription of subscriptions) subscription.dispose();
    compare(result, ({ buffer }) => buffer.insert([0, 0], "Y\n"));
    for (const { displayMarkerLayer } of result) {
      expect(displayMarkerLayer.bufferMarkerPositionsDirty).toBe(false);
    }
  });

  it("preserves reentrant text changes and marker destruction in change callbacks", () => {
    const result = pair((context) => {
      const first = context.mark(
        [
          [0, 2],
          [0, 5],
        ],
        { invalidate: "never" },
      );
      const second = context.mark([1, 3], { invalidate: "never" }, true);
      let changed = false;
      first.onDidChange(() => {
        if (changed) return;
        changed = true;
        second.destroy();
        context.buffer.transact(() => context.buffer.insert([2, 0], "XYZ"));
      });
    });
    compare(result, ({ buffer }) => buffer.insert([0, 3], "X"));
    expect(result[1].markers[1].isDestroyed()).toBe(true);
    compare(result, ({ buffer }) => buffer.undo());
    compare(result, ({ buffer }) => buffer.redo());
  });

  it("keeps later touched markers missing after destruction in an earlier destroy callback", () => {
    const result = pair(
      ({ mark }) => {
        const first = mark(
          [
            [0, 2],
            [0, 5],
          ],
          { invalidate: "touch" },
        );
        const second = mark(
          [
            [0, 3],
            [0, 6],
          ],
          { invalidate: "touch" },
        );
        first.onDidDestroy(() => second.destroy());
      },
      { destroyInvalidatedMarkers: true },
    );
    compare(result, ({ layer }) => {
      expect(() => layer.splice(Point(0, 3), Point(0, 1), Point(0, 2))).toThrowError(
        TypeError,
        /getInvalidationStrategy/,
      );
    });
    expect(result[1].markers.every((marker) => marker.isDestroyed())).toBe(true);
  });

  it("propagates a throwing destroy callback before handling later touched markers", () => {
    const result = pair(
      ({ mark }) => {
        mark(
          [
            [0, 2],
            [0, 5],
          ],
          { invalidate: "touch" },
        );
        mark(
          [
            [0, 3],
            [0, 6],
          ],
          { invalidate: "touch" },
        );
      },
      { destroyInvalidatedMarkers: true },
    );
    const subscriptions = result.map(({ markers }) =>
      markers[0].onDidDestroy(() => {
        throw new Error("destroy observer");
      }),
    );
    compare(result, ({ layer }) => {
      expect(() => layer.splice(Point(0, 3), Point(0, 1), Point(0, 2))).toThrowError(
        "destroy observer",
      );
    });
    for (const subscription of subscriptions) subscription.dispose();
    for (const { markers } of result) {
      expect(markers[0].isDestroyed()).toBe(true);
      expect(markers[1].isDestroyed()).toBe(false);
    }
  });

  it("preserves property-key coercion for object-valued invalidation strategies", () => {
    const result = pair(({ mark, trace }) => {
      mark(
        [
          [0, 2],
          [0, 6],
        ],
        {
          invalidate: {
            toString: () => {
              trace.push(["coerce-invalidation-key"]);
              return "inside";
            },
          },
        },
      );
    });
    compare(result, ({ buffer }) => buffer.insert([0, 3], "X"));
    for (const { markers, trace } of result) {
      expect(markers[0].isValid()).toBe(false);
      expect(trace.filter(([event]) => event === "coerce-invalidation-key").length).toBe(1);
    }
  });

  it("preserves errors for numeric invalidation flags inherited from Object.prototype", () => {
    const key = "packedSpliceInheritedFlag";
    Object.defineProperty(Object.prototype, key, { configurable: true, value: 1 });
    try {
      const result = pair(({ mark }) => {
        mark(
          [
            [0, 2],
            [0, 6],
          ],
          { invalidate: key },
        );
      });
      compare(result, ({ layer }) => {
        expect(() => layer.splice(Point(0, 3), Point(0, 1), Point(0, 2))).toThrowError(TypeError);
      });
    } finally {
      delete Object.prototype[key];
    }
  });

  for (const invalidate of ["toString", "constructor", "__proto__"]) {
    it(`preserves the legacy error for inherited invalidation key ${invalidate}`, () => {
      const result = pair(({ mark }) => {
        mark(
          [
            [0, 2],
            [0, 6],
          ],
          { invalidate },
        );
      });
      compare(result, ({ layer }) => {
        expect(() => layer.splice(Point(0, 3), Point(0, 1), Point(0, 2))).toThrowError(TypeError);
      });
    });
  }
});
