const ActivationHooks = require("../src/activation-hooks");

describe("ActivationHooks", () => {
  let hooks;

  beforeEach(() => {
    hooks = new ActivationHooks();
  });

  it("runs a hook once and reuses its readiness promise", async () => {
    const callback = jasmine.createSpy("callback").and.returnValue(Promise.resolve());
    const first = hooks.trigger("core:ready", { value: 1 });
    const second = hooks.trigger("core:ready", { value: 2 });

    expect(second).toBe(first);
    await first;
    expect(callback).not.toHaveBeenCalled();

    hooks.on("core:ready", callback);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnceWith({ value: 1 });
  });

  it("replays a late listener on a microtask", async () => {
    hooks.trigger("core:ready");
    const callback = jasmine.createSpy("callback");
    const subscription = hooks.on("core:ready", callback);

    expect(callback).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
    subscription.dispose();
  });

  it("does not replay after disposal", async () => {
    hooks.trigger("core:ready");
    const callback = jasmine.createSpy("callback");
    const subscription = hooks.on("core:ready", callback);
    subscription.dispose();

    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
  });

  it("shares when() with trigger() and retains the first payload", async () => {
    const waiting = hooks.when("core:ready");
    const trigger = hooks.trigger("core:ready", { value: 1 });
    expect(hooks.trigger("core:ready", { value: 2 })).toBe(trigger);
    await expectAsync(waiting).toBeResolvedTo({ value: 1 });
    expect(hooks.value("core:ready")).toEqual({ value: 1 });
    expect(hooks.hasOccurred("core:ready")).toBe(true);
  });

  it("waits for asynchronous listeners", async () => {
    let release;
    hooks.on("core:ready", () => new Promise((resolve) => (release = resolve)));
    const readiness = hooks.trigger("core:ready");
    let settled = false;
    readiness.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await readiness;
    expect(settled).toBe(true);
  });

  it("rejects pending readiness when cleared", async () => {
    const waiting = hooks.when("core:ready");
    hooks.clear();
    await expectAsync(waiting).toBeRejectedWithError("Activation hooks were cleared");
    expect(hooks.hasOccurred("core:ready")).toBe(false);
  });

  it("rejects an already-triggered hook whose listener is still pending", async () => {
    let release;
    hooks.on("core:ready", () => new Promise((resolve) => (release = resolve)));
    const readiness = hooks.trigger("core:ready");
    hooks.clear();
    await expectAsync(readiness).toBeRejectedWithError("Activation hooks were cleared");
    release();
  });

  it("validates names and callbacks", () => {
    expect(() => hooks.on("", () => {})).toThrowError(TypeError);
    expect(() => hooks.trigger(" ")).toThrowError(TypeError);
    expect(() => hooks.on("core:ready", null)).toThrowError(TypeError);
  });
});
