const URIHandlerRegistry = require("../src/uri-handler-registry");

// The object shape handlers receive is public API: it must stay compatible
// with the output of Node's legacy `url.parse(uri, true)`.
function parsedUri(host, pathname, href) {
  return {
    protocol: "lumine:",
    slashes: true,
    auth: null,
    host,
    port: null,
    hostname: host,
    hash: null,
    search: null,
    // Like legacy `url.parse(uri, true)`, `query` has a null prototype.
    query: Object.create(null),
    pathname,
    path: pathname,
    href,
  };
}

describe("URIHandlerRegistry", () => {
  let registry;

  beforeEach(() => {
    registry = new URIHandlerRegistry(5);
  });

  it("handles URIs on a per-host basis", async () => {
    const testPackageSpy = jasmine.createSpy();
    const otherPackageSpy = jasmine.createSpy();
    registry.registerHostHandler("test-package", testPackageSpy);
    registry.registerHostHandler("other-package", otherPackageSpy);

    await registry.handleURI("lumine://yet-another-package/path");
    expect(testPackageSpy).not.toHaveBeenCalled();
    expect(otherPackageSpy).not.toHaveBeenCalled();

    await registry.handleURI("lumine://test-package/path");
    expect(testPackageSpy).toHaveBeenCalledWith(
      parsedUri("test-package", "/path", "lumine://test-package/path"),
      "lumine://test-package/path",
    );
    expect(otherPackageSpy).not.toHaveBeenCalled();

    await registry.handleURI("lumine://other-package/path");
    expect(otherPackageSpy).toHaveBeenCalledWith(
      parsedUri("other-package", "/path", "lumine://other-package/path"),
      "lumine://other-package/path",
    );
  });

  it("keeps track of the most recent URIs", async () => {
    const spy1 = jasmine.createSpy();
    const spy2 = jasmine.createSpy();
    const changeSpy = jasmine.createSpy();
    registry.registerHostHandler("one", spy1);
    registry.registerHostHandler("two", spy2);
    registry.onHistoryChange(changeSpy);

    const uris = [
      "lumine://one/something?asdf=1",
      "lumine://fake/nothing",
      "lumine://two/other/stuff",
      "lumine://one/more/thing",
      "lumine://two/more/stuff",
    ];

    for (const u of uris) {
      await registry.handleURI(u);
    }

    expect(changeSpy.calls.count()).toBe(5);
    expect(registry.getRecentlyHandledURIs()).toEqual(
      uris
        .map((u, idx) => {
          return {
            id: idx + 1,
            uri: u,
            handled: !u.match(/fake/),
            host: new URL(u).host,
          };
        })
        .reverse(),
    );

    await registry.handleURI("lumine://another/url");
    expect(changeSpy.calls.count()).toBe(6);
    const history = registry.getRecentlyHandledURIs();
    expect(history.length).toBe(5);
    expect(history[0].uri).toBe("lumine://another/url");
    expect(history[4].uri).toBe(uris[1]);
  });

  it("restores its history from serialized state", async () => {
    registry.registerHostHandler("one", jasmine.createSpy());
    await registry.handleURI("lumine://one/first");
    await registry.handleURI("lumine://fake/second");

    const restored = new URIHandlerRegistry(5);
    restored.deserialize(JSON.parse(JSON.stringify(registry.serialize())));
    expect(restored.getRecentlyHandledURIs()).toEqual(registry.getRecentlyHandledURIs());

    // Ids keep climbing past the restored entries, so the settings panel never
    // renders two rows sharing a key.
    await restored.handleURI("lumine://one/third");
    const ids = restored.getRecentlyHandledURIs().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBeGreaterThan(ids[1]);
  });

  it("keeps the restored history within the maximum length", async () => {
    for (const uri of ["one", "two", "three", "four", "five", "six"]) {
      await registry.handleURI(`lumine://host/${uri}`);
    }

    const restored = new URIHandlerRegistry(3);
    restored.deserialize(registry.serialize());
    expect(restored.getRecentlyHandledURIs().length).toBe(3);
    expect(restored.getRecentlyHandledURIs()[0].uri).toBe("lumine://host/six");
  });

  it("ignores serialized state it cannot read", async () => {
    await registry.handleURI("lumine://host/something");

    const current = registry.serialize();
    const fromAnotherVersion = { ...current, version: current.version + 1 };
    const withoutHistory = { ...current, history: undefined };

    for (const state of [undefined, null, {}, fromAnotherVersion, withoutHistory]) {
      const restored = new URIHandlerRegistry(5);
      restored.deserialize(state);
      expect(restored.getRecentlyHandledURIs()).toEqual([]);
    }
  });

  it("refuses to handle bad URLs", async () => {
    const invalidUris = [
      "atom:package/path",
      "atom:8080://package/path",
      "user:pass@lumine://package/path",
      "smth://package/path",
    ];

    let numErrors = 0;
    for (const uri of invalidUris) {
      try {
        await registry.handleURI(uri);
        expect(uri).toBe("throwing an error");
      } catch {
        numErrors++;
      }
    }

    expect(numErrors).toBe(invalidUris.length);
  });
});
