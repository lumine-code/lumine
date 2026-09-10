const fs = require("fs");

const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");
const ScrollAnimator = require("../src/scroll-animator");
const { UPDATE_MODE_SCROLL_TILES } = require("../src/text-editor-component-helpers");

const FRAME_DURATION = 1000 / 120;
const LINE_COUNT = 12462;
const COMMENTED_LINE_COUNT = 9163;
const INPUT_COUNT = 30;
const EDITOR_WIDTH = 1000;
const EDITOR_HEIGHT = 1200;

function syntheticSource() {
  const lines = [];
  for (let row = 0; row < LINE_COUNT; row++) {
    const previousCommentCount = Math.floor((row * COMMENTED_LINE_COUNT) / LINE_COUNT);
    const commentCount = Math.floor(((row + 1) * COMMENTED_LINE_COUNT) / LINE_COUNT);
    const comment = commentCount > previousCommentCount ? ` # generated field ${row}` : "";
    lines.push(`field_${row} = ("m_${row}", c_int * ${1 + (row % 32)})${comment}`);
  }
  return lines.join("\n");
}

function normalizedSource() {
  const filePath = process.env.LUMINE_SCROLL_BENCHMARK_FILE;
  const source = filePath ? fs.readFileSync(filePath, "utf8") : syntheticSource();
  return source.replace(/\r\n|\r/g, "\n");
}

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
    over16_7Ms: samples.filter((sample) => sample > 16.7).length,
    over50Ms: samples.filter((sample) => sample > 50).length,
  };
}

function buildEditor(text) {
  const buffer = new TextBuffer({ text });
  const editor = new TextEditor({
    buffer,
    autoHeight: false,
    autoWidth: false,
    lineNumberGutterVisible: true,
    showLineNumbers: true,
    softWrapped: false,
    scrollSensitivity: 40,
    smoothScrolling: true,
    wheelSmoothness: 8,
    altWheelMultiplier: 7.5,
  });
  const component = new TextEditorComponent({ model: editor, updatedSynchronously: true });
  component.element.style.width = `${EDITOR_WIDTH}px`;
  component.element.style.height = `${EDITOR_HEIGHT}px`;
  jasmine.attachToDOM(component.element);
  return { buffer, component, editor };
}

async function selectGrammar(buffer, editor, languageId) {
  const assigned = lumine.grammars.assignLanguageMode(buffer, languageId);
  expect(assigned).toBe(true);
  expect(await editor.whenGrammarSettled()).toBe(true);
}

function sampleStartRows(lineCount) {
  const lastStart = Math.max(0, lineCount - 700);
  return [0, Math.floor(lastStart / 2), lastStart];
}

function queryRowCount(options) {
  const start = options?.startPosition;
  const end = options?.endPosition;
  if (!start || !end) return 0;
  return Math.max(0, end.row - start.row + (end.column > 0 ? 1 : 0));
}

function installDeterministicAnimator(component) {
  component.scrollAnimator.cancel();
  let nextHandle = 1;
  const animator = new ScrollAnimator(component, {
    requestAnimationFrame() {
      return nextHandle++;
    },
    cancelAnimationFrame() {},
  });
  const originalAnimator = component.scrollAnimator;
  component.scrollAnimator = animator;
  return {
    animator,
    restore() {
      animator.cancel();
      component.scrollAnimator = originalAnimator;
      originalAnimator.syncToComponent();
    },
  };
}

function runAltWheelBurst(component) {
  const frameDurations = [];
  const { animator, restore } = installDeterministicAnimator(component);
  try {
    for (let index = 0; index < INPUT_COUNT; index++) {
      component.element.dispatchEvent(
        new WheelEvent("wheel", {
          altKey: true,
          bubbles: true,
          cancelable: true,
          deltaY: 100,
        }),
      );
      const startedAt = performance.now();
      animator.advance(FRAME_DURATION);
      frameDurations.push(performance.now() - startedAt);
    }

    let drainFrames = 0;
    while (animator.isAnimating() && drainFrames++ < 1000) {
      const startedAt = performance.now();
      animator.advance(FRAME_DURATION);
      frameDurations.push(performance.now() - startedAt);
    }
    expect(animator.isAnimating()).toBe(false);
    return frameDurations;
  } finally {
    restore();
  }
}

