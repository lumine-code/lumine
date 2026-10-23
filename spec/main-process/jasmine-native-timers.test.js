const assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const { test } = require("node:test");
const timers = require("node:timers");
const Jasmine = require("jasmine");
const formatNodeTimer = require("../helpers/format-node-timer");

test("formats native timers carrying a real async context without reading private fields", async () => {
  const runner = new Jasmine();
  runner.exitOnCompletion = false;
  const { env, jasmine } = runner;
  const failures = [];
  let completed = false;
  let inspectedInternals = 0;
  let result;
  env.configure({ random: false });
  env.addReporter({
    specDone(spec) {
      failures.push(...spec.failedExpectations);
    },
    jasmineDone(value) {
      result = value;
    },
  });
  env.beforeEach(() => env.addCustomObjectFormatter(formatNodeTimer));
  env.it("preserves opaque timer identities in Jasmine assertions and diagnostics", () => {
    const storage = new AsyncLocalStorage();
    const owner = { owner: "syntax" };
    const handles = [];
    try {
      storage.run(owner, () => {
        assert.equal(storage.getStore(), owner);
        handles.push(timers.setTimeout(() => {}, 10000));
        handles.push(timers.setInterval(() => {}, 10000));
        handles.push(timers.setImmediate(() => {}));
      });
      assert.equal(storage.getStore(), undefined);
      for (const handle of handles) {
        Object.defineProperty(handle, Symbol("opaque context"), {
          enumerable: true,
          get() {
            inspectedInternals++;
            throw new Error("Native timer internals must not be inspected");
          },
        });
        env.expect(handle).toBe(handle);
        env.expect(jasmine.pp(handle)).toBe(formatNodeTimer(handle));
      }
      env.expect(handles[0]).not.toBe(handles[1]);
      env.expect(formatNodeTimer(handles[0])).not.toBe(formatNodeTimer(handles[1]));
      env.expect(formatNodeTimer(handles[2])).toMatch(/^Node Immediate #\d+$/);
      env.expect(formatNodeTimer({})).toBeUndefined();
      env.expect(formatNodeTimer(null)).toBeUndefined();
      completed = true;
    } finally {
      timers.clearTimeout(handles[0]);
      timers.clearInterval(handles[1]);
      timers.clearImmediate(handles[2]);
      storage.disable();
    }
  });
  await env.execute();
  assert.equal(result.overallStatus, "passed", JSON.stringify(failures));
  assert.equal(completed, true);
  assert.equal(inspectedInternals, 0);
});
