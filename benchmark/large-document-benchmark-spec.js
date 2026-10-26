// Also loaded by the normal application launcher. Jasmine is only a smoke-test
// adapter; published timings should come from run-large-document-benchmark.js.
const { createHash } = require("node:crypto");
const TextBuffer = require("../src/text-buffer");
const { MAX_DOM_EXTENT, MAX_SCROLLBAR_EXTENT } = require("../src/scroll-coordinate-space");

const SPARSE_TOKEN = "__LUMINE_LARGE_DOCUMENT_BENCHMARK__";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function invariant(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function summarize(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (fraction) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return {
    count: values.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? null,
    above16_67Ms: values.filter((value) => value > 1000 / 60).length,
    above8_33Ms: values.filter((value) => value > 1000 / 120).length,
  };
}

function frame() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Object.assign(new Error("RAF_UNAVAILABLE"), { code: "RAF_UNAVAILABLE" })),
      5000,
    );
    requestAnimationFrame(() => {
      clearTimeout(timeout);
      // The RAF argument timestamps the frame, not callback execution. It can
      // predate input handled later in that frame and report negative latency.
      resolve(performance.now());
    });
  });
}

async function settle() {
  await frame();
  await frame();
}

function monitorFrames() {
  const startedAt = performance.now();
  const intervals = [],
    longTasks = [];
  let running = true,
    previous,
    handle;
  const tick = (at) => {
    if (!running) return;
    if (previous != null) intervals.push({ atMs: at - startedAt, durationMs: at - previous });
    previous = at;
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  let observer;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        longTasks.push({ atMs: entry.startTime - startedAt, durationMs: entry.duration });
    });
    observer.observe({ type: "longtask", buffered: false });
  } catch {
    /* Long-task entries are not supported on every Chromium build. */
  }
  return () => {
    running = false;
    cancelAnimationFrame(handle);
    observer?.disconnect();
    return {
      intervals,
      summary: summarize(intervals.map((item) => item.durationMs)),
      longTasks,
      longTaskObserverAvailable: Boolean(observer),
    };
  };
}

async function snapshotDigest(snapshot) {
  const hash = createHash("sha256");
  let deadline = performance.now() + 4;
  for (const chunk of snapshot.chunks()) {
    hash.update(Buffer.from(chunk, "utf16le"));
    if (performance.now() >= deadline) {
      await sleep(0);
      deadline = performance.now() + 4;
    }
  }
  return hash.digest("hex");
}

function visible(rect, viewport) {
  return (
    rect.height > 0 &&
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom &&
    rect.width > 0 &&
    rect.right > viewport.left &&
    rect.left < viewport.right
  );
}

function inspectViewport(editor, component) {
  const viewport = component.refs.scrollContainer.getBoundingClientRect();
  const element = editor.getElement();
  const lines = [...element.querySelectorAll(".line[data-screen-row]:not([data-off-screen])")];
  let visibleGlyphLines = 0;
  for (const line of lines) {
    if (!line.firstChild) continue;
    const range = document.createRange();
    range.selectNodeContents(line.firstChild);
    if (visible(range.getBoundingClientRect(), viewport)) visibleGlyphLines++;
  }
  const gutters = [...element.querySelectorAll(".line-number")];
  const input = component.refs.cursorsAndInput.refs.hiddenInput.getBoundingClientRect();
  const content = component.refs.content.getBoundingClientRect();
  const logical = component.pixelPositionForScreenPosition(editor.getCursorScreenPosition());
  const hit = component.screenPositionForPixelPosition(logical);
  const result = {
    renderedLines: lines.length,
    visibleGlyphLines,
    visibleGutterRows: gutters.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    }).length,
    imeAnchorVisible: visible(input, viewport),
    visibleCursorRoundTrip: hit.isEqual(editor.getCursorScreenPosition()),
    logicalHeight: component.getScrollHeight(),
    logicalWidth: component.getScrollWidth(),
    physicalHeight: content.height,
    physicalWidth: content.width,
    nativeVerticalExtent: component.refs.verticalScrollbar?.element.scrollHeight ?? 0,
    nativeHorizontalExtent: component.refs.horizontalScrollbar?.element.scrollWidth ?? 0,
    renderedWindowColumns: component.renderedScreenLines.map((line) => line.lineText.length),
  };
  invariant(result.visibleGlyphLines > 0 && result.visibleGutterRows > 0, "EMPTY_VIEWPORT");
  invariant(
    result.imeAnchorVisible && result.visibleCursorRoundTrip,
    "INVALID_VISIBLE_CURSOR_GEOMETRY",
  );
  invariant(
    content.height <= MAX_DOM_EXTENT + 1 && content.width <= MAX_DOM_EXTENT + 1,
    "UNBOUNDED_DOM_EXTENT",
  );
  invariant(
    result.nativeVerticalExtent <= MAX_SCROLLBAR_EXTENT + 1 &&
      result.nativeHorizontalExtent <= MAX_SCROLLBAR_EXTENT + 1,
    "UNBOUNDED_NATIVE_SCROLLBAR",
  );
  return result;
}

