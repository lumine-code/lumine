const {
  conditionPromise,
  emitterEventPromise,
  flushMicrotasks,
  timeoutPromise,
  waitForFrames,
} = require("./helpers/async-spec-helpers");
const { Emitter } = require("@lumine-code/event-kit");

// A spec file is required before `jasmineEnv.execute()`, so module scope is the
// one place the real timer can still be read: the fake clock is installed in a
// `beforeEach`, once specs are already running. This is the same trick the
// helpers themselves use, and the reason they can be trusted under a frozen
// clock.
const realSetTimeout = window.setTimeout.bind(window);

// Every spec in the ecosystem waits through one of these, and all of them run
// under the fake clock the runner installs in a global `beforeEach`. That is
// the property worth pinning: a waiter that reads `Date.now()` or `setTimeout`
// off the frozen clock either hangs forever or gives up instantly, and both
// failures are silent — the spec that depended on it just goes red somewhere
// else, or dies with an anonymous Jasmine timeout.
describe("spec/helpers/async-spec-helpers", () => {
  it("installs every waiter as a global", () => {
    expect(window.conditionPromise).toBe(conditionPromise);
    expect(window.emitterEventPromise).toBe(emitterEventPromise);
    expect(window.flushMicrotasks).toBe(flushMicrotasks);
    expect(window.timeoutPromise).toBe(timeoutPromise);
    expect(window.waitForFrames).toBe(waitForFrames);
  });

  it("waits on a real timer the frozen clock cannot reach", async () => {
    // `window.setTimeout` is spied by now. If `timeoutPromise` scheduled
    // through the spy, nothing here would ever advance the clock and this
    // would hang until the spec timeout.
    expect(window.setTimeout).not.toBe(realSetTimeout);
    await timeoutPromise(1);
  });

  describe("flushMicrotasks", () => {
    it("lets a promise chain run to completion", async () => {
      const order = [];
      Promise.resolve()
        .then(() => order.push("a"))
        .then(() => order.push("b"))
        .then(() => order.push("c"));

      expect(order).toEqual([]);
      await flushMicrotasks();
      expect(order).toEqual(["a", "b", "c"]);
    });

    it("yields many more turns than a bare await", async () => {
      let ticks = 0;
      const tick = () => {
        if (++ticks < 50) Promise.resolve().then(tick);
      };
      Promise.resolve().then(tick);

      await Promise.resolve();
      expect(ticks).toBeLessThan(50);

      await flushMicrotasks(60);
      expect(ticks).toBe(50);
    });
  });

  describe("conditionPromise", () => {
    // The property git-diff depends on: a condition that is true now and false
    // again a moment later must still be seen.
    it("checks before it sleeps", async () => {
      let checks = 0;
      await conditionPromise(() => ++checks === 1, "a condition true only at first");
      expect(checks).toBe(1);
    });

    it("resolves once a synchronous condition holds", async () => {
      let satisfied = false;
      realSetTimeout(() => (satisfied = true), 20);

      await conditionPromise(() => satisfied, "the flag to be set", 2000);
      expect(satisfied).toBe(true);
    });

    it("resolves once an asynchronous condition holds", async () => {
      let satisfied = false;
      realSetTimeout(() => (satisfied = true), 20);

      await conditionPromise(async () => satisfied, "the flag to be set", 2000);
      expect(satisfied).toBe(true);
    });

    // The regression this file exists for. `Date.now()` is spied and frozen, so
    // an elapsed-time check written against it never fires: a condition that
    // will never hold used to spin until Jasmine's own timeout killed the spec,
    // reporting a timeout that named neither the helper nor the condition.
    it("gives up on the real clock even though Date.now is frozen", async () => {
      const frozenAt = Date.now();

      await expectAsync(
        conditionPromise(() => false, "something impossible", 150),
      ).toBeRejectedWithError(/Timed out waiting on something impossible/);

      // Still frozen: the helper must not have advanced the clock to escape.
      expect(Date.now()).toBe(frozenAt);
    });

    it("propagates an error thrown by the condition", async () => {
      await expectAsync(
        conditionPromise(() => {
          throw new Error("condition exploded");
        }),
      ).toBeRejectedWithError(/condition exploded/);
    });
  });

  describe("waitForFrames", () => {
    // Deliberately few frames: an unfocused renderer throttles them to about
    // one a second, and the local spec timeout is five.
    it("resolves once the condition holds", async () => {
      let framesSeen = 0;

      await waitForFrames(() => ++framesSeen >= 2, { frames: 60 });
      expect(framesSeen).toBe(2);
    });

    it("gives up after the frame budget", async () => {
      await expectAsync(
        waitForFrames(() => false, { frames: 2, description: "something impossible" }),
      ).toBeRejectedWithError(/Timed out waiting on something impossible after 2 frames/);
    });

    it("propagates an error thrown by the condition", async () => {
      await expectAsync(
        waitForFrames(() => {
          throw new Error("condition exploded");
        }),
      ).toBeRejectedWithError(/condition exploded/);
    });
  });

  describe("emitterEventPromise", () => {
    it("resolves when the event is emitted", async () => {
      const emitter = new Emitter();
      realSetTimeout(() => emitter.emit("did-thing"), 10);

      await emitterEventPromise(emitter, "did-thing");
    });

    // The same defect as conditionPromise's, arriving by a different route:
    // this used to arm its timeout through the faked `setTimeout`, so a missed
    // event hung instead of reporting which event never arrived.
    it("gives up on the real clock when the event never arrives", async () => {
      const emitter = new Emitter();

      await expectAsync(emitterEventPromise(emitter, "never", 100)).toBeRejectedWithError(
        /Timed out waiting for 'never' event/,
      );
    });
  });
});
