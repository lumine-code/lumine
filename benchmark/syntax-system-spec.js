// Opt-in Electron benchmark, compatible with older worker implementations.
// LUMINE_SYNTAX_SYSTEM_BENCHMARK={"out":"<directory>","label":"baseline"}
// Run: npm run test:only -- benchmark/syntax-system-spec.js
// Cases: small-edits, competing-parses, long-line, repeated-close.
// Reports DOM update and animation-frame observations separately; neither is a
// compositor screenshot. Synthetic inputs are never saved to disk.
const fs = require("node:fs");
const path = require("node:path");

// The same file is an analysis module in the worker. It reads only scalar
// metadata and bounded source slices; no full-document materialization.
exports.inspect = (context) => {
  const runtime = require("../src/tree-sitter-runtime");
  const scheduler = require("../src/tree-sitter-scheduler");
  const root = context.getRootSyntaxNode();
  return {
    revision: context.buffer.getTextRevision(),
    length: context.buffer.getLength(),
    rows: context.buffer.getLineCount(),
    rootEndIndex: root?.endIndex ?? null,
    rootHasError: root?.hasError ?? null,
    allocatedMemoryBytes: runtime.memory?.buffer.byteLength ?? null,
    resources: runtime.resourceState?.() ?? null,
    parserJobs: {
      activeLegacy: scheduler.active,
      queuedLegacy: scheduler.queue.length,
      scheduledSlices: scheduler.slices?.length ?? null,
    },
    processMemory: process.memoryUsage(),
  };
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const frame = () => new Promise(requestAnimationFrame);
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};
const distribution = (values) => ({
  count: values.filter(Number.isFinite).length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: Math.max(0, ...values.filter(Number.isFinite)),
});

function domLine(editor, row) {
  const component = editor.getElement().component;
  return [...component.lineComponentsByScreenLineId.values()].find(
    (line) => Number(line.element.dataset.screenRow) === row && !line.props.offScreen,
  )?.element;
}

function presentationSummary(editor) {
  const mode = editor.getBuffer().getLanguageMode();
  return {
    availability: editor.getSyntaxAvailability(),
    highlighting: mode.getHighlightingStatus?.() ?? null,
    sourceLength: editor.getBuffer().getLength(),
    softWrapColumn: Number.isFinite(editor.getSoftWrapColumn())
      ? editor.getSoftWrapColumn()
      : "Infinity",
    renderedLines: [...editor.getElement().component.lineComponentsByScreenLineId.values()]
      .slice(0, 4)
      .map((line) => ({
        row: line.element.dataset.screenRow,
        offScreen: line.props.offScreen,
        classes: [...line.element.querySelectorAll("[class*='syntax--']")]
          .slice(0, 12)
          .map((span) => span.className),
      })),
    scopeFragments: mode.cache?.snapshots.slice(0, 4).map((snapshot) => ({
      start: snapshot.start,
      end: snapshot.end,
      events: snapshot.events.length,
    })),
  };
}

function measureFrames(sample = () => ({})) {
  const frames = [];
  const timerDelays = [];
  let running = true;
  let previousFrame = performance.now();
  let expectedTimer = previousFrame + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    timerDelays.push(Math.max(0, now - expectedTimer));
    expectedTimer = now + 10;
  }, 10);
  const next = () => {
    if (!running) return;
    const now = performance.now();
    frames.push({ at: now, intervalMs: now - previousFrame, ...sample(now) });
    previousFrame = now;
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
  return () => {
    running = false;
    clearInterval(timer);
    return {
      frameIntervalsMs: distribution(frames.map((entry) => entry.intervalMs)),
      timerDelaysMs: distribution(timerDelays),
      frames,
    };
  };
}

async function waitUntil(predicate, timeoutMs, message) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start >= timeoutMs) throw new Error(message);
    await sleep(4);
  }
}

