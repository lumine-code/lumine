// The waiting primitives every spec suite in the ecosystem shares.
//
// These are installed as globals (see the bottom of this file) the same way
// `advanceClock` and `jasmine.attachToDOM` are, so a package spec uses them
// without requiring anything: a package checkout cannot resolve a path inside
// the editor's own `spec/` directory, which is why every package used to
// vendor its own copy of this file and why the newer ones each hand-rolled a
// waiter at the top of every spec.
//
// Picking one:
//
//   flushMicrotasks()  the thing you are waiting on is a promise chain with no
//                      timer in it. Cheapest, and it cannot hang.
//   waitForFrames()    the thing you are waiting on needs a paint — an etch
//                      update, a DOM measurement, a scroll.
//   conditionPromise() the thing you are waiting on is real I/O: a subprocess,
//                      a file watcher, a network round trip. Polls on the real
//                      clock, so the spec must call `jasmine.useRealClock()`
//                      first if the code under test also waits on a timer.
//
// The runner freezes time for every spec (`jasmine-time.js` spies
// `window.setTimeout` and `Date.now` in a global `beforeEach`), so both of the
// bindings this file needs are captured here, at load time, before any spy is
// installed. Reading them off `window` at call time would hand back the fake
// clock and hang.
const realGlobal = typeof window !== "undefined" ? window : global;
const realSetTimeout = realGlobal.setTimeout.bind(realGlobal);
const realClearTimeout = realGlobal.clearTimeout.bind(realGlobal);

// `Date.now` is spied too, and frozen at 0 until something calls
// `advanceClock`. Elapsed time has to come from a clock the harness does not
// fake, or every timeout below silently becomes infinite.
const now = () => performance.now();

// Filesystem-watcher and other event-driven conditions are markedly slower to
// settle on loaded CI runners (especially Windows), so allow more headroom there.
const DEFAULT_CONDITION_TIMEOUT = process.env.CI ? 30000 : 5000;

function timeoutPromise(timeout) {
  return new Promise((resolve) => {
    realSetTimeout(resolve, timeout);
  });
}

// Polls `condition` on the real clock. `condition` may be sync or async.
async function conditionPromise(
  condition,
  description = "anonymous condition",
  timeout = DEFAULT_CONDITION_TIMEOUT,
) {
  const startTime = now();

  // Checked before the first sleep on purpose: a condition that is already
  // satisfied must not cost a poll interval, and some are only briefly true —
  // an async round trip landing during that first sleep can undo them.
  while (true) {
    if (await condition()) {
      return;
    }

    if (now() - startTime > timeout) {
      throw new Error(`Timed out waiting on ${description}`);
    }

    await timeoutPromise(100);
  }
}

// Yields the microtask queue `count` times, letting promise chains that contain
// no timer run to completion. Safe under the fake clock, and it can never hang.
async function flushMicrotasks(count = 40) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

// Polls `condition` once per animation frame, up to `frames` times, for the
// rendering cases where a microtask flush is not enough because the browser has
// to paint in between. `requestAnimationFrame` is not faked by the harness.
//
// Budget in frames rather than milliseconds on purpose: an unfocused or
// offscreen renderer throttles animation frames hard (a headless CI host can
// drop to roughly one a second), so a wall-clock budget that is generous on a
// developer's machine is far too tight there.
function waitForFrames(condition, { frames = 600, description = "anonymous condition" } = {}) {
  if (typeof requestAnimationFrame !== "function") {
    return Promise.reject(
      new Error("waitForFrames is only available in the renderer; use conditionPromise instead"),
    );
  }

  return new Promise((resolve, reject) => {
    let remaining = frames;

    const check = async () => {
      let satisfied;
      try {
        satisfied = await condition();
      } catch (error) {
        reject(error);
        return;
      }

      if (satisfied) {
        resolve();
      } else if (--remaining > 0) {
        requestAnimationFrame(check);
      } else {
        reject(new Error(`Timed out waiting on ${description} after ${frames} frames`));
      }
    };

    requestAnimationFrame(check);
  });
}

// Resolves when `emitter` next emits `event`. Rejects on the real clock, so a
// missed event fails with this message rather than hanging until Jasmine's own
// timeout reports an anonymous one.
function emitterEventPromise(emitter, event, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = realSetTimeout(() => {
      reject(new Error(`Timed out waiting for '${event}' event`));
    }, timeout);
    emitter.once(event, (...args) => {
      realClearTimeout(timeoutHandle);
      resolve(...args);
    });
  });
}

// The main-process suite runs in Node with no `window`, and requires this file
// directly; the renderer suite reads these off the global instead.
exports.conditionPromise = conditionPromise;
exports.emitterEventPromise = emitterEventPromise;
exports.flushMicrotasks = flushMicrotasks;
exports.timeoutPromise = timeoutPromise;
exports.waitForFrames = waitForFrames;

for (const target of new Set([realGlobal, global])) {
  target.conditionPromise = conditionPromise;
  target.emitterEventPromise = emitterEventPromise;
  target.flushMicrotasks = flushMicrotasks;
  target.timeoutPromise = timeoutPromise;
  target.waitForFrames = waitForFrames;
}