async function measureEnters(editor, component, location, config, original) {
  const buffer = editor.getBuffer();
  const row =
    location === "start"
      ? 0
      : location === "middle"
        ? Math.floor(buffer.getLastRow() / 2)
        : buffer.getLastRow();
  editor.setCursorBufferPosition([row, location === "end" ? buffer.lineLengthForRow(row) : 0]);
  editor.scrollToCursorPosition();
  await settle();
  const checkpoint = buffer.createCheckpoint();
  const finishFrames = monitorFrames();
  const samples = [],
    acknowledgements = [];
  let restored = false;
  try {
    await frame();
    const start = performance.now();
    for (let index = 0; index < config.inputCount; index++) {
      const due = start + index * config.intervalMs;
      await sleep(Math.max(0, due - performance.now()));
      const at = performance.now();
      invariant(
        lumine.commands.dispatch(editor.getElement(), "editor:newline"),
        "NEWLINE_COMMAND_NOT_DISPATCHED",
      );
      const durationMs = performance.now() - at;
      const sample = { atMs: at - start, durationMs, schedulingDelayMs: at - due };
      samples.push(sample);
      acknowledgements.push(
        frame().then((timestamp) => {
          sample.inputToNextRafMs = timestamp - at;
        }),
      );
    }
    await Promise.all(acknowledgements);
    await settle();
    const frames = finishFrames();
    invariant(
      buffer.getLineCount() === original.lineCount + config.inputCount,
      "NEWLINE_COUNT_MISMATCH",
    );
    buffer.groupChangesSinceCheckpoint(checkpoint, { deleteCheckpoint: true });
    const undoStarted = performance.now();
    invariant(
      lumine.commands.dispatch(editor.getElement(), "core:undo"),
      "UNDO_COMMAND_NOT_DISPATCHED",
    );
    const undoCommandMs = performance.now() - undoStarted;
    await settle();
    const verificationStarted = performance.now();
    restored = buffer.getTextSnapshot().equals(original);
    invariant(restored, "UNDO_SNAPSHOT_MISMATCH");
    return {
      location,
      samples,
      command: summarize(samples.map((item) => item.durationMs)),
      inputToNextRaf: summarize(samples.map((item) => item.inputToNextRafMs)),
      frames,
      undoCommandMs,
      exactSnapshotRestored: restored,
      verificationMs: performance.now() - verificationStarted,
      memory: process.memoryUsage(),
      viewport: inspectViewport(editor, component),
    };
  } finally {
    finishFrames();
    if (!restored && !buffer.isDestroyed()) buffer.revertToCheckpoint(checkpoint);
  }
}

