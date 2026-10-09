const fs = require("fs");
const { createHash } = require("crypto");

const TextBuffer = require("../src/text-buffer");
const TextEditor = require("../src/text-editor");
const TextEditorComponent = require("../src/text-editor-component");
const ScrollAnimator = require("../src/scroll-animator");
const { UPDATE_MODE_SCROLL_TILES } = require("../src/text-editor-component-helpers");

const animatorSourceSha256 = createHash("sha256")
  .update(fs.readFileSync(require.resolve("../src/scroll-animator")))
  .digest("hex");

const FRAME_DURATION = 1000 / 120;
const LINE_COUNT = 12462;
const COMMENTED_LINE_COUNT = 9163;
const INPUT_COUNT = 30;
const EDITOR_WIDTH = 1000;
const EDITOR_HEIGHT = 1200;
const SCROLL_SETTINGS = {
  smoothScrolling: true,
  wheelScrollMultiplier: 0.48,
  wheelScrollDuration: 120,
  altWheelScrollMultiplier: 8,
};

function wheelScenarios() {
  const altBurst = [];
  const altSparse = [];
  const increasingGaps = [];
  const decreasingDeltas = [];
  let spacedTime = 0;
  for (let index = 0; index < INPUT_COUNT; index++) {
    altBurst.push({ at: index * FRAME_DURATION, deltaY: 100, altKey: true });
    altSparse.push({ at: index * 100, deltaY: 100, altKey: true });
    increasingGaps.push({ at: spacedTime, deltaY: 100 });
    decreasingDeltas.push({ at: index * (1000 / 60), deltaY: 100 * Math.pow(0.88, index) });
    spacedTime += FRAME_DURATION + ((100 - FRAME_DURATION) * index) / (INPUT_COUNT - 1);
  }
  return [
    { name: "alt-wheel-burst", events: altBurst },
    { name: "alt-wheel-sparse", events: altSparse },
    { name: "free-wheel-spacing", events: increasingGaps },
    {
      name: "alt-wheel-spacing",
      events: increasingGaps.map((event) => ({ ...event, altKey: true })),
    },
    { name: "free-wheel-deltas", events: decreasingDeltas },
  ];
}

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
    totalMs: samples.reduce((sum, sample) => sum + sample, 0),
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
    ...SCROLL_SETTINGS,
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
  let timestamp = 1000;
  const callbacks = new Map();
  const animator = new ScrollAnimator(component, {
    now: () => timestamp,
    requestAnimationFrame(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      callbacks.delete(handle);
    },
  });
  const originalAnimator = component.scrollAnimator;
  component.scrollAnimator = animator;
  return {
    animator,
    setTime(elapsed) {
      timestamp = 1000 + elapsed;
      return timestamp;
    },
    runFrame() {
      // Call only the callbacks already queued at the start of this frame.
      // New callbacks belong to the next frame, just as they do in Chromium.
      const pending = [...callbacks.entries()];
      let count = 0;
      for (const [handle, callback] of pending) {
        if (!callbacks.delete(handle)) continue;
        callback(timestamp);
        count++;
      }
      return count;
    },
    pendingFrameCount() {
      return callbacks.size;
    },
    restore() {
      animator.cancel();
      component.scrollAnimator = originalAnimator;
      originalAnimator.syncToComponent();
    },
  };
}

function runWheelScenario(component, scenario) {
  const frameDurations = [];
  const wheelDurations = [];
  const intervalWorkDurations = [];
  const frameSteps = [];
  const { animator, restore, setTime, runFrame, pendingFrameCount } =
    installDeterministicAnimator(component);
  const initialScrollTop = component.getScrollTop();
  let expectedScrollTop = initialScrollTop;
  let inputIndex = 0;
  let frameCount = 0;
  let callbackCount = 0;
  let maxCallbacksPerFrame = 0;
  let previousPosition = initialScrollTop;
  let activeInputFrames = 0;
  let animationStarts = 0;
  let animationEnds = 0;
  const startSubscription = component.element.emitter.on("did-start-scroll-animation", () => {
    animationStarts++;
  });
  const endSubscription = component.element.emitter.on("did-end-scroll-animation", () => {
    animationEnds++;
  });
  try {
    while (
      (inputIndex < scenario.events.length || animator.isAnimating() || pendingFrameCount() > 0) &&
      frameCount < 2000
    ) {
      const nextFrameTime = ++frameCount * FRAME_DURATION;
      let intervalWork = 0;
      // An input exactly on a frame boundary is processed after that frame.
      // This preserves the original one-input-then-one-frame Alt burst.
      while (
        inputIndex < scenario.events.length &&
        scenario.events[inputIndex].at < nextFrameTime - 1e-7
      ) {
        const input = scenario.events[inputIndex++];
        const event = new WheelEvent("wheel", {
          altKey: input.altKey ?? false,
          bubbles: true,
          cancelable: true,
          deltaY: input.deltaY,
        });
        Object.defineProperty(event, "timeStamp", { value: setTime(input.at) });
        const requestedY =
          component.normalizedWheelDeltas(event).y *
          component.props.model.getWheelScrollMultiplier();
        expectedScrollTop = Math.max(
          0,
          Math.min(component.getMaxScrollTop(), expectedScrollTop + requestedY),
        );
        const startedAt = performance.now();
        component.element.dispatchEvent(event);
        const duration = performance.now() - startedAt;
        wheelDurations.push(duration);
        intervalWork += duration;
      }

      setTime(nextFrameTime);
      const startedAt = performance.now();
      const callbacks = runFrame();
      const duration = performance.now() - startedAt;
      if (callbacks > 0) frameDurations.push(duration);
      callbackCount += callbacks;
      maxCallbacksPerFrame = Math.max(maxCallbacksPerFrame, callbacks);
      intervalWorkDurations.push(intervalWork + duration);
      const position = animator.virtualScrollTop;
      frameSteps.push(position - previousPosition);
      previousPosition = position;
      if (nextFrameTime <= scenario.events.at(-1).at + FRAME_DURATION) activeInputFrames++;
    }
    expect(animator.isAnimating()).toBe(false);
    expect(pendingFrameCount()).toBe(0);
    const distance = component.getScrollTop() - initialScrollTop;
    const targetError = component.getScrollTop() - expectedScrollTop;
    expect(Math.abs(targetError)).toBeLessThanOrEqual(1 / window.devicePixelRatio);
    expect(frameSteps.every((step) => step >= -1e-7)).toBe(true);
    const activeSteps = frameSteps.slice(0, activeInputFrames);
    const stepChanges = activeSteps.slice(1).map((step, index) => step - activeSteps[index]);
    return {
      frameDurations,
      wheelDurations,
      intervalWorkDurations,
      callbackCount,
      maxCallbacksPerFrame,
      animationStarts,
      animationEnds,
      distance,
      targetError,
      motion: {
        sampledFrames: frameCount,
        activeInputFrames,
        inputDurationMs: scenario.events.at(-1).at,
        drainDurationMs: frameCount * FRAME_DURATION - scenario.events.at(-1).at,
        maxFrameStepPx: Math.max(...activeSteps),
        maxFrameStepChangePx: Math.max(...stepChanges.map(Math.abs)),
        rmsFrameStepChangePx: Math.sqrt(
          stepChanges.reduce((sum, change) => sum + change * change, 0) / stepChanges.length,
        ),
      },
    };
  } finally {
    startSubscription.dispose();
    endSubscription.dispose();
    restore();
  }
}

