const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const windowZoom = require("../../src/window-zoom");

function contents(factor = 1) {
  return Object.assign(new EventEmitter(), {
    factor,
    setVisualZoomLevelLimits(minimum, maximum) {
      this.visualZoomLimits = [minimum, maximum];
      return Promise.resolve();
    },
    getZoomFactor() {
      return this.factor;
    },
    setZoomFactor(value) {
      this.factor = value;
    },
  });
}

test("zoom changes report only the effective factor of the affected window", () => {
  const first = contents();
  const second = contents();
  const firstChanges = [];
  const secondChanges = [];
  first.on("lumine-did-change-zoom-factor", (factor) => firstChanges.push(factor));
  second.on("lumine-did-change-zoom-factor", (factor) => secondChanges.push(factor));
  windowZoom.zoomIn(first);
  windowZoom.resetZoom(first, 1.25);
  windowZoom.resetZoom(first, 1.25);
  windowZoom.setZoomFactor(first, 5);
  windowZoom.zoomIn(first);
  windowZoom.setZoomFactor(second, 0.25);
  windowZoom.zoomOut(second);
  assert.deepEqual(firstChanges, [1.05, 1.25, 5]);
  assert.deepEqual(secondChanges, [0.25]);
});

test("zoom notifications reflect the applied native factor rather than the requested factor", () => {
  const target = contents();
  const changes = [];
  target.setZoomFactor = function () {
    this.factor = 1.2000000000000002;
  };
  target.on("lumine-did-change-zoom-factor", (factor) => changes.push(factor));
  assert.equal(windowZoom.setZoomFactor(target, 1.23), 1.2);
  assert.equal(windowZoom.setZoomFactor(target, 1.23), 1.2);
  assert.deepEqual(changes, [1.2]);
});

test("window zoom uses five percentage point scale steps", () => {
  const target = contents();
  assert.equal(windowZoom.zoomIn(target), 1.05);
  assert.equal(windowZoom.zoomIn(target), 1.1);
  assert.equal(windowZoom.zoomOut(target), 1.05);
  assert.equal(windowZoom.zoomOut(target), 1);
  assert.equal(windowZoom.zoomOut(target), 0.95);
});

test("window zoom preserves a default between the normal scale steps", () => {
  const target = contents(1.23);
  assert.equal(windowZoom.zoomIn(target), 1.28);
  assert.equal(windowZoom.zoomOut(target), 1.23);
});

test("repeated opposite scale steps return to the original scale", () => {
  const target = contents(1.23);
  for (let index = 0; index < 100; index++) {
    windowZoom.zoomIn(target);
    windowZoom.zoomOut(target);
  }
  assert.equal(windowZoom.getZoomFactor(target), 1.23);
});

test("window zoom remains within twenty-five and five hundred percent", () => {
  const target = contents(0.3);
  assert.equal(windowZoom.zoomOut(target), 0.25);
  assert.equal(windowZoom.zoomOut(target), 0.25);
  windowZoom.setZoomFactor(target, 4.95);
  assert.equal(windowZoom.zoomIn(target), 5);
  assert.equal(windowZoom.zoomIn(target), 5);
});

test("reset restores only the current window to the configured default factor", () => {
  const first = contents(1.7);
  const second = contents(0.8);
  assert.equal(windowZoom.resetZoom(first, 1.25), 1.25);
  assert.equal(windowZoom.getZoomFactor(second), 0.8);
});

test("fresh windows derive their factor from the shared global default", () => {
  let defaultFactor = 1.25;
  const window = {
    lumineApplication: {
      config: {
        get(key) {
          assert.equal(key, "core.zoomFactor");
          return defaultFactor;
        },
      },
    },
  };
  assert.equal(windowZoom.getDefaultZoomFactor(window), 1.25);
  defaultFactor = 0.75;
  assert.equal(windowZoom.getDefaultZoomFactor(window), 0.75);
  window.isSpec = true;
  assert.equal(windowZoom.getDefaultZoomFactor(window), 1);
});

test("zoom state snapshots include the native factor and the main-process default", () => {
  const window = { lumineApplication: { config: { get: () => 1.25 } } };
  const target = contents(1.2000000000000002);
  assert.deepEqual(windowZoom.getZoomState(window, target), { factor: 1.2, defaultFactor: 1.25 });
  window.isSpec = true;
  assert.deepEqual(windowZoom.getZoomState(window, target), { factor: 1.2, defaultFactor: 1 });
});

test("reported scale factors can be saved directly without native floating point noise", () => {
  const target = contents(1.2000000000000002);
  assert.equal(windowZoom.getZoomFactor(target), 1.2);
});

test("blocking pinch zoom preserves the window's page scale", async () => {
  const target = contents(1.4);
  await windowZoom.disableVisualZoom(target);
  assert.deepEqual(target.visualZoomLimits, [1, 1]);
  assert.equal(windowZoom.getZoomFactor(target), 1.4);
});

test("blocking pinch zoom retires a pending request when its frame is disposed", async () => {
  const target = contents();
  let reject;
  const frame = { isDestroyed: () => false };
  target.mainFrame = frame;
  target.isDestroyed = () => false;
  target.setVisualZoomLevelLimits = () =>
    new Promise((_resolve, rejectRequest) => {
      reject = rejectRequest;
    });

  const pending = windowZoom.disableVisualZoom(target);
  frame.isDestroyed = () => true;
  target.mainFrame = { isDestroyed: () => false };
  reject(new Error("Render frame was disposed before the request completed"));

  await assert.doesNotReject(pending);
});

test("blocking pinch zoom ignores destroyed contents without reading its frame", async () => {
  const target = contents();
  target.isDestroyed = () => true;
  Object.defineProperty(target, "mainFrame", {
    get() {
      throw new Error("Destroyed WebContents must not be accessed");
    },
  });

  await assert.doesNotReject(windowZoom.disableVisualZoom(target));
  assert.equal(target.visualZoomLimits, undefined);
});

test("blocking pinch zoom preserves failures for a live frame, including detached wrappers", async () => {
  const target = contents();
  const error = new Error("Unable to set visual zoom limits");
  target.mainFrame = { isDestroyed: () => false, detached: true };
  target.isDestroyed = () => false;
  target.setVisualZoomLevelLimits = () => Promise.reject(error);

  await assert.rejects(windowZoom.disableVisualZoom(target), (actual) => actual === error);
});
