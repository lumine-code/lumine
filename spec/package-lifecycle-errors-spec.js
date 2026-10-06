const {
  appendLifecycleError,
  awaitLifecycleCleanup,
  captureLifecycleError,
  combineLifecycleErrors,
  throwLifecycleErrors,
} = require("../src/package-lifecycle-errors");

describe("package lifecycle cleanup errors", () => {
  it("retains the exact frozen primary error when cleanup succeeds", async () => {
    const primary = Object.freeze(new Error("Initialization failed"));
    const failures = [];
    appendLifecycleError(failures, primary);
    await awaitLifecycleCleanup(failures, () => Promise.resolve());
    let failure;
    try {
      throwLifecycleErrors(failures, "Lifecycle failed");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(primary);
  });

  it("flattens its own nested cleanup collections and keeps the primary as cause", async () => {
    const primary = new Error("Activation failed");
    const synchronous = new Error("Resource cleanup failed");
    const asynchronous = new Error("Main cleanup failed");
    const inner = [];
    appendLifecycleError(inner, primary);
    captureLifecycleError(inner, () => {
      throw synchronous;
    });
    const failures = [];
    appendLifecycleError(failures, combineLifecycleErrors(inner, "Inner lifecycle failed"));
    await awaitLifecycleCleanup(failures, () => Promise.reject(asynchronous));
    const failure = combineLifecycleErrors(failures, "Lifecycle failed");
    expect(failure.errors).toEqual([primary, synchronous, asynchronous]);
    expect(failure.cause).toBe(primary);
  });

  it("preserves a package-owned AggregateError rather than treating it as its own collection", () => {
    const primary = new AggregateError([new Error("Feature failed")], "Package activation failed");
    const cleanup = new Error("Subscription cleanup failed");
    const failures = [];
    appendLifecycleError(failures, primary);
    appendLifecycleError(failures, cleanup);
    const failure = combineLifecycleErrors(failures, "Lifecycle failed");
    expect(failure.errors).toEqual([primary, cleanup]);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.cause).toBe(primary);
  });
});