async function bounded(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measureEdits(editor, configuration) {
  const prefix = "const target = ";
  const observations = [];
  let previousValue = "1";
  for (let index = 0; index < configuration.edits; index++) {
    const value = index % 2 ? String(100 + index) : `"value${index}"`;
    const selector = index % 2 ? ".syntax--numeric" : ".syntax--string";
    const expected = `${prefix}${value};`;
    const start = performance.now();
    const observation = {
      index,
      value,
      revision: null,
      textDomMs: null,
      colorDomMs: null,
      colorFrameMs: null,
      firstStyledDomMs: null,
      firstStyledFrameMs: null,
    };
    let current = true;
    const inspect = (now = performance.now(), fromFrame = false) => {
      if (!current) return;
      const line = domLine(editor, 0);
      const textCurrent = line?.textContent === expected;
      if (textCurrent && observation.textDomMs === null) observation.textDomMs = now - start;
      const styled =
        textCurrent &&
        [...line.querySelectorAll(selector)].some((span) =>
          span.textContent.includes(value.replaceAll('"', "")),
        );
      if (styled && observation.firstStyledDomMs === null)
        observation.firstStyledDomMs = now - start;
      if (styled && fromFrame && observation.firstStyledFrameMs === null)
        observation.firstStyledFrameMs = now - start;
      const colorCurrent =
        styled &&
        editor.getBuffer().getTextRevision() === observation.revision &&
        editor.getBuffer().getSyntaxSnapshotToken() !== null &&
        (!editor.getBuffer().getLanguageMode().getHighlightingStatus ||
          editor.getBuffer().getLanguageMode().getHighlightingStatus().state === "ready");
      if (colorCurrent && observation.colorDomMs === null) observation.colorDomMs = now - start;
      if (colorCurrent && fromFrame && observation.colorFrameMs === null)
        observation.colorFrameMs = now - start;
      return {
        textCurrent,
        colorCurrent,
        retainedStableColor: Boolean(domLine(editor, 1)?.querySelector(".syntax--string")),
      };
    };
    const mutation = new MutationObserver(() => inspect());
    mutation.observe(editor.getElement(), {
      subtree: true,
      characterData: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    const stopFrames = measureFrames((now) => inspect(now, true));
    try {
      editor.setTextInBufferRange(
        [
          [0, prefix.length],
          [0, prefix.length + previousValue.length],
        ],
        value,
      );
      observation.revision = editor.getBuffer().getTextRevision();
      const settled = editor.whenGrammarSettled().then(() => {
        observation.parseReadyMs = performance.now() - start;
      });
      await waitUntil(
        () => observation.colorFrameMs !== null,
        configuration.timeoutMs,
        "Edited text did not acquire current colors",
      );
      await settled;
      observation.highlighting =
        editor.getBuffer().getLanguageMode().getHighlightingStatus?.() ?? null;
      observations.push({ ...observation, ...stopFrames() });
    } finally {
      current = false;
      mutation.disconnect();
      stopFrames();
    }
    previousValue = value;
    await sleep(configuration.editGapMs);
  }
  return {
    textDomMs: distribution(observations.map((entry) => entry.textDomMs)),
    colorDomMs: distribution(observations.map((entry) => entry.colorDomMs)),
    colorFrameMs: distribution(observations.map((entry) => entry.colorFrameMs)),
    firstStyledDomMs: distribution(observations.map((entry) => entry.firstStyledDomMs)),
    firstStyledFrameMs: distribution(observations.map((entry) => entry.firstStyledFrameMs)),
    parseReadyMs: distribution(observations.map((entry) => entry.parseReadyMs)),
    framesMissingRetainedColor: observations.reduce(
      (sum, entry) => sum + entry.frames.filter((item) => !item.retainedStableColor).length,
      0,
    ),
    observations,
  };
}

if (typeof describe === "function")
  describe("Syntax system latency and resource benchmark", () => {
    it("records visible correctness, multi-document contention, long lines and worker retention", async () => {
      jasmine.useRealClock();
      const provided = JSON.parse(process.env.LUMINE_SYNTAX_SYSTEM_BENCHMARK ?? "{}");
      if (!provided.out)
        throw new Error("Set LUMINE_SYNTAX_SYSTEM_BENCHMARK with an output directory");
      const configuration = {
        label: "working-tree",
        cases: ["small-edits", "competing-parses", "long-line", "repeated-close"],
        edits: 20,
        editGapMs: 40,
        backgroundRows: 150000,
        longLineUnits: 1000000,
        closeRows: 300000,
        closeCycles: 3,
        recycleWaitMs: 2000,
        timeoutMs: 60000,
        ...provided,
      };
      for (const key of [
        "edits",
        "backgroundRows",
        "longLineUnits",
        "closeRows",
        "closeCycles",
        "timeoutMs",
      ])
        if (!Number.isSafeInteger(configuration[key]) || configuration[key] < 1)
          throw new Error(`Invalid ${key}`);
      fs.mkdirSync(configuration.out, { recursive: true });
      const Service = require("../src/syntax-worker-service");
      const WorkerMode = require("../src/tree-sitter-worker-language-mode");
      await lumine.packages.activatePackage("language-javascript");
      const grammar = lumine.grammars.grammarForScopeName("source.js");
      const workspace = lumine.workspace.getElement();
      workspace.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
      jasmine.attachToDOM(workspace);
      const service = new Service(lumine.grammars);
      const editors = new Set();
      const build = (text, active = false) => {
        const editor = lumine.workspace.buildTextEditor();
        editors.add(editor);
        editor.setText(text);
        editor.setSoftWrapped(false);
        editor.setCursorBufferPosition([0, 0]);
        editor
          .getBuffer()
          .setLanguageMode(new WorkerMode({ buffer: editor.getBuffer(), grammar, service }));
        if (active) activate(editor);
        return editor;
      };
      const activate = (editor) => {
        const pane = lumine.workspace.getActivePane();
        if (!pane.getItems().includes(editor)) pane.addItem(editor);
        pane.activateItem(editor);
        editor.getElement().setUpdatedSynchronously(false);
        editor.getElement().focus();
        editor.getElement().component.setScrollTop(0);
        editor.getElement().component.setScrollLeft(0);
        service.focusBuffer(editor.getBuffer());
      };
      const close = (editor) => {
        editors.delete(editor);
        editor.destroy();
      };
      const inspect = (editor) =>
        bounded(
          editor.analyzeSyntax(__filename, "inspect"),
          configuration.timeoutMs,
          "Worker diagnostic request timed out",
        );
      const settle = (editor) =>
        bounded(
          editor.whenGrammarSettled(),
          configuration.timeoutMs,
          "Grammar settlement timed out",
        );
      const smallText =
        'const target = 1;\nconst stable = "retained";\n' + "const other = 2;\n".repeat(300);
      const result = {
        configuration,
        recordedAt: new Date().toISOString(),
        versions: process.versions,
        cases: [],
        notes: [
          "Color latency includes a current semantic snapshot and observed DOM scopes on the edited text.",
          "Animation-frame samples observe browser DOM before paint, not compositor output.",
          "Process RSS is shared by this process and is not per-document or live WASM allocation.",
        ],
      };
      try {
        const small = build(smallText, true);
        await settle(small);
        await waitUntil(
          () => Boolean(domLine(small, 0)?.querySelector(".syntax--numeric")),
          configuration.timeoutMs,
          "Initial small document did not color",
        );
        await frame();
        if (configuration.cases.includes("small-edits")) {
          result.cases.push({
            name: "small-edits",
            ...(await measureEdits(small, configuration)),
            worker: await inspect(small),
          });
          small.setTextInBufferRange(
            [
              [0, 0],
              [0, Infinity],
            ],
            "const target = 1;",
          );
          await settle(small);
        }
        if (configuration.cases.includes("competing-parses")) {
          const input = "const background = [1, 2, 3];\n".repeat(configuration.backgroundRows);
          const first = build(input);
          const second = build(input);
          // Admit the third document only after both complete source transfers.
          // The diagnostic records whether parser work is genuinely contended;
          // a tiny smoke fixture may already be finished and proves no fairness.
          await Promise.all(
            [first, second].map((editor) => editor.getBuffer().getLanguageMode().session.chain),
          );
          const backgroundBeforeForeground = await inspect(small);
          const start = performance.now();
          const third = build(smallText, true);
          const stopFrames = measureFrames();
          try {
            const firstReady = settle(first).then((ready) => ({
              ready,
              ms: performance.now() - start,
            }));
            const secondReady = settle(second).then((ready) => ({
              ready,
              ms: performance.now() - start,
            }));
            const thirdReady = await settle(third);
            const thirdParseMs = performance.now() - start;
            await waitUntil(
              () => Boolean(domLine(third, 0)?.querySelector(".syntax--numeric")),
              configuration.timeoutMs,
              "Focused document did not color",
            );
            const thirdColorMs = performance.now() - start;
            const backgroundAtForegroundColor = [first, second].map(
              (editor) => editor.getBuffer().getSyntaxSnapshotToken() !== null,
            );
            const edits = await measureEdits(third, {
              ...configuration,
              edits: Math.min(configuration.edits, 10),
            });
            result.cases.push({
              name: "competing-parses",
              thirdReady,
              thirdParseMs,
              thirdColorMs,
              backgroundAtForegroundColor,
              backgroundBeforeForeground,
              backgroundReady: await Promise.all([firstReady, secondReady]),
              edits,
              ...stopFrames(),
              worker: await inspect(third),
            });
          } finally {
            stopFrames();
            close(first);
            close(second);
            close(third);
            activate(small);
          }
        }
        if (configuration.cases.includes("long-line")) {
          const prefix = "const values = [";
          const input = prefix + "1,".repeat(Math.ceil(configuration.longLineUnits / 2)) + "0];";
          const start = performance.now();
          const long = build(input, true);
          const numericLine = () =>
            domLine(long, long.screenPositionForBufferPosition([0, prefix.length]).row);
          let firstNumericColorMs = null;
          let firstNumericFrameMs = null;
          const statusTransitions = [];
          const sampleColor = (now = performance.now(), fromFrame = false) => {
            const colored = Boolean(numericLine()?.querySelector(".syntax--numeric"));
            const status = long.getBuffer().getLanguageMode().getHighlightingStatus?.();
            const statusKey = status && `${status.state}:${status.reasons.join(",")}`;
            if (statusKey && statusTransitions.at(-1)?.key !== statusKey)
              statusTransitions.push({ atMs: now - start, key: statusKey, ...status });
            if (colored && firstNumericColorMs === null) firstNumericColorMs = now - start;
            if (colored && fromFrame && firstNumericFrameMs === null)
              firstNumericFrameMs = now - start;
            return { colored };
          };
          const stopFrames = measureFrames((now) => sampleColor(now, true));
          const mutation = new MutationObserver(() => sampleColor());
          mutation.observe(long.getElement(), {
            subtree: true,
            characterData: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class"],
          });
          try {
            const settled = await settle(long);
            const parseReadyMs = performance.now() - start;
            const neighbourStart = performance.now();
            const neighbour = await inspect(small);
            const neighbourResponseMs = performance.now() - neighbourStart;
            try {
              await waitUntil(
                () => firstNumericFrameMs !== null || !long.getSyntaxAvailability().available,
                configuration.timeoutMs,
                "Long line neither colored nor reported unavailable syntax",
              );
              await waitUntil(
                () =>
                  long.getBuffer().getLanguageMode().getHighlightingStatus?.().state !==
                  "provisional",
                configuration.timeoutMs,
                "Exact syntax did not replace provisional colors",
              );
            } catch (error) {
              result.cases.push({
                name: "long-line",
                failure: error.message,
                presentation: presentationSummary(long),
                worker: await inspect(small),
              });
              throw error;
            }
            result.cases.push({
              name: "long-line",
              inputUnits: input.length,
              settled,
              parseReadyMs,
              firstNumericColorMs,
              firstNumericFrameMs,
              statusTransitions,
              presentation: presentationSummary(long),
              neighbourResponseMs,
              neighbourAvailable: Boolean(neighbour),
              availability: long.getSyntaxAvailability(),
              ...stopFrames(),
              worker: await inspect(small),
            });
          } finally {
            mutation.disconnect();
            stopFrames();
            close(long);
            activate(small);
          }
        }
        if (configuration.cases.includes("repeated-close")) {
          const cycles = [];
          for (let cycle = 0; cycle < configuration.closeCycles; cycle++) {
            const before = await inspect(small);
            const originalClient = service.client;
            const heavy = build("const heavy = [1, 2, 3];\n".repeat(configuration.closeRows));
            try {
              const settled = await settle(heavy);
              const loaded = await inspect(small);
              const clientBeforeClose = service.client;
              close(heavy);
              await sleep(configuration.recycleWaitMs);
              const after = await inspect(small);
              const start = performance.now();
              small.setTextInBufferRange(
                [
                  [0, 0],
                  [0, Infinity],
                ],
                `const target = ${cycle + 1};`,
              );
              await settle(small);
              cycles.push({
                cycle,
                settled,
                before,
                loaded,
                after,
                workerReplaced: originalClient !== service.client,
                workerReplacedDuringLoad: originalClient !== clientBeforeClose,
                workerReplacedAfterClose: clientBeforeClose !== service.client,
                neighbourEditMs: performance.now() - start,
                neighbourAvailable: small.getSyntaxAvailability().available,
              });
            } finally {
              if (editors.has(heavy)) close(heavy);
            }
          }
          result.cases.push({ name: "repeated-close", cycles });
        }
      } finally {
        for (const editor of editors) editor.destroy();
        service.dispose();
        fs.writeFileSync(
          path.join(configuration.out, "syntax-system.json"),
          JSON.stringify(result, null, 2),
        );
      }
      expect(result.cases.map((entry) => entry.name).sort()).toEqual(
        [...configuration.cases].sort(),
      );
      console.log(
        JSON.stringify({
          output: path.join(configuration.out, "syntax-system.json"),
          cases: result.cases.map(({ name, colorFrameMs, thirdColorMs, neighbourResponseMs }) => ({
            name,
            colorFrameMs,
            thirdColorMs,
            neighbourResponseMs,
          })),
        }),
      );
    }, 360000);
  });