async function measureCase({ name, languageId, text }, scenario) {
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
    let scrollFrameUpdates = 0;
    component.updateSync = function (options = {}) {
      if (measuring) {
        if (options.updateMode === UPDATE_MODE_SCROLL_TILES) tileUpdates++;
        else normalUpdates++;
      }
      return originalUpdateSync.call(this, options);
    };
    component.updateScrollAnimationFrame = function (...args) {
      if (measuring) scrollFrameUpdates++;
      const scrollOnly = originalScrollFrame.apply(this, args);
      if (measuring && scrollOnly) scrollOnlyFrames++;
      return scrollOnly;
    };

    const frameDurations = [];
    const wheelDurations = [];
    const intervalWorkDurations = [];
    const distances = [];
    const targetErrors = [];
    const motion = [];
    let callbackCount = 0;
    let maxCallbacksPerFrame = 0;
    let animationStarts = 0;
    let animationEnds = 0;
    try {
      for (const startRow of sampleStartRows(editor.getLineCount())) {
        component.scrollAnimator.cancel();
        editor.displayLayer.clearSpatialIndex();
        component.derivedDimensionsCache = {};
        component.setScrollTop(startRow * component.getLineHeight());
        component.updateSync();
        measuring = true;
        try {
          const result = runWheelScenario(component, scenario);
          frameDurations.push(...result.frameDurations);
          wheelDurations.push(...result.wheelDurations);
          intervalWorkDurations.push(...result.intervalWorkDurations);
          distances.push(result.distance);
          targetErrors.push(result.targetError);
          motion.push(result.motion);
          callbackCount += result.callbackCount;
          maxCallbacksPerFrame = Math.max(maxCallbacksPerFrame, result.maxCallbacksPerFrame);
          animationStarts += result.animationStarts;
          animationEnds += result.animationEnds;
        } finally {
          measuring = false;
        }
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
      scenario: scenario.name,
      frames: summarize(frameDurations),
      wheelHandling: summarize(wheelDurations),
      workPerFrameInterval: summarize(intervalWorkDurations),
      callbackCount,
      maxCallbacksPerFrame,
      animationStarts,
      animationEnds,
      queryCount,
      queriedRows,
      capturedNodes,
      queryDurations: summarize(queryDurations),
      tileUpdates,
      normalUpdates,
      scrollOnlyFrames,
      scrollFrameUpdates,
      distances,
      targetErrors,
      motion,
    };
  } finally {
    component.element.remove();
    editor.destroy();
  }
}

describe("Text editor wheel benchmark", () => {
  it("reports renderer work and motion for bursts and slowing wheel input", async () => {
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
    const scenarios = wheelScenarios();
    for (const scenario of scenarios) {
      for (const benchmarkCase of cases) {
        results.push(await measureCase(benchmarkCase, scenario));
      }
    }

    console.log(
      `TEXT_EDITOR_SCROLL_BENCHMARK=${JSON.stringify({
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          animatorSourceSha256,
        },
        input: {
          source: process.env.LUMINE_SCROLL_BENCHMARK_FILE ?? "synthetic ctypes-like source",
          lineCount: lf.split("\n").length,
          inputCount: INPUT_COUNT,
          frameDuration: FRAME_DURATION,
          editorWidth: EDITOR_WIDTH,
          editorHeight: EDITOR_HEIGHT,
          scrollSettings: SCROLL_SETTINGS,
          scenarios,
        },
        measurement:
          "Deterministic 120 Hz input/frame timeline; synchronous wheel and renderer work only, without compositor or presentation timing. Frame-interval work includes every wheel dispatch and every queued animation callback in that interval.",
        results,
      })}`,
    );
  }, 120000);
});
