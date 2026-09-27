const ExternalURIRegistry = require("../src/external-uri-registry");

describe("ExternalURIRegistry", () => {
  let registry;

  beforeEach(() => {
    registry = new ExternalURIRegistry();
  });

  afterEach(() => registry.destroy());

  it("offers a URI to openers by descending priority until one handles it", async () => {
    const calls = [];
    registry.addOpener(
      async (uri, context) => {
        calls.push(["lower", uri, context]);
        return true;
      },
      { priority: 10 },
    );
    registry.addOpener(
      () => {
        calls.push(["higher"]);
        return false;
      },
      { priority: 20 },
    );

    expect(await registry.open("https://example.test", { source: "spec" })).toBe(true);
    expect(calls).toEqual([["higher"], ["lower", "https://example.test", { source: "spec" }]]);
  });

  it("disposes registrations and rejects non-web URIs", async () => {
    const opener = jasmine.createSpy("opener").and.returnValue(true);
    const registration = registry.addOpener(opener);
    expect(registry.hasOpeners()).toBe(true);
    registration.dispose();

    expect(await registry.open("https://example.test")).toBe(false);
    expect(opener).not.toHaveBeenCalled();
    await expectAsync(registry.open("file:///tmp/example")).toBeRejectedWithError(TypeError);
  });
});
