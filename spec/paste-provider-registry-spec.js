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
});
