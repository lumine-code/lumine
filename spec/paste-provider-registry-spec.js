const PasteProviderRegistry = require("../src/paste-provider-registry");

describe("PasteProviderRegistry", () => {
  let registry;

  beforeEach(() => {
    registry = new PasteProviderRegistry();
  });

  it("offers a paste to providers in priority order until one claims it", () => {
    const calls = [];
    registry.add({ handlePaste: () => calls.push("low") && true }, { priority: 1 });
    registry.add({ handlePaste: () => calls.push("high") && false }, { priority: 10 });
    registry.add({ handlePaste: () => calls.push("unused") && true });

    expect(registry.handlePaste({ target: { type: "text-editor" } })).toBe(true);
    expect(calls).toEqual(["high", "low"]);
  });

  it("falls through when no provider claims the paste", () => {
    registry.add({ handlePaste: () => false });
    expect(registry.handlePaste({ target: { type: "directory" } })).toBe(false);
  });

  it("awaits an asynchronous provider before offering the paste to the next one", async () => {
    const calls = [];
    registry.add({ handlePaste: async () => calls.push("first") && false });
    registry.add({ handlePaste: async () => calls.push("second") && true });
    registry.add({ handlePaste: () => calls.push("unused") && true });

    expect(await registry.handlePaste({ target: { type: "terminal" } })).toBe(true);
    expect(calls).toEqual(["first", "second"]);
  });

  it("returns a disposable that unregisters the provider", () => {
    const provider = { handlePaste: jasmine.createSpy("handlePaste").and.returnValue(true) };
    const registration = registry.add(provider);
    registration.dispose();

    expect(registry.handlePaste({})).toBe(false);
    expect(provider.handlePaste).not.toHaveBeenCalled();
  });

  it("continues to the next provider when the current provider unregisters itself", () => {
    const calls = [];
    const first = registry.add({
      handlePaste() {
        calls.push("first");
        first.dispose();
        return false;
      },
    });
    registry.add({ handlePaste: () => calls.push("second") && true });

    expect(registry.handlePaste({})).toBe(true);
    expect(calls).toEqual(["first", "second"]);
  });

  it("continues after an asynchronous provider is unregistered while deciding", async () => {
    let resolveFirst;
    const first = registry.add({
      handlePaste: () => new Promise((resolve) => (resolveFirst = resolve)),
    });
    const second = jasmine.createSpy("second").and.returnValue(true);
    registry.add({ handlePaste: second });

    const result = registry.handlePaste({});
    first.dispose();
    resolveFirst(false);

    expect(await result).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("skips removed providers and defers new registrations to the next paste", () => {
    const calls = [];
    let added = false;
    registry.add({
      handlePaste() {
        calls.push("first");
        removed.dispose();
        if (!added) {
          added = true;
          registry.add({ handlePaste: () => calls.push("new") && true }, { priority: 10 });
        }
        return false;
      },
    });
    const removed = registry.add({ handlePaste: () => calls.push("removed") && true });
    registry.add({ handlePaste: () => calls.push("last") && false });

    expect(registry.handlePaste({})).toBe(false);
    expect(calls).toEqual(["first", "last"]);
    expect(registry.handlePaste({})).toBe(true);
    expect(calls).toEqual(["first", "last", "new"]);
  });

  it("stops offering an in-flight paste after the registry is cleared", async () => {
    let resolveFirst;
    registry.add({ handlePaste: () => new Promise((resolve) => (resolveFirst = resolve)) });
    const second = jasmine.createSpy("second").and.returnValue(true);
    registry.add({ handlePaste: second });

    const result = registry.handlePaste({});
    registry.clear();
    resolveFirst(false);

    expect(await result).toBe(false);
    expect(second).not.toHaveBeenCalled();
  });
});
