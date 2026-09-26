const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");

const LINE_LENGTHS = (process.env.LUMINE_LONG_LINE_BENCHMARK_LENGTHS || "10000,250000")
  .split(",")
  .map(Number)
  .filter((length) => Number.isFinite(length) && length > 0);
const DISPLAY_LAYER_COUNTS = (process.env.LUMINE_LONG_LINE_BENCHMARK_LAYERS || "1,2")
  .split(",")
  .map(Number)
  .filter((count) => Number.isInteger(count) && count > 0);
const SAMPLE_COUNT = Number(process.env.LUMINE_LONG_LINE_BENCHMARK_SAMPLES || 5);
const LAYER_MODE = process.env.LUMINE_LONG_LINE_BENCHMARK_LAYER_MODE || "copies";
const EDITOR_WIDTH = 1000;
const EDITOR_HEIGHT = 800;

function percentile(samples, fraction) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(samples) {
  return {
    count: samples.length,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: samples.length > 0 ? Math.min(...samples) : 0,
    maxMs: samples.length > 0 ? Math.max(...samples) : 0,
  };
}

function buildEditor(buffer) {
  return new TextEditor({
    buffer,
    autoHeight: false,
    autoWidth: false,
    lineNumberGutterVisible: true,
    showLineNumbers: true,
    softWrapped: false,
    maxScreenLineLength: 500,
  });
}

function instrumentMethod(target, methodName, samples) {
  const original = target[methodName];
  target[methodName] = function (...args) {
    const startedAt = performance.now();
    try {
      return original.apply(this, args);
    } finally {
      samples.push(performance.now() - startedAt);
    }
  };
  return () => {
    target[methodName] = original;
  };
}

function targetColumnFor(location, lineLength) {
  switch (location) {
    case "start":
      return Math.min(100, lineLength - 1);
    case "middle":
      return Math.floor(lineLength / 2);
    default:
      return Math.max(0, lineLength - 100);
  }
}

function measureCase({ lineLength, displayLayerCount, location }) {
  const buffer = new TextBuffer({ text: "x".repeat(lineLength) });
  const additionalDisplayLayers = [];
  const restores = [];
  let editor;
  let component;

  try {
    editor = buildEditor(buffer);
    for (let i = 1; i < displayLayerCount; i++) {
      additionalDisplayLayers.push(
        LAYER_MODE === "independent"
          ? buffer.addDisplayLayer({ softWrapColumn: 500, tabLength: editor.getTabLength() })
          : editor.displayLayer.copy(),
      );
    }
    component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
    component.element.style.width = `${EDITOR_WIDTH}px`;
    component.element.style.height = `${EDITOR_HEIGHT}px`;
    jasmine.attachToDOM(component.element);
    component.updateSync();

    const column = targetColumnFor(location, lineLength);
    const targetScreenRow = editor.screenPositionForBufferPosition([0, column]).row;
    component.setScrollTop(targetScreenRow * component.getLineHeight());
    component.updateSync();
    for (const displayLayer of additionalDisplayLayers) {
      displayLayer.populateSpatialIndexIfNeeded(Infinity, Infinity);
    }

    const indexDurations = [];
    const screenLineDurations = [];
    const renderDurations = [];
    for (const displayLayer of [editor.displayLayer, ...additionalDisplayLayers]) {
      restores.push(instrumentMethod(displayLayer, "updateSpatialIndex", indexDurations));
    }
    restores.push(
      instrumentMethod(
        editor.displayLayer.screenLineBuilder,
        "buildScreenLines",
        screenLineDurations,
      ),
      instrumentMethod(component, "renderSync", renderDurations),
    );

    const totalDurations = [];
    let inserted = false;
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const startedAt = performance.now();
      if (inserted) {
        buffer.delete([
          [0, column],
          [0, column + 1],
        ]);
      } else {
        buffer.insert([0, column], "y");
      }
      inserted = !inserted;
      if (component.updateScheduled) component.updateSync();
      totalDurations.push(performance.now() - startedAt);
    }

    return {
      lineLength,
      displayLayerCount,
      location,
      targetScreenRow,
      total: summarize(totalDurations),
      updateSpatialIndex: summarize(indexDurations),
      buildScreenLines: summarize(screenLineDurations),
      renderSync: summarize(renderDurations),
    };
  } finally {
    for (const restore of restores.reverse()) restore();
    if (component) component.element.remove();
    for (const displayLayer of additionalDisplayLayers) displayLayer.destroy();
    if (editor) editor.destroy();
    if (!buffer.isDestroyed()) buffer.destroy();
  }
}

describe("Text editor long-line input benchmark", () => {
  it("reports model and DOM update costs across line positions and display layers", () => {
    jasmine.useRealClock();
    const results = [];
    for (const lineLength of LINE_LENGTHS) {
      for (const displayLayerCount of DISPLAY_LAYER_COUNTS) {
        for (const location of ["start", "middle", "end"]) {
          results.push(measureCase({ lineLength, displayLayerCount, location }));
        }
      }
    }

    console.log(
      `TEXT_EDITOR_LONG_LINE_BENCHMARK=${JSON.stringify({
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
        },
        input: {
          lineLengths: LINE_LENGTHS,
          displayLayerCounts: DISPLAY_LAYER_COUNTS,
          sampleCount: SAMPLE_COUNT,
          editorWidth: EDITOR_WIDTH,
          editorHeight: EDITOR_HEIGHT,
          maxScreenLineLength: 500,
          layerMode: LAYER_MODE,
          operation: "alternating one-character insert/delete",
        },
        results,
      })}`,
    );
  }, 120000);
});
