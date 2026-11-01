const SyntaxPaintRetries = require("../src/syntax-paint-retries");
const Point = require("../src/point");

describe("Syntax paint retries with renderer timers", () => {
  let retries;
  const stamp = { revision: 1, generation: 0, presentation: 0 };
  const tile = {
    start: new Point(0, 0),
    end: new Point(10, 0),
    quality: "limited",
    reason: "timeout",
  };

  beforeEach(() => jasmine.useRealClock());
  afterEach(() => retries?.clear());

  it("wakes a timed-out paint request using the native renderer timer", async () => {
    const ready = jasmine.createSpy("ready");
    retries = new SyntaxPaintRetries({
      ready,
      wanted: () => true,
      now: () => 0,
      delays: [0],
    });

    retries.observe(tile, stamp);
    await conditionPromise(() => ready.calls.count() === 1);
    expect(retries.next()).not.toBeNull();
    expect(retries.timer).toBeNull();
  });

  it("reschedules and clears pending retries using native renderer cancellation", async () => {
    const ready = jasmine.createSpy("ready");
    const fired = jasmine.createSpy("fired");
    retries = new SyntaxPaintRetries({
      ready,
      wanted: () => true,
      now: () => 0,
      delays: [0],
      // Exercise default cancellation independently of default scheduling.
      schedule: (callback, delay) =>
        setTimeout(() => {
          fired();
          callback();
        }, delay),
    });

    retries.observe(tile, stamp);
    retries.update();
    retries.clear();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(retries.timer).toBeNull();
    expect(retries.next()).toBeNull();
  });
});
