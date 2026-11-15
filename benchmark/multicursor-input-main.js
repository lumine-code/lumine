// An opt-in normal, visible application for the shared multicursor benchmark.
// The ordinary Jasmine runner remains separate and CI is never impersonated.
const path = require("node:path");
const os = require("node:os");
const { app, ipcMain, screen } = require("electron");
const { revisionInFrame } = require("./presentation-observer");

const config = JSON.parse(process.env.LUMINE_MULTICURSOR_INPUT_BENCH_CONFIG);
const source = path.resolve(config.sourcePath);
const benchmark = path.resolve(config.benchmarkPath);
const CHANNEL = "lumine:multicursor-input-frame";
const now = () => Number(process.hrtime.bigint()) / 1e6;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windows = new Map();
const captures = new Map();

function detach(contents) {
  if (!captures.delete(contents.id)) return;
  if (!contents.isDestroyed()) contents.endFrameSubscription();
}

ipcMain.handle(CHANNEL, async (event, message) => {
  const contents = event.sender;
  const window = windows.get(contents.id);
  if (!window || window.isDestroyed()) throw new Error("Unknown benchmark window");
  if (message.type === "detach") return detach(contents);
  if (message.type === "clock") return { receivedAt: now() };
  if (message.type === "attach") {
    if (
      contents.isOffscreen() ||
      !Number.isFinite(message.devicePixelRatio) ||
      message.devicePixelRatio <= 0 ||
      !Number.isFinite(message.marker?.x) ||
      !Number.isFinite(message.marker?.y)
    )
      throw new Error("Capture requires an ordinary compositor and valid marker coordinates");
    detach(contents);
    window.show();
    window.moveTop();
    app.focus({ steal: true });
    window.focus();
    contents.focus();
    const state = { pending: null, frameIndex: 0 };
    captures.set(contents.id, state);
    contents.beginFrameSubscription(true, (image, dirtyRect) => {
      const observedAt = now();
      const revision = revisionInFrame(image, dirtyRect, message.marker, message.devicePixelRatio);
      state.frameIndex++;
      if (state.calibration && revision >= 60000) state.calibration.push({ revision, observedAt });
      const pending = state.pending;
      if (!pending || pending.observation || pending.revision !== revision) return;
      pending.observation = {
        revision,
        observedAt,
        frameIndex: state.frameIndex,
        dirtyRect,
        captureSize: image.getSize(),
        armToObservedFrameMs: observedAt - pending.armedAt,
        visible: window.isVisible() && !window.isMinimized(),
        focused: window.isFocused(),
      };
      deliver(contents, pending);
    });
    const display = screen.getDisplayMatching(window.getBounds());
    return {
      mode: "normal-visible-application",
      captureApi: "webContents.beginFrameSubscription(true)",
      rendererOffscreen: contents.isOffscreen(),
      visible: window.isVisible(),
      focused: window.isFocused(),
      contentBounds: window.getContentBounds(),
      display: {
        id: display.id,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
        displayFrequency: display.displayFrequency,
      },
      runtime: process.versions,
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0]?.model,
      ciEnvironment: process.env.CI ?? null,
    };
  }
  if (message.type === "calibration-start") {
    const state = captures.get(contents.id);
    if (!state) throw new Error("Attach the frame probe before calibrating it");
    state.calibration = [];
    return;
  }
  if (message.type === "calibration-finish") {
    const state = captures.get(contents.id);
    if (!state?.calibration) throw new Error("Start a frame calibration before finishing it");
    const frames = state.calibration;
    state.calibration = null;
    return frames;
  }
  if (message.type === "arm") {
    const state = captures.get(contents.id);
    if (!state) throw new Error("Attach the frame probe before arming it");
    if (
      !Number.isSafeInteger(message.revision) ||
      message.revision < 1 ||
      message.revision >= 60000
    )
      throw new Error("Invalid frame marker revision");
    state.pending = { revision: message.revision, armedAt: now() };
    return { armedAt: state.pending.armedAt };
  }
  throw new Error(`Unknown frame probe request ${message.type}`);
});

function deliver(contents, pending) {
  if (
    pending.delivered ||
    !pending.observation ||
    !Number.isFinite(pending.startedAt) ||
    !Number.isFinite(pending.domAcknowledgedAt)
  )
    return;
  pending.delivered = true;
  contents.send(`${CHANNEL}:capture`, {
    ...pending.observation,
    startedAt: pending.startedAt,
    invocationToObservedFrameMs: pending.observation.observedAt - pending.startedAt,
    domAcknowledgedAt: pending.domAcknowledgedAt,
    acknowledgementToObservedFrameMs: pending.observation.observedAt - pending.domAcknowledgedAt,
  });
}

ipcMain.on(CHANNEL, (event, message) => {
  const pending = captures.get(event.sender.id)?.pending;
  if (!pending || pending.revision !== message.revision) return;
  if (message.type === "start" && Number.isFinite(message.startedAt)) {
    pending.startedAt = message.startedAt;
    deliver(event.sender, pending);
  } else if (message.type === "ack" && Number.isFinite(message.domAcknowledgedAt)) {
    pending.domAcknowledgedAt = message.domAcknowledgedAt;
    deliver(event.sender, pending);
  }
});

let entered = false;
app.on("browser-window-created", (_event, window) => {
  const contents = window.webContents;
  windows.set(contents.id, window);
  contents.once("destroyed", () => {
    captures.delete(contents.id);
    windows.delete(contents.id);
  });
  if (entered) return;
  entered = true;
  contents.once("did-finish-load", () => {
    run(window).catch((error) => {
      console.error(error.stack || error);
      detach(contents);
      app.exit(1);
    });
  });
});

async function run(window) {
  const contents = window.webContents;
  for (let attempt = 0; attempt < 900; attempt++) {
    if (
      await contents.executeJavaScript(
        "Boolean(window.lumine && lumine.packages.getActivePackages().length)",
      )
    )
      break;
    if (attempt === 899) throw new Error("Normal benchmark renderer did not become ready");
    await delay(100);
  }
  contents.closeDevTools();
  window.setContentSize(1200, 800);
  window.show();
  window.moveTop();
  app.focus({ steal: true });
  window.focus();
  contents.focus();
  await contents.executeJavaScript(`require(${JSON.stringify(benchmark)})()`);
  detach(contents);
  const unloaded = await contents.executeJavaScript(
    `lumine.prepareToUnloadEditorWindow(${JSON.stringify({ id: window.id })}).then((ready) => {
      if (!ready) return false;
      lumine.unloadEditorWindow();
      lumine.destroy();
      return true;
    })`,
  );
  if (!unloaded) throw new Error("Benchmark window declined its orderly unload");
  app.exit(0);
}

app.setAppPath(source);
process.argv[1] = source;
require(path.join(source, "src", "main.js"));