async function measureSearch(buffer, descriptor, cancel) {
  const controller = new AbortController();
  const session = buffer.createSearch(new RegExp(descriptor.source, descriptor.flags), {
    signal: controller.signal,
  });
  const finishFrames = monitorFrames();
  const start = performance.now();
  let firstMatchMs = null,
    abortAt = null,
    status = "complete",
    errorCode = null;
  try {
    await session.collect({
      limit: 16,
      onProgress({ count, complete }) {
        if (count > 0 && firstMatchMs == null) firstMatchMs = performance.now() - start;
        if (cancel && !complete && abortAt == null) {
          abortAt = performance.now();
          controller.abort();
        }
      },
    });
  } catch (error) {
    status = error.name === "AbortError" ? "cancelled" : "failed";
    errorCode = error.code || error.name;
  } finally {
    controller.abort();
  }
  const finishedAt = performance.now();
  return {
    name: descriptor.name,
    patternSha256: createHash("sha256").update(descriptor.source).digest("hex"),
    patternUnits: descriptor.source.length,
    flags: descriptor.flags,
    status,
    errorCode,
    count: session.count,
    complete: session.complete,
    firstMatchMs,
    firstMatchMeasurement: "First collect progress event carrying a positive count",
    completeMs: finishedAt - start,
    cancellationRequested: abortAt != null,
    cancellationLatencyMs: abortAt == null ? null : finishedAt - abortAt,
    checkpointCount: session.checkpoints.length,
    presentationLimit: 16,
    frames: finishFrames(),
    memory: process.memoryUsage(),
  };
}

