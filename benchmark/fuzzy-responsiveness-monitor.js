"use strict";

const timers = require("node:timers");

function handleType(handle) {
  return {
    type: typeof handle,
    constructor: handle?.constructor?.name ?? null,
  };
}

function nativeFunction(fn) {
  return /\[native code\]/.test(Function.prototype.toString.call(fn));
}

// Diagnostic tooling only. The legacy operation-local maximum is retained for
// comparison; a final unobserved timer tail is never labelled as CPU time.
module.exports = async function createMonitor() {
  const document = globalThis.document;
  const window = document?.defaultView;
  if (!window) throw new Error("The responsiveness monitor requires a renderer document");
  const performance = globalThis.performance;
  const legacySetInterval = globalThis.setInterval.bind(globalThis);
  const legacyClearInterval = globalThis.clearInterval.bind(globalThis);
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  // Keep the native timer provider in the viewport and attached. display:none
  // or an offscreen provider would introduce another throttling variable.
  iframe.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";

  try {
    await new Promise((resolve, reject) => {
      const timeout = timers.setTimeout(() => done(new Error("Timer iframe did not load")), 2000);
      const loaded = () => done();
      const failed = () => done(new Error("Timer iframe failed to load"));
      function done(error) {
        timers.clearTimeout(timeout);
        iframe.removeEventListener("load", loaded);
        iframe.removeEventListener("error", failed);
        if (error) reject(error);
        else resolve();
      }
      iframe.addEventListener("load", loaded);
      iframe.addEventListener("error", failed);
      iframe.src = "about:blank";
      (document.body ?? document.documentElement).appendChild(iframe);
    });
  } catch (error) {
    iframe.remove();
    throw error;
  }

  const browserWindow = iframe.contentWindow;
  const browserSetInterval = browserWindow.setInterval;
  const browserClearInterval = browserWindow.clearInterval;
  const measurements = [];
  const nodeTicks = [];
  const browserTicks = [];
  const frames = [];
  const longTasks = [];
  const legacyHandles = new Set();
  const clock = {
    timeOrigin: performance.timeOrigin,
    windowTimeOrigin: window.performance.timeOrigin,
    startedAt: performance.now(),
    visibility: document.visibilityState,
    iframeVisibility: browserWindow.document.visibilityState,
    sameWindowPerformance: performance === window.performance,
    longTasksSupported: false,
  };
  const timerTypes = {
    globalSameAsNode: globalThis.setInterval === timers.setInterval,
    globalSameAsWindow: globalThis.setInterval === window.setInterval,
    globalNativeFunction: nativeFunction(globalThis.setInterval),
    browserNativeFunction: nativeFunction(browserSetInterval),
  };
  let browserTarget = window;
  let browserHandle;
  let nodeHandle;
  let frameHandle;
  let observer;
  let stopped = false;
  let finishPromise;

  const collectLongTasks = (entries) => {
    const originOffset = window.performance.timeOrigin - performance.timeOrigin;
    for (const entry of entries) longTasks.push([entry.startTime + originOffset, entry.duration]);
  };
  const cleanup = () => {
    stopped = true;
    if (nodeHandle !== undefined) timers.clearInterval(nodeHandle);
    if (browserHandle !== undefined) browserClearInterval.call(browserTarget, browserHandle);
    if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle);
    for (const handle of legacyHandles) legacyClearInterval(handle);
    legacyHandles.clear();
    if (observer) {
      collectLongTasks(observer.takeRecords());
      observer.disconnect();
    }
    iframe.remove();
  };

  try {
    const tick = () => browserTicks.push(performance.now());
    try {
      // Call the pristine cross-realm browser implementation on the visible
      // main Window, even when that Window's own property is a Node timer.
      browserHandle = browserSetInterval.call(browserTarget, tick, 4);
    } catch {
      browserTarget = browserWindow;
      browserHandle = browserSetInterval.call(browserTarget, tick, 4);
    }
    timerTypes.browser = {
      ...handleType(browserHandle),
      target: browserTarget === window ? "main-window" : "iframe-window",
    };
    if (typeof browserHandle !== "number")
      throw new Error("The iframe did not provide a genuine numeric-handle browser timer");
    nodeHandle = timers.setInterval(() => nodeTicks.push(performance.now()), 4);
    timerTypes.node = handleType(nodeHandle);
    const frame = () => {
      if (stopped) return;
      frames.push(performance.now());
      frameHandle = window.requestAnimationFrame(frame);
    };
    frameHandle = window.requestAnimationFrame(frame);
    const Observer = window.PerformanceObserver;
    if (Observer?.supportedEntryTypes?.includes("longtask")) {
      observer = new Observer((list) => collectLongTasks(list.getEntries()));
      observer.observe({ type: "longtask" });
      clock.longTasksSupported = true;
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  async function measure(id, action) {
    if (finishPromise || stopped) throw new Error("The responsiveness monitor has finished");
    let lastTick = performance.now();
    let gap = 0;
    const ticks = [];
    const handle = legacySetInterval(() => {
      const now = performance.now();
      ticks.push(now);
      gap = Math.max(gap, now - lastTick);
      lastTick = now;
    }, 4);
    legacyHandles.add(handle);
    timerTypes.legacy = handleType(handle);
    const start = performance.now();
    console.timeStamp?.(`${id}:start`);
    let sync;
    try {
      const pending = action();
      sync = performance.now() - start;
      await pending;
    } finally {
      const end = performance.now();
      sync ??= end - start;
      const tail = performance.now() - lastTick;
      gap = Math.max(gap, tail);
      legacyClearInterval(handle);
      legacyHandles.delete(handle);
      console.timeStamp?.(`${id}:end`);
      measurements.push({
        id,
        start,
        end,
        duration: end - start,
        sync,
        legacy: { ticks, tail, gap },
      });
    }
    return measurements.at(-1);
  }

  function finish() {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      try {
        // Keep continuous probes alive long enough to observe delayed delivery
        // after the final action. A hidden/occluded window must not hang cleanup.
        clock.drain = await new Promise((resolve) => {
          let count = 0;
          let handle;
          let settled = false;
          const timeout = timers.setTimeout(() => done("timeout"), 250);
          function done(reason) {
            if (settled) return;
            settled = true;
            timers.clearTimeout(timeout);
            if (handle !== undefined) window.cancelAnimationFrame(handle);
            resolve({ reason, frames: count, endedAt: performance.now() });
          }
          function next() {
            if (settled) return;
            if (++count === 2) done("frames");
            else handle = window.requestAnimationFrame(next);
          }
          handle = window.requestAnimationFrame(next);
        });
      } finally {
        cleanup();
      }
      clock.finishedAt = performance.now();
      return { measurements, nodeTicks, browserTicks, frames, longTasks, clock, timerTypes };
    })();
    return finishPromise;
  }

  return { measure, finish };
};
