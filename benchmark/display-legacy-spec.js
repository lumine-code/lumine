const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");
const { isWrapBoundary } = require("../src/text-utils");

const CONFIG = JSON.parse(process.env.LUMINE_DISPLAY_BENCHMARK_CONFIG || "{}");
const SAMPLES = CONFIG.samples || 3;
const WARMUPS = CONFIG.warmups ?? 1;
const QUICK = CONFIG.mode !== "release";
const checksum = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function build(buffer, maxScreenLineLength = 500) {
  const editor = new TextEditor({
    buffer,
    autoHeight: false,
    autoWidth: false,
    softWrapped: false,
    maxScreenLineLength,
  });
  const component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
  component.element.style.width = "1000px";
  component.element.style.height = "800px";
  jasmine.attachToDOM(component.element);
  component.updateSync();
  return { editor, component };
}

function destroy({ editor, component }, layers = []) {
  component.element.remove();
  for (const layer of layers) layer.destroy();
  editor.destroy();
}

function time(run) {
  const start = performance.now();
  const value = run();
  return { duration: performance.now() - start, value };
}

function shuffled(values) {
  let seed = 0x51a79;
  const result = values.slice();
  for (let index = result.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function mappingResult(points) {
  return points.map(({ row, column }) => [row, column]);
}

function packedChanges(index, points) {
  const packedPoints = new Uint32Array(points.flat());
  if (index.changesForOldPositions) return index.changesForOldPositions(packedPoints);
  const result = new Uint32Array(points.length * 9);
  points.forEach(([row, column], positionIndex) => {
    const change = index.changeForOldPosition({ row, column });
    if (!change) return;
    result.set(
      [
        1,
        change.oldStart.row,
        change.oldStart.column,
        change.oldEnd.row,
        change.oldEnd.column,
        change.newStart.row,
        change.newStart.column,
        change.newEnd.row,
        change.newEnd.column,
      ],
      positionIndex * 9,
    );
  });
  return result;
}

async function decorationCase({ layout, endpoints, order, cache }) {
  const fragment = layout === "tabs" ? "alpha\tbeta_gamma delta " : "alpha_beta gamma delta ";
  const buffer = new TextBuffer({ text: fragment.repeat(60) });
  const context = build(buffer, layout === "identity" ? Infinity : 500);
  const { editor, component } = context;
  const disposables = [];
  try {
    editor.displayLayer.reset({ softWrapColumn: layout === "identity" ? Infinity : 500 });
    if (layout === "folds")
      editor.displayLayer.foldBufferRange([
        [0, 100],
        [0, 220],
      ]);
    component.updateSync();
    expect(editor.displayLayer.spatialIndex.getChangeCount() === 0).toBe(layout === "identity");
    const ranges = Array.from({ length: Math.ceil(endpoints / 2) }, (_, index) => {
      const column = 10 + ((index * 17) % (buffer.lineLengthForRow(0) - 20));
      return [
        [0, column],
        [0, column + 3],
      ];
    });
    ranges.sort((a, b) => a[0][1] - b[0][1]);
    const orderedRanges = order === "shuffled" ? shuffled(ranges) : ranges;
    const points = orderedRanges.flat().slice(0, endpoints);
    const markers = [];
    for (let index = 0; index < Math.ceil(endpoints / 2); index++) {
      const [start, end] = orderedRanges[index];
      const marker = editor.markBufferRange([start, end], { reversed: index % 2 === 1 });
      if (cache === "cached" || (cache === "mixed" && index % 2 === 0)) {
        disposables.push(marker.onDidChange(() => {}));
        marker.getScreenRange();
      }
      editor.decorateMarker(marker, { type: "highlight", class: "display-benchmark" });
      markers.push(marker);
    }
    component.updateSync();
    const expected = mappingResult(
      points.map((point) => editor.displayLayer.translateBufferPosition(point)),
    );
    const expectedLookup = packedChanges(editor.displayLayer.spatialIndex, points);
    expect(packedChanges(editor.displayLayer.spatialIndex, []).length).toBe(0);
    const samples = { lookup: [], scalar: [], batch: [], query: [], component: [] };
    let queryChecksum;
    for (let index = -WARMUPS; index < SAMPLES; index++) {
      const scalar = time(() =>
        points.map((point) => editor.displayLayer.translateBufferPosition(point)),
      );
      const batch = time(() =>
        editor.displayLayer.translateBufferPositions
          ? editor.displayLayer.translateBufferPositions(points)
          : points.map((point) => editor.displayLayer.translateBufferPosition(point)),
      );
      expect(mappingResult(batch.value)).toEqual(expected);
      const lookup = time(() => packedChanges(editor.displayLayer.spatialIndex, points));
      expect(Array.from(lookup.value)).toEqual(Array.from(expectedLookup));
      const query = time(() => component.queryDecorationsToRender());
      const highlightRanges = component.decorationsToMeasure.highlights.map((item) => ({
        start: item.screenRange?.start,
        end: item.screenRange?.end,
        key: item.key,
      }));
      const currentChecksum = checksum(highlightRanges);
      if (queryChecksum) expect(currentChecksum).toBe(queryChecksum);
      queryChecksum = currentChecksum;
      const update = time(() => component.updateSync());
      if (index >= 0) {
        samples.scalar.push(scalar.duration);
        samples.batch.push(batch.duration);
        samples.lookup.push(lookup.duration);
        samples.query.push(query.duration);
        samples.component.push(update.duration);
      }
    }
    return {
      id: `decorations/${layout}/${endpoints}/${order}/${cache}`,
      kind: "decorations",
      layout,
      endpoints,
      order,
      cache,
      nativeBatch: Boolean(editor.displayLayer.translateBufferPositions),
      spatialChanges: editor.displayLayer.spatialIndex.getChangeCount(),
      samplesMs: samples,
      checksum: checksum({ points: expected, query: queryChecksum, markers: markers.length }),
    };
  } finally {
    disposables.forEach((disposable) => disposable.dispose());
    destroy(context);
  }
}

async function longLineCase({
  length,
  location,
  operation,
  views,
  layerMode,
  grammar,
  pattern = "token",
}) {
  const fragment =
    pattern === "tabs"
      ? "alpha\tbeta gamma/delta "
      : pattern === "token"
        ? "x"
        : "alpha beta-gamma/delta ";
  const text = grammar
    ? `value = ${"x".repeat(length - 8)}`
    : fragment.repeat(Math.ceil(length / fragment.length)).slice(0, length);
  const buffer = new TextBuffer({ text });
  const context = build(buffer);
  const { editor, component } = context;
  const layers = [];
  try {
    if (pattern === "fold") {
      const foldColumn = Math.floor(length / 3);
      editor.displayLayer.foldBufferRange([
        [0, foldColumn],
        [0, foldColumn + 1000],
      ]);
    }
    if (grammar) {
      expect(lumine.grammars.assignLanguageMode(buffer, "source.python")).toBe(true);
      expect(await editor.whenGrammarSettled()).toBe(true);
      expect(buffer.getLanguageMode().rootLanguageLayer?.tree).toBeTruthy();
    }
    for (let index = 1; index < views; index++) {
      layers.push(
        layerMode === "copies"
          ? editor.displayLayer.copy()
          : buffer.addDisplayLayer({
              softWrapColumn: 500,
              tabLength: editor.getTabLength(),
              isWrapBoundary,
            }),
      );
    }
    const column =
      location === "start" ? 100 : location === "middle" ? Math.floor(length / 2) : length - 100;
    const screenRow = editor.screenPositionForBufferPosition([0, column]).row;
    component.setScrollTop(screenRow * component.getLineHeight());
    component.updateSync();
    const allLayers = [editor.displayLayer, ...layers];
    allLayers.forEach((layer) => layer.populateSpatialIndexIfNeeded(Infinity, Infinity));
    const samples = { total: [], spatialUpdates: [], parseAndComponent: [] };
    let finalChecksum;
    for (let index = -WARMUPS; index < SAMPLES; index++) {
      if (operation === "delete") buffer.insert([0, column], "y");
      component.updateSync();
      let spatialUpdates = 0;
      const originals = allLayers.map((layer) => layer.updateSpatialIndex);
      allLayers.forEach((layer, layerIndex) => {
        layer.updateSpatialIndex = function (...args) {
          spatialUpdates++;
          return originals[layerIndex].apply(this, args);
        };
      });
      const startedAt = performance.now();
      try {
        if (operation === "replace")
          buffer.setTextInRange(
            [
              [0, column],
              [0, column + 1],
            ],
            index % 2 === 0 ? "y" : "z",
          );
        else if (operation === "insert") buffer.insert([0, column], "y");
        else
          buffer.delete([
            [0, column],
            [0, column + 1],
          ]);
        component.updateSync();
        const immediate = performance.now() - startedAt;
        if (grammar) {
          await editor.whenGrammarSettled();
          component.updateSync();
        }
        const settled = performance.now() - startedAt;
        if (index >= 0) {
          samples.total.push(immediate);
          samples.parseAndComponent.push(settled);
          samples.spatialUpdates.push(spatialUpdates);
        }
      } finally {
        allLayers.forEach((layer, layerIndex) => {
          layer.updateSpatialIndex = originals[layerIndex];
        });
      }
      const screenLines = editor.displayLayer.getScreenLines(screenRow, screenRow + 3);
      if (pattern === "fold")
        expect(editor.displayLayer.foldsMarkerLayer.findMarkers({}).length).toBe(1);
      finalChecksum = checksum(
        screenLines.map((line) => ({ text: line.lineText, tags: line.tags })),
      );
      if (operation === "insert")
        buffer.delete([
          [0, column],
          [0, column + 1],
        ]);
    }
    return {
      id: `long-line/${grammar ? "python" : "plain"}/${length}/${location}/${operation}/${views}/${layerMode}${pattern === "token" ? "" : `/${pattern}`}`,
      kind: "long-line",
      length,
      location,
      operation,
      views,
      layerMode,
      grammar,
      pattern,
      samplesMs: samples,
      checksum: finalChecksum,
    };
  } finally {
    destroy(context, layers);
  }
}

async function scrollCase(grammar) {
  const buffer = new TextBuffer({
    text: Array.from({ length: 2000 }, (_, row) => `value_${row} = "display benchmark"`).join("\n"),
  });
  const context = build(buffer);
  const { editor, component } = context;
  try {
    if (grammar) {
      expect(lumine.grammars.assignLanguageMode(buffer, "source.python")).toBe(true);
      expect(await editor.whenGrammarSettled()).toBe(true);
    }
    component.updateSync();
    const samples = [];
    for (let index = -WARMUPS; index < SAMPLES; index++) {
      component.setScrollTop(200 * component.getLineHeight());
      component.updateSync();
      const measurement = time(() => {
        component.setScrollTop(500 * component.getLineHeight());
        component.updateSync();
      });
      if (index >= 0) samples.push(measurement.duration);
    }
    return {
      id: `scroll/${grammar ? "python" : "plain"}`,
      kind: "scroll",
      samplesMs: { total: samples },
      checksum: checksum(
        editor.displayLayer
          .getScreenLines(500, 510)
          .map((line) => ({ text: line.lineText, tags: line.tags })),
      ),
    };
  } finally {
    destroy(context);
  }
}

describe("Legacy display performance benchmark", () => {
  it("records mapping, rendering and edit costs with stable outputs", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage(
      path.join(process.env.LUMINE_DISPLAY_BENCHMARK_WORKSPACE, "language-python"),
    );
    const results = [];
    for (const layout of ["identity", "wrap", "folds", "tabs"]) {
      for (const endpoints of [1, 16, 64, 256, 5000]) {
        for (const order of ["sorted", "shuffled"]) {
          for (const cache of ["uncached", "cached", "mixed"]) {
            if (
              QUICK &&
              (endpoints === 16 || endpoints === 64 || order === "shuffled" || cache === "mixed")
            )
              continue;
            results.push(await decorationCase({ layout, endpoints, order, cache }));
          }
        }
      }
    }
    for (const length of [10000, 250000, 1000000]) {
      for (const location of ["start", "middle", "end"]) {
        for (const operation of ["replace", "insert", "delete"]) {
          for (const views of [1, 2, 4]) {
            for (const layerMode of ["copies", "independent"]) {
              if (views === 1 && layerMode === "independent") continue;
              if (
                QUICK &&
                (location !== "middle" ||
                  views === 2 ||
                  layerMode === "independent" ||
                  (operation !== "replace" && length !== 10000))
              )
                continue;
              results.push(
                await longLineCase({
                  length,
                  location,
                  operation,
                  views,
                  layerMode,
                  grammar: false,
                }),
              );
            }
          }
        }
      }
    }
    for (const pattern of ["words", "tabs", "fold"]) {
      for (const location of QUICK ? ["middle"] : ["start", "middle", "end"]) {
        for (const operation of ["insert", "delete"]) {
          results.push(
            await longLineCase({
              length: 250000,
              location,
              operation,
              views: 1,
              layerMode: "copies",
              grammar: false,
              pattern,
            }),
          );
        }
      }
    }
    for (const length of QUICK ? [10000] : [10000, 250000, 1000000]) {
      results.push(
        await longLineCase({
          length,
          location: "middle",
          operation: "replace",
          views: 1,
          layerMode: "copies",
          grammar: true,
        }),
      );
    }
    results.push(await scrollCase(false), await scrollCase(true));
    const addons = Object.keys(require.cache).filter((file) => file.endsWith("superstring.node"));
    const report = {
      schemaVersion: 1,
      runtime: process.versions,
      platform: process.platform,
      arch: process.arch,
      config: CONFIG,
      memory: process.memoryUsage(),
      addons: addons.map((file) => ({
        path: file,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      })),
      corpus: {
        hash: checksum(results.map(({ id }) => id)),
        wrapColumn: 500,
        editorWidth: 1000,
        editorHeight: 800,
      },
      results,
    };
    fs.writeFileSync(process.env.LUMINE_DISPLAY_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
    console.log(
      `DISPLAY_LEGACY_BENCHMARK=${JSON.stringify({ cases: results.length, output: process.env.LUMINE_DISPLAY_BENCHMARK_OUTPUT })}`,
    );
  }, 3600000);
});
