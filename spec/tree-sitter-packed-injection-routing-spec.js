const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const { Point, Range } = TextBuffer;

// Use the real addon when present, and the same native scalar coordinates when
// checking the editor's compatibility path against an older installed addon.
function configureRanges(index, packed) {
  const getRange = index.getRange.bind(index);
  const getRanges = index.getRanges?.bind(index);
  const scalar = jasmine.createSpy("scalar ranges").and.callFake(getRange);
  const batch = jasmine.createSpy("packed ranges").and.callFake((ids) => {
    if (getRanges) return getRanges(ids);
    const result = new Uint32Array(ids.length * 4);
    for (let i = 0; i < ids.length; i++) {
      const { start, end } = getRange(ids[i]);
      result.set([start.row, start.column, end.row, end.column], i * 4);
    }
    return result;
  });
  Object.defineProperty(index, "getRange", { configurable: true, value: scalar });
  Object.defineProperty(index, "getRanges", {
    configurable: true,
    value: packed ? batch : undefined,
  });
  return { scalar, batch, getRange };
}

describe("Packed Tree-sitter injection change routing", () => {
  let buffers;

  const source = (count, newline = "\n") =>
    ["prefix = 0", ...Array.from({ length: count }, () => "value = 3"), "suffix = 0"].join(newline);

  function create(packed, count = 64, text = source(count)) {
    const buffer = new TextBuffer({ text });
    buffers.push(buffer);
    const markerLayer = buffer.addMarkerLayer();
    const markers = [];
    // Deliberately differ from document order so each packed tuple must follow
    // its requested marker ID rather than an index traversal order.
    for (let row = count; row > 0; row--) {
      const marker = markerLayer.markRange(new Range([row, 8], [row, 9]));
      marker.languageLayer = {
        currentRangesCache: [marker.getRange()],
        foldResolver: { reset: jasmine.createSpy("reset folds") },
        handleTextChange: jasmine.createSpy("route change"),
      };
      markers.push(marker);
    }
    const mode = Object.assign(Object.create(TreeSitterLanguageMode.prototype), {
      buffer,
      injectionsMarkerLayer: markerLayer,
      rootLanguageLayer: { handleTextChange: jasmine.createSpy("root change") },
      isFoldableCache: [true],
      resolveNextTransaction: () => {},
      transactionChangeCount: 0,
    });
    spyOn(buffer.getLanguageMode(), "bufferDidChange").and.callFake((change) =>
      mode.bufferDidChange(change),
    );
    const ranges = configureRanges(markerLayer.index, packed);
    spyOn(markerLayer, "getMarkers").and.callThrough();
    return { buffer, mode, markers, markerLayer, ranges };
  }

  const routes = ({ markers, mode }) => ({
    root: mode.rootLanguageLayer.handleTextChange.calls.allArgs(),
    children: markers.map((marker) => ({
      changes: marker.languageLayer.handleTextChange.calls.allArgs(),
      resets: marker.languageLayer.foldResolver.reset.calls.count(),
    })),
    folds: mode.isFoldableCache,
  });

  function compare(edit, configure = () => {}) {
    const packed = create(true);
    const scalar = create(false);
    for (const state of [packed, scalar]) {
      configure(state);
      edit(state);
    }
    expect(routes(packed)).toEqual(routes(scalar));
    return packed;
  }

  beforeEach(() => {
    buffers = [];
  });

  afterEach(() => {
    for (const buffer of buffers) buffer.destroy();
  });

  for (const count of [0, 1, 63, 64]) {
    it(`fetches owner ranges in one batch only at the threshold (${count})`, () => {
      const state = create(true, count);
      state.buffer.setTextInRange(
        [
          [0, 0],
          [0, 6],
        ],
        "rename",
      );

      expect(state.markerLayer.getMarkers).toHaveBeenCalledTimes(1);
      expect(state.ranges.batch).toHaveBeenCalledTimes(count >= 64 ? 1 : 0);
      expect(state.ranges.scalar).toHaveBeenCalledTimes(count >= 64 ? 0 : count);
      if (count >= 64) {
        const [ids] = state.ranges.batch.calls.mostRecent().args;
        expect(ids instanceof Uint32Array).toBe(true);
        expect([...ids]).toEqual(state.markers.map((marker) => marker.id));
      }
      for (const marker of state.markers) {
        expect(marker.languageLayer.handleTextChange).not.toHaveBeenCalled();
        expect(marker.languageLayer.foldResolver.reset).toHaveBeenCalledTimes(1);
      }
    });
  }

  it("retains scalar routing when an older addon has no batch method", () => {
    const state = create(false);
    state.buffer.setTextInRange(
      [
        [32, 8],
        [32, 9],
      ],
      "4",
    );

    expect(state.ranges.batch).not.toHaveBeenCalled();
    expect(state.ranges.scalar).toHaveBeenCalledTimes(64);
    expect(
      state.markers.filter((marker) => marker.languageLayer.handleTextChange.calls.any()),
    ).toEqual([state.markers.find((marker) => marker.getRange().start.row === 32)]);
  });

  it("matches scalar routing for leading and trailing owner boundary touches", () => {
    const state = compare(({ buffer }) => {
      buffer.transact(() => {
        buffer.setTextInRange(
          [
            [32, 7],
            [32, 8],
          ],
          "\t",
        );
        buffer.insert([32, 9], "4");
        buffer.insert([32, 8], "5");
      });
    });

    const marker = state.markers.find((entry) => entry.getRange().start.row === 32);
    expect(marker.languageLayer.handleTextChange).toHaveBeenCalledTimes(3);
    expect(state.ranges.batch).toHaveBeenCalledTimes(3);
  });

  it("matches scalar routing through rapid UTF-16, CRLF, row and index shifts", () => {
    const packed = create(true, 64, source(64, "\r\n"));
    const scalar = create(false, 64, source(64, "\r\n"));
    for (const { buffer } of [packed, scalar]) {
      buffer.transact(() => {
        buffer.insert([0, 0], "😀");
        buffer.setTextInRange(
          [
            [0, 0],
            [0, 2],
          ],
          "éé",
        );
        buffer.setTextInRange(
          [
            [0, 0],
            [1, 0],
          ],
          "#\n",
          { normalizeLineEndings: false },
        );
        buffer.insert([0, 0], "#\r\n", { normalizeLineEndings: false });
        buffer.setTextInRange(
          [
            [33, 8],
            [33, 9],
          ],
          "4",
        );
      });
    }

    expect(routes(packed)).toEqual(routes(scalar));
    expect(packed.buffer.getText()).toBe(scalar.buffer.getText());
    expect(packed.ranges.batch).toHaveBeenCalledTimes(5);
  });

  it("keeps custom, combined and unknown included ranges in the routing proof", () => {
    const state = compare(
      ({ buffer }) =>
        buffer.setTextInRange(
          [
            [0, 0],
            [0, 6],
          ],
          "rename",
        ),
      ({ markers }) => {
        markers[0].languageLayer.currentRangesCache = undefined;
        markers[1].languageLayer.currentRangesCache = [];
        markers[2].languageLayer.currentRangesCache = [new Range([0, 0], [0, 6])];
        markers[3].languageLayer.currentRangesCache = [
          markers[3].getRange(),
          new Range([0, 0], [0, 6]),
        ];
      },
    );

    for (const marker of state.markers.slice(0, 4)) {
      expect(marker.languageLayer.handleTextChange).toHaveBeenCalledTimes(1);
    }
    for (const marker of state.markers.slice(4)) {
      expect(marker.languageLayer.handleTextChange).not.toHaveBeenCalled();
    }
  });

  it("invalidates contextual row folds once for skipped unknown content", () => {
    const replacements = [];
    compare(
      ({ buffer }) =>
        buffer.setTextInRange(
          [
            [65, 0],
            [65, 6],
          ],
          "rename",
        ),
      ({ markers, mode }) => {
        let cache = mode.isFoldableCache;
        let count = 0;
        Object.defineProperty(mode, "isFoldableCache", {
          get: () => cache,
          set: (value) => {
            cache = value;
            replacements.push(++count);
          },
        });
        for (const marker of markers) marker.languageLayer.currentRangesCache = undefined;
      },
    );

    expect(replacements).toEqual([1, 1]);
  });

  it("preserves finite UINT32_MAX coordinates when comparing an infinite edit point", () => {
    const packed = create(true);
    const scalar = create(false);
    for (const state of [packed, scalar]) {
      const maximum = 0xffffffff;
      state.markerLayer.index.remove(state.markers[0].id);
      state.markerLayer.index.insert(
        state.markers[0].id,
        new Point(maximum, maximum),
        new Point(maximum, maximum),
      );
      state.mode.bufferDidChange({
        oldRange: new Range(Point.INFINITY, Point.INFINITY),
        newRange: new Range(Point.INFINITY, Point.INFINITY),
        oldText: "x",
        newText: "y",
      });
      expect(state.markers[0].languageLayer.handleTextChange).not.toHaveBeenCalled();
    }
    expect(routes(packed)).toEqual(routes(scalar));
  });

  for (const runtime of ["wasm", "node"]) {
    describe(runtime, () => {
      let registry, grammars, rootGrammar, childGrammar;

      function grammar(scopeName, injectionNames) {
        const file = require.resolve("language-python/grammars/python.json");
        const config = CSON.readFileSync(file);
        const result = new TreeSitterGrammar(registry, file, {
          ...config,
          scopeName,
          injectionNames,
          treeSitter:
            runtime === "wasm"
              ? { grammar: config.treeSitter.grammar }
              : { runtime: "node", languageModule: require.resolve("tree-sitter-python") },
        });
        grammars.push(result);
        registry.addGrammar(result);
        return result;
      }

      async function start(text, packed = true) {
        const buffer = new TextBuffer({ text });
        buffers.push(buffer);
        const mode = new TreeSitterLanguageMode({
          buffer,
          grammar: rootGrammar,
          config: lumine.config,
          grammars: registry,
        });
        buffer.setLanguageMode(mode);
        await mode.ready;
        await mode.atGrammarSettlement();
        configureRanges(mode.injectionsMarkerLayer.index, packed);
        return { buffer, mode };
      }

      function syntax(mode) {
        return [mode.rootLanguageLayer, ...mode.getAllInjectionLayers()].map((layer) => ({
          ranges: layer.getCurrentRanges()?.map((range) => range.serialize()),
          syntax: layer.tree.rootNode.toString(),
          text: layer.tree.rootNode.text,
        }));
      }

      beforeEach(async () => {
        jasmine.useRealClock();
        registry = new GrammarRegistry({ config: lumine.config });
        grammars = [];
        rootGrammar = grammar("source.packed-root", []);
        childGrammar = grammar("source.packed-child", ["packed-child"]);
        rootGrammar.addInjectionPoint({
          type: "integer",
          language: (node) => (Number(node.text) >= 3 ? "packed-child" : null),
          content: (node) => node,
        });
      });

      afterEach(() => {
        for (const buffer of buffers) buffer.destroy();
        for (const entry of grammars) entry.deactivate();
        registry.clear();
      });

      it("produces scalar and fresh parse results after rapid Unicode and CRLF edits", async () => {
        const packed = await start(source(64, "\r\n"));
        const scalar = await start(source(64, "\r\n"), false);
        expect(packed.mode.getAllInjectionLayers().length).toBe(64);
        for (const { buffer, mode } of [packed, scalar]) {
          buffer.transact(() => {
            buffer.setTextInRange(
              [
                [0, 0],
                [0, 6],
              ],
              "rename",
            );
            buffer.insert([0, 0], "# 😀\r\n", { normalizeLineEndings: false });
            buffer.setTextInRange(
              [
                [33, 8],
                [33, 9],
              ],
              "4",
            );
            buffer.setTextInRange(
              [
                [33, 7],
                [33, 8],
              ],
              "\t",
            );
            buffer.setTextInRange(
              [
                [0, 0],
                [1, 0],
              ],
              "# éé\n",
              {
                normalizeLineEndings: false,
              },
            );
          });
          await mode.atTransactionEnd();
        }
        const fresh = await start(packed.buffer.getText());
        expect(syntax(packed.mode)).toEqual(syntax(scalar.mode));
        expect(syntax(packed.mode)).toEqual(syntax(fresh.mode));
      });

      it("retains a later child edit while its earlier parse is suspended", async () => {
        const { buffer, mode } = await start(source(64));
        const layer = mode
          .getAllInjectionLayers()
          .find((entry) => entry.getExtent().start.row === 32);
        const parseAsync = mode.parseAsync.bind(mode);
        let entered, resume;
        const enteredPromise = new Promise((resolve) => (entered = resolve));
        const resumePromise = new Promise((resolve) => (resume = resolve));
        let suspended = false;
        spyOn(mode, "parseAsync").and.callFake((language, oldTree, ranges, params) => {
          const result = parseAsync(language, oldTree, ranges, params);
          if (params.scopeName !== childGrammar.scopeName || suspended) return result;
          suspended = true;
          entered();
          return Promise.resolve(result).then((tree) => resumePromise.then(() => tree));
        });
        spyOn(layer, "handleTextChange").and.callThrough();
        buffer.setTextInRange(
          [
            [32, 8],
            [32, 9],
          ],
          "4",
        );
        try {
          await enteredPromise;
          buffer.setTextInRange(
            [
              [0, 0],
              [0, 6],
            ],
            "rename",
          );
          buffer.setTextInRange(
            [
              [32, 8],
              [32, 9],
            ],
            "5",
          );
          expect(layer.handleTextChange).toHaveBeenCalledTimes(2);
          expect(
            layer.patchSinceCurrentParseStarted.getChanges().map((change) => change.newText),
          ).toEqual(["5"]);
        } finally {
          resume();
        }
        await mode.atTransactionEnd();
        const fresh = await start(buffer.getText());
        expect(layer.tree.rootNode.text).toBe("5");
        expect(layer.patchSinceCurrentParseStarted).toBeNull();
        expect(syntax(mode)).toEqual(syntax(fresh.mode));
      });
    });
  }
});
