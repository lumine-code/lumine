const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app, ipcMain, screen } = require("electron");
const { revisionInFrame, summarize, percentile } = require("./presentation-observer");
const install = require("./presentation-renderer");
const config = JSON.parse(process.env.LUMINE_PRESENTATION_CONFIG);
const channel = "lumine:presentation-benchmark";
const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = {
  schemaVersion: 1,
  status: "running",
  startedAt: new Date().toISOString(),
  config,
  cases: [],
  control: null,
  caveats: [
    "Subscription-observed composited frame, not physical monitor scanout.",
    "Capture/copy and marker instrumentation add overhead; CPU and frame latency are separate and may overlap.",
    "Sequential interactions with syntax settled between samples; not a sustained typing-throughput test.",
    `Electron ${process.versions.electron} caps beginFrameSubscription at 30 FPS. Input-to-capture includes capture delay and cannot prove first monitor presentation or count missed display frames.`,
    "CPU fields are instrumented synchronous component/model method wall times collected until settle; async parsing and general renderer work outside those methods are excluded. No syntax-correct second paint is asserted.",
    "Paste follows native Ctrl-V through the core command with an in-memory benchmark clipboard; excludes native clipboard transfer and paste providers.",
  ],
};
app.setAppPath(config.root);
// src/main's argv parser must see the source root as its app entry.
process.argv[1] = config.root;
let entered = false;
app.on("browser-window-created", (_event, window) => {
  if (entered) return;
  entered = true;
  window.webContents.once("did-finish-load", () => {
    run(window).catch((error) => finish(window, error));
  });
});
require(path.join(config.root, "src", "main.js"));

async function finish(window, error) {
  if (error) {
    result.status = "failed";
    result.error = error.stack || String(error);
  }
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(config.output, "results.json"), JSON.stringify(result, null, 2));
  try {
    window.webContents.endFrameSubscription();
    await window.webContents.executeJavaScript("window.presentationBenchmark?.dispose()");
  } catch (teardownError) {
    result.teardownError = teardownError.stack || String(teardownError);
    fs.writeFileSync(path.join(config.output, "results.json"), JSON.stringify(result, null, 2));
  }
  app.exit(error || result.status !== "complete" ? 1 : 0);
}