async function measureCase({ name, languageId, text }) {
  const { buffer, component, editor } = buildEditor(text);
  try {
    await selectGrammar(buffer, editor, languageId);
    component.updateSync();

    const mode = buffer.getLanguageMode();
    const query = mode.rootLanguageLayer?.queries?.highlightsQuery ?? null;
    const queryHadOwnCaptures = query ? Object.hasOwn(query, "captures") : false;
    const originalCaptures = query?.captures;
    let measuring = false;
    let queryCount = 0;
    let queriedRows = 0;
    let capturedNodes = 0;
    const queryDurations = [];
    if (query) {
      query.captures = function (...args) {
        const startedAt = measuring ? performance.now() : 0;
        const captures = originalCaptures.apply(this, args);
        if (measuring) {
          queryCount++;
          queriedRows += queryRowCount(args[1]);
          capturedNodes += captures.length;
          queryDurations.push(performance.now() - startedAt);
        }
        return captures;
      };
    }

    const originalUpdateSync = component.updateSync;
    const componentHadOwnScrollFrame = Object.hasOwn(component, "updateScrollAnimationFrame");
    const originalScrollFrame = component.updateScrollAnimationFrame;
    let tileUpdates = 0;
    let normalUpdates = 0;
    let scrollOnlyFrames = 0;
    component.updateSync = function (options = {}) {
      if (measuring) {
        if (options.updateMode === UPDATE_MODE_SCROLL_TILES) tileUpdates++;
        else normalUpdates++;
      }
      return originalUpdateSync.call(this, options);
    };
    component.updateScrollAnimationFrame = function (...args) {
      const scrollOnly = originalScrollFrame.apply(this, args);
      if (measuring && scrollOnly) scrollOnlyFrames++;
      return scrollOnly;
    };

    const frameDurations = [];
    const distances = [];
    try {
      for (const startRow of sampleStartRows(editor.getLineCount())) {
        component.scrollAnimator.cancel();
        editor.displayLayer.clearSpatialIndex();
        component.derivedDimensionsCache = {};
        component.setScrollTop(startRow * component.getLineHeight());
        component.updateSync();
        const initialScrollTop = component.getScrollTop();
        measuring = true;
        try {
          frameDurations.push(...runAltWheelBurst(component));
        } finally {
          measuring = false;
        }
        distances.push(component.getScrollTop() - initialScrollTop);
      }
    } finally {
      if (query) {
        if (queryHadOwnCaptures) query.captures = originalCaptures;
        else delete query.captures;
      }
      component.updateSync = originalUpdateSync;
      if (componentHadOwnScrollFrame) component.updateScrollAnimationFrame = originalScrollFrame;
      else delete component.updateScrollAnimationFrame;
    }

    expect(distances.every((distance) => distance > 0)).toBe(true);
    return {
      name,
      frames: summarize(frameDurations),
      queryCount,
      queriedRows,
      capturedNodes,
      queryDurations: summarize(queryDurations),
      tileUpdates,
      normalUpdates,
      scrollOnlyFrames,
      distances,
    };
  } finally {
    component.element.remove();
    editor.destroy();
  }
}

describe("Text editor Alt+wheel benchmark", () => {
  it("reports cold-tile work for plain text, Python, and IPython", async () => {
    jasmine.useRealClock();
    await Promise.all([
      lumine.packages.activatePackage("language-python"),
      lumine.packages.activatePackage("language-ipython"),
    ]);

    const lf = normalizedSource();
    const crlf = lf.replace(/\n/g, "\r\n");
    const cases = [
      { name: "Plain Text CRLF", languageId: null, text: crlf },
      { name: "Python LF", languageId: "source.python", text: lf },
      { name: "Python CRLF", languageId: "source.python", text: crlf },
      { name: "IPython CRLF", languageId: "source.python.ipy", text: crlf },
    ];

    const results = [];
    for (const benchmarkCase of cases) results.push(await measureCase(benchmarkCase));

    console.log(
      `TEXT_EDITOR_SCROLL_BENCHMARK=${JSON.stringify({
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
        },
        input: {
          source: process.env.LUMINE_SCROLL_BENCHMARK_FILE ?? "synthetic ctypes-like source",
          lineCount: lf.split("\n").length,
          inputCount: INPUT_COUNT,
          frameDuration: FRAME_DURATION,
          editorWidth: EDITOR_WIDTH,
          editorHeight: EDITOR_HEIGHT,
        },
        results,
      })}`,
    );
  }, 120000);
});
