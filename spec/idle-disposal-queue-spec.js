const { IdleDisposalQueue } = require("../src/idle-disposal-queue");

describe("Idle disposal in the renderer", () => {
  it("calls the browser timer with its valid receiver", async () => {
    jasmine.useRealClock();
    const queue = new IdleDisposalQueue({ quietMs: 0 });
    const disposed = [];
    await new Promise((resolve) => {
      queue.add(1, (value) => {
        disposed.push(value);
        resolve();
      });
    });
    expect(disposed).toEqual([1]);
    expect(queue.pending.length).toBe(0);
  });
});