async function runBenchmark(options = {}) {
  const config = {
    inputCount: 30,
    intervalMs: 1000 / 30,
    generatedRows: 300100,
    sparse: { name: "sparse", source: SPARSE_TOKEN, flags: "g" },
    dense: { name: "dense", source: ".", flags: "gu" },
    packages: [],
    requireProduction: false,
    ...options,
  };
  invariant(
    Number.isInteger(config.inputCount) && config.inputCount > 0 && config.inputCount <= 1000,
    "INVALID_INPUT_COUNT",
  );
  invariant(Number.isFinite(config.intervalMs) && config.intervalMs >= 0, "INVALID_INPUT_INTERVAL");
  invariant(
    Number.isInteger(config.generatedRows) &&
      config.generatedRows > 0 &&
      config.generatedRows <= 1000000,
    "INVALID_GENERATED_ROWS",
  );
  invariant(
    !config.requireProduction || !lumine.window.isSpecMode(),
    "SPEC_RENDERER_IS_NOT_A_PRODUCTION_MEASUREMENT",
  );
  for (const name of config.packages) await lumine.packages.activatePackage(name);
  let editor, buffer, pane;
  const report = {
    version: 1,
    status: "running",
    phase: "opening",
    recordedAt: new Date().toISOString(),
    measurement:
      "Normal renderer scheduling and real requestAnimationFrame callbacks. Command dispatch, next-RAF latency, and raw frame intervals are separate; none measures physical pixel presentation. Open is cold for this editor/process, not a flushed operating-system disk cache.",
    coordinateContract:
      "Off-window horizontal prefixes may be estimated; geometry assertions target mounted visible glyphs, gutter, cursor, hit testing, and IME only.",
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      visibilityState: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      specMode: lumine.window.isSpecMode(),
      ciEnvironmentPresent: Boolean(process.env.CI),
    },
    packages: lumine.packages
      .getActivePackages()
      .map((pkg) => ({ name: pkg.name, version: pkg.metadata.version }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    input: {
      kind: config.inputFile ? "external" : "generated",
      generatedRows: config.inputFile ? null : config.generatedRows,
    },
    settings: { inputCount: config.inputCount, intervalMs: config.intervalMs },
    asyncErrors: [],
    asyncErrorCount: 0,
  };
  const recordError = (code) => {
    report.asyncErrorCount++;
    if (report.asyncErrors.length < 8) report.asyncErrors.push(code);
  };
  const captureError = () => recordError("UNCAUGHT_RENDERER_ERROR");
  const captureRejection = () => recordError("UNHANDLED_RENDERER_REJECTION");
  window.addEventListener("error", captureError);
  window.addEventListener("unhandledrejection", captureRejection);
  try {
    const openStart = performance.now();
    buffer = config.inputFile
      ? await TextBuffer.load(config.inputFile, { mustExist: true })
      : new TextBuffer({
          text: `${SPARSE_TOKEN}\n${"x\n".repeat(config.generatedRows)}${SPARSE_TOKEN}`,
        });
    if (config.inputFile) {
      const denySave = () =>
        Promise.reject(
          Object.assign(new Error("BENCHMARK_INPUT_SAVE_DISABLED"), {
            code: "BENCHMARK_INPUT_SAVE_DISABLED",
          }),
        );
      buffer.save = buffer.saveAs = buffer.saveTo = denySave;
    }
    lumine.grammars.assignLanguageMode(buffer, "text.plain.null-grammar");
    editor = lumine.workspace.buildTextEditor({ buffer, autoHeight: false, autoWidth: false });
    lumine.grammars.assignLanguageMode(buffer, "text.plain.null-grammar");
    editor.setSoftWrapped(false);
    editor.update({ undoGroupingInterval: 0 });
    pane = lumine.workspace.getActivePane();
    pane.addItem(editor);
    pane.activateItem(editor);
    editor.setSoftWrapped(false);
    const element = editor.getElement();
    element.setUpdatedSynchronously(false);
    element.focus();
    await settle();
    const component = element.getComponent();
    invariant(component.updatedSynchronously === false, "SYNCHRONOUS_TEST_RENDERING_ENABLED");
    report.openMs = performance.now() - openStart;
    report.input.units = buffer.getLength();
    report.input.lines = buffer.getLineCount();
    report.settings.grammar = editor.getGrammar().scopeName;
    invariant(report.settings.grammar === "text.plain.null-grammar", "BENCHMARK_GRAMMAR_CHANGED");
    report.settings.softWrapped = editor.isSoftWrapped();
    report.settings.softWrapColumn = Number.isFinite(editor.getSoftWrapColumn())
      ? editor.getSoftWrapColumn()
      : "Infinity";
    report.settings.largeDocumentView = editor.usesLargeDocumentView();
    report.settings.fontFamily = getComputedStyle(element).fontFamily;
    report.settings.fontSize = getComputedStyle(element).fontSize;
    report.settings.encoding = buffer.getEncoding();
    report.settings.viewport = {
      width: component.getScrollContainerClientWidth(),
      height: component.getScrollContainerClientHeight(),
    };
    const finishFrames = monitorFrames();
    report.phase = "cold-end";
    const endStarted = performance.now();
    invariant(
      lumine.commands.dispatch(element, "core:move-to-bottom"),
      "END_COMMAND_NOT_DISPATCHED",
    );
    const commandMs = performance.now() - endStarted;
    const nextRaf = await frame();
    await settle();
    invariant(
      editor.getCursorBufferPosition().isEqual(buffer.getEndPosition()),
      "END_POSITION_MISMATCH",
    );
    report.coldEnd = {
      commandMs,
      inputToNextRafMs: nextRaf - endStarted,
      settledMs: performance.now() - endStarted,
      frames: finishFrames(),
      viewport: inspectViewport(editor, component),
    };
    const original = buffer.getTextSnapshot();
    // Hash after cold open/navigation, outside every timing interval. Chunks
    // preserve unpaired surrogates and mixed EOLs without a full string.
    report.phase = "snapshot-hash";
    report.input.snapshotUtf16leSha256 = await snapshotDigest(original);
    report.inputs = [];
    for (const location of ["start", "middle", "end"]) {
      report.phase = `input-${location}`;
      report.inputs.push(await measureEnters(editor, component, location, config, original));
    }
    report.phase = "select-all";
    const selectStarted = performance.now();
    invariant(lumine.commands.dispatch(element, "core:select-all"), "SELECT_ALL_NOT_DISPATCHED");
    const selectCommandMs = performance.now() - selectStarted;
    const selectRaf = await frame();
    await settle();
    invariant(
      editor.getSelectedBufferRange().isEqual(buffer.getRange()),
      "SELECT_ALL_RANGE_MISMATCH",
    );
    invariant(report.asyncErrors.length === 0, "SELECTION_OBSERVER_FAILED");
    report.selectAll = {
      commandMs: selectCommandMs,
      inputToNextRafMs: selectRaf - selectStarted,
      units: buffer.getLength(),
      exactRange: true,
      viewport: inspectViewport(editor, component),
    };
    report.phase = "duplicate-all";
    const originalSelection = editor.getSelectedBufferRange();
    const ending =
      buffer.getPreferredLineEnding() ||
      buffer.lineEndingForRow(buffer.getLastRow()) ||
      buffer.lineEndingForRow(buffer.getLastRow() - 1);
    let expectedCopy = original;
    if (buffer.getEndPosition().column !== 0) expectedCopy = expectedCopy.replace(0, 0, "\n");
    if (ending)
      expectedCopy = require("../src/text-source-helpers").normalizeLineEndings(
        expectedCopy,
        ending,
      );
    const duplicateStarted = performance.now();
    const duplicateWork = lumine.commands.dispatch(element, "editor:duplicate-lines");
    invariant(duplicateWork, "DUPLICATE_NOT_DISPATCHED");
    const duplicateCommandMs = performance.now() - duplicateStarted;
    const firstDuplicateFrame = frame();
    await duplicateWork;
    const duplicateCompleteMs = performance.now() - duplicateStarted;
    const duplicateRaf = await firstDuplicateFrame;
    await settle();
    const duplicated = buffer.getTextSnapshot();
    invariant(
      duplicated.length === original.length + expectedCopy.length,
      "DUPLICATE_LENGTH_MISMATCH",
    );
    invariant(
      duplicated.subtext(0, original.length).equals(original),
      "DUPLICATE_CHANGED_ORIGINAL",
    );
    invariant(duplicated.subtext(original.length).equals(expectedCopy), "DUPLICATE_COPY_MISMATCH");
    const duplicateViewport = inspectViewport(editor, component);
    const duplicateUndoStarted = performance.now();
    invariant(lumine.commands.dispatch(element, "core:undo"), "DUPLICATE_UNDO_NOT_DISPATCHED");
    const duplicateUndoCommandMs = performance.now() - duplicateUndoStarted;
    await settle();
    invariant(buffer.getTextSnapshot().equals(original), "DUPLICATE_UNDO_TEXT_MISMATCH");
    invariant(
      editor.getSelectedBufferRange().isEqual(originalSelection),
      "DUPLICATE_UNDO_SELECTION_MISMATCH",
    );
    invariant(report.asyncErrorCount === 0, "DUPLICATE_OBSERVER_FAILED");
    report.duplicateAll = {
      commandMs: duplicateCommandMs,
      completeMs: duplicateCompleteMs,
      inputToNextRafMs: duplicateRaf - duplicateStarted,
      resultingUnits: duplicated.length,
      exactCopy: true,
      undoCommandMs: duplicateUndoCommandMs,
      exactSnapshotRestored: true,
      exactSelectionRestored: true,
      viewport: duplicateViewport,
    };
    editor.setCursorBufferPosition(buffer.getEndPosition());
    await settle();
    report.searches = [];
    for (const descriptor of [config.sparse, config.dense]) {
      report.phase = `search-${descriptor.name}`;
      report.searches.push(await measureSearch(buffer, descriptor, false));
    }
    report.phase = "search-cancellation";
    report.searches.push(
      await measureSearch(buffer, { ...config.dense, name: "dense-cancel" }, true),
    );
    invariant(buffer.getTextSnapshot().equals(original), "SEARCH_MUTATED_DOCUMENT");
    invariant(
      report.searches.every((search) => search.status !== "failed"),
      "SEARCH_BENCHMARK_FAILED",
    );
    invariant(report.asyncErrors.length === 0, "ASYNC_RENDERER_ERROR");
    report.status = "complete";
    report.phase = "complete";
    return report;
  } catch (error) {
    report.status = "failed";
    report.failure = { code: error.code || error.name };
    return report;
  } finally {
    window.removeEventListener("error", captureError);
    window.removeEventListener("unhandledrejection", captureRejection);
    // Remove only this ephemeral pane item. Never save, reload, or overwrite the
    // external input; process isolation also disables session autosaves.
    if (editor) {
      pane?.removeItem(editor);
      editor.destroy();
    }
    if (buffer && !buffer.isDestroyed()) buffer.destroy();
  }
}

module.exports = { runBenchmark };

if (typeof describe === "function") {
  describe("Large document benchmark", () => {
    it("runs the configured smoke or explicitly requested input", async () => {
      jasmine.useRealClock();
      const workspace = lumine.views.getView(lumine.workspace);
      workspace.style.width = "1100px";
      workspace.style.height = "750px";
      jasmine.attachToDOM(workspace);
      const options = JSON.parse(process.env.LUMINE_LARGE_DOCUMENT_BENCHMARK_CONFIG || "{}");
      const report = await runBenchmark(options);
      console.log(`LARGE_DOCUMENT_BENCHMARK=${JSON.stringify(report)}`);
      expect(report.status).toBe("complete");
    }, 600000);
  });
}