async function run(window) {
  const contents = window.webContents;
  const evaluate = (code) => contents.executeJavaScript(code);
  const call = (name, value) =>
    evaluate(`window.presentationBenchmark.${name}(${JSON.stringify(value)})`);
  for (let i = 0; i < 900; i++) {
    if (await evaluate("Boolean(window.lumine && lumine.packages.getActivePackages().length)"))
      break;
    if (i === 899) throw new Error("Window did not become ready");
    await delay(100);
  }
  contents.closeDevTools();
  window.setContentSize(1200, 800);
  const display = screen.getPrimaryDisplay();
  window.setPosition(display.workArea.x + 20, display.workArea.y + 20);
  window.setAlwaysOnTop(true);
  window.show();
  window.moveTop();
  app.focus({ steal: true });
  window.focus();
  contents.focus();
  await delay(500);
  const renderer = await evaluate(`(${install.toString()})(${JSON.stringify(config)})`);
  window.show();
  window.moveTop();
  window.focus();
  contents.focus();
  for (let attempt = 0; attempt < 50; attempt++) {
    const visibility = await evaluate(
      "({visibilityState:document.visibilityState,hasFocus:document.hasFocus()})",
    );
    Object.assign(renderer, visibility);
    if (visibility.visibilityState === "visible" && visibility.hasFocus) break;
    await delay(100);
  }
  result.visibility = {
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    focused: window.isFocused(),
    offscreen: contents.isOffscreen(),
    nativeWindowHandle: window.getNativeWindowHandle().toString("hex"),
    bounds: window.getBounds(),
    displays: screen.getAllDisplays(),
    renderer,
  };
  if (
    !window.isVisible() ||
    window.isMinimized() ||
    !window.isFocused() ||
    renderer.visibilityState !== "visible" ||
    !renderer.hasFocus
  )
    throw new Error("Benchmark requires a visible focused window");
  result.environment = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0].model,
    bounds: window.getBounds(),
    contentBounds: window.getContentBounds(),
    display: {
      id: display.id,
      label: display.label,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      displayFrequency: display.displayFrequency,
    },
    actualDisplay: (() => {
      const actual = screen.getDisplayMatching(window.getBounds());
      return {
        id: actual.id,
        label: actual.label,
        bounds: actual.bounds,
        workArea: actual.workArea,
        scaleFactor: actual.scaleFactor,
        displayFrequency: actual.displayFrequency,
      };
    })(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    alwaysOnTop: window.isAlwaysOnTop(),
    devToolsOpen: contents.isDevToolsOpened(),
    renderer,
    gpu: await app.getGPUInfo("basic"),
  };
  let pending = null;
  let frameIndex = 0;
  const calibration = [];
  const frames = [];
  ipcMain.on(channel, (event, message) => {
    if (event.sender === contents && pending?.revision === message.revision)
      pending.ack = { ...message, receivedAt: now() };
  });
  contents.beginFrameSubscription(true, (image, dirtyRect) => {
    const receivedAt = now();
    const revision = revisionInFrame(image, dirtyRect, renderer.marker, renderer.devicePixelRatio);
    frameIndex++;
    if (revision >= 60000) calibration.push(receivedAt);
    if (!pending) return;
    pending.observedFrames++;
    if (revision !== pending.revision || pending.presentation) return;
    pending.presentation = {
      receivedAt,
      frameIndex,
      dirtyRect,
      captureSize: image.getSize(),
      latencyMs: receivedAt - pending.sentAt,
      ackAlreadyReceived: Boolean(pending.ack),
    };
    pending.resolve?.();
    frames.push({ revision, ...pending.presentation });
  });
  const animationFrames = await call("calibrate");
  await delay(100);
  const intervals = calibration
    .slice(1)
    .map((value, i) => value - calibration[i])
    .filter((value) => value > 2 && value < 100);
  const animationIntervals = animationFrames
    .slice(1)
    .map((value, index) => value - animationFrames[index]);
  if (calibration.length < 10)
    throw new Error("Captured frames did not reliably decode marker revisions");
  const capturePeriodMs = 1000 / 30;
  result.cadence = {
    capturePeriodMs,
    captureCapFps: 30,
    source: `https://raw.githubusercontent.com/electron/electron/v${process.versions.electron}/shell/browser/api/frame_subscriber.cc`,
    missedDisplayFrames: null,
    observedFrameCount: calibration.length,
    intervalsMs: intervals,
    subscriptionCadenceMs: percentile(intervals, 0.5),
    animationFrameIntervalsMs: animationIntervals,
    animationFrameMedianMs: percentile(animationIntervals, 0.5),
    displayPeriodMs: display.displayFrequency > 0 ? 1000 / display.displayFrequency : null,
  };
  let revision = 1;
  const cases = [];
  for (const document of ["plain", "javascript"])
    for (const operation of ["typing", "paste", "undo", "scroll"])
      cases.push({ document, operation });
  for (const document of ["html", "vue", "ipython"])
    for (const location of ["inside", "outside"])
      cases.push({ document, operation: "typing", location });
  cases.push({ document: "plain", operation: "no-op" });
  for (const entry of cases) {
    const caseName = `${entry.document}/${entry.operation}${entry.location ? `/${entry.location}` : ""}`;
    if (config.case && config.case !== caseName) continue;
    const document = await call("load", entry.document);
    const samples = [];
    const warmups = [];
    for (let index = 0; index < config.samples + config.warmups; index++) {
      const action = {
        revision: revision++,
        kind: entry.operation,
        row: entry.location === "outside" ? document.outsideRow : document.row,
        text:
          entry.operation === "paste"
            ? "pasted_identifier_".repeat(40)
            : entry.operation === "undo"
              ? "undo_probe"
              : "x",
      };
      const position = await call("prepare", action);
      if (
        !window.isVisible() ||
        window.isMinimized() ||
        !window.isFocused() ||
        position.visibilityState !== "visible" ||
        !position.hasFocus
      ) {
        result.failureContext = {
          action,
          position,
          visible: window.isVisible(),
          minimized: window.isMinimized(),
          focused: window.isFocused(),
        };
        throw new Error("Window lost visibility or focus during the benchmark");
      }
      const sample = {
        revision: action.revision,
        index,
        observedFrames: 0,
        sentAt: 0,
        presentation: null,
        ack: null,
      };
      pending = sample;
      const presented = new Promise((resolve) => {
        sample.resolve = resolve;
      });
      sample.sentAt = now();
      const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
      if (entry.operation === "scroll") {
        contents.sendInputEvent({
          type: "mouseWheel",
          x: position.x,
          y: position.y,
          deltaY: index % 2 ? 120 : -120,
          deltaX: 0,
          canScroll: true,
        });
      } else {
        const keyCode =
          entry.operation === "paste"
            ? "V"
            : entry.operation === "undo"
              ? "Z"
              : entry.operation === "no-op"
                ? "F24"
                : "X";
        const keyModifiers = ["paste", "undo"].includes(entry.operation) ? modifiers : [];
        contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: keyModifiers });
        if (entry.operation === "typing")
          contents.sendInputEvent({ type: "char", keyCode: action.text });
        contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: keyModifiers });
      }
      if (entry.operation === "no-op") await delay(120);
      else await Promise.race([presented, delay(2000)]);
      const observed = await call("finish");
      pending = null;
      delete sample.resolve;
      sample.renderer = observed;
      sample.failure =
        !observed.expectedTextMatches ||
        !observed.inputReceived ||
        !observed.trustedInput ||
        !observed.scrollAnimationIdle ||
        observed.visibilityLost ||
        observed.visibilityState !== "visible" ||
        !observed.hasFocus ||
        !window.isVisible() ||
        window.isMinimized() ||
        !window.isFocused() ||
        (entry.operation === "no-op"
          ? observed.textChanged ||
            Math.abs(observed.scrollDelta) > 1 ||
            observed.acknowledged ||
            Boolean(sample.presentation)
          : !sample.presentation || !observed.acknowledged);
      sample.capturePeriodExceeded = Boolean(
        sample.presentation && sample.presentation.latencyMs > capturePeriodMs,
      );
      sample.extraCapturePeriods = sample.presentation
        ? Math.max(0, Math.ceil(sample.presentation.latencyMs / capturePeriodMs) - 1)
        : null;
      (index < config.warmups ? warmups : samples).push(sample);
    }
    const summary = {
      name: `${entry.document}/${entry.operation}${entry.location ? `/${entry.location}` : ""}`,
      document,
      warmups,
      samples,
      presentation: summarize(
        samples
          .filter((sample) => !sample.failure && sample.presentation)
          .map((sample) => sample.presentation.latencyMs),
      ),
      domAcknowledgement: summarize(
        samples
          .filter((sample) => !sample.failure && sample.ack)
          .map((sample) => sample.ack.receivedAt - sample.sentAt),
      ),
      acknowledgementToCapture: summarize(
        samples
          .filter((sample) => !sample.failure && sample.ack && sample.presentation)
          .map((sample) => sample.presentation.receivedAt - sample.ack.receivedAt),
      ),
      componentCpu: summarize(samples.map((sample) => sample.renderer.updateCpuMs)),
      modelOperationCpu: summarize(samples.map((sample) => sample.renderer.modelOperationCpuMs)),
      failures: samples.filter((sample) => sample.failure).length,
      warmupFailures: warmups.filter((sample) => sample.failure).length,
      capturePeriodExceeded: samples.filter((sample) => sample.capturePeriodExceeded).length,
      extraCapturePeriods: samples.reduce(
        (sum, sample) => sum + (sample.extraCapturePeriods || 0),
        0,
      ),
      longTasks: samples.flatMap((sample) => sample.renderer.longTasks).length,
    };
    if (entry.operation === "no-op") result.control = summary;
    else result.cases.push(summary);
    fs.writeFileSync(path.join(config.output, "results.json"), JSON.stringify(result, null, 2));
  }
  result.frames = frames;
  result.status =
    result.cases.some((entry) => entry.failures || entry.warmupFailures) ||
    result.control?.failures ||
    result.control?.warmupFailures ||
    (!result.cases.length && !result.control)
      ? "failed"
      : "complete";
  await finish(window);
}
