const GitBlobCache = require("../src/git-blob-cache");

describe("GitBlobCache", () => {
  const blob = (text) => ({ type: "blob", content: Buffer.from(text) });

  it("evicts least-recently-used blobs by byte budget", () => {
    const cache = new GitBlobCache({ maxBytes: 6, maxEntries: 10 });
    cache.set("a", blob("aaa"));
    cache.set("b", blob("bb"));
    expect(cache.get("a").content.toString()).toBe("aaa");

    cache.set("c", blob("cc"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a").content.toString()).toBe("aaa");
    expect(cache.get("c").content.toString()).toBe("cc");
    expect(cache.bytes).toBe(5);
  });

  it("does not retain one blob larger than the cache budget", () => {
    const cache = new GitBlobCache({ maxBytes: 2 });
    const value = blob("oversized");
    expect(cache.set("large", value)).toBe(value);
    expect(cache.get("large")).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it("coalesces concurrent loads and never caches failures", async () => {
    const cache = new GitBlobCache();
    const load = jasmine.createSpy("load").and.callFake(async () => blob("shared"));
    const [first, second] = await Promise.all([
      cache.getOrLoad("same", load),
      cache.getOrLoad("same", load),
    ]);
    expect(first).toBe(second);
    expect(load.calls.count()).toBe(1);

    const failure = new Error("read failed");
    await expectAsync(cache.getOrLoad("failed", () => Promise.reject(failure))).toBeRejectedWith(
      failure,
    );
    expect(await cache.getOrLoad("failed", async () => blob("retry"))).toEqual(blob("retry"));
  });

  it("keeps shared work alive for independent waiters and isolates their aborts", async () => {
    const cache = new GitBlobCache();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let resolveLoad;
    let sharedSignal;
    const load = ({ signal }) => {
      sharedSignal = signal;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    };
    const first = cache.getOrLoad("shared", load, { signal: firstController.signal });
    const second = cache.getOrLoad("shared", load, { signal: secondController.signal });
    await Promise.resolve();

    firstController.abort();
    await expectAsync(first).toBeRejectedWithError(/aborted/);
    expect(sharedSignal.aborted).toBe(false);
    resolveLoad(blob("value"));
    expect((await second).content.toString()).toBe("value");
    expect(cache.get("shared").content.toString()).toBe("value");
  });

  it("does not repopulate the cache from a load cleared in flight", async () => {
    const cache = new GitBlobCache();
    let resolveLoad;
    let sharedSignal;
    const pending = cache.getOrLoad("stale", ({ signal }) => {
      sharedSignal = signal;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    });
    await Promise.resolve();

    cache.clear();
    expect(sharedSignal.aborted).toBe(true);
    resolveLoad(blob("stale"));
    await pending;
    expect(cache.get("stale")).toBeUndefined();
  });

  it("does not let an old cleared flight remove a newer load of the same key", async () => {
    const cache = new GitBlobCache();
    let resolveOld;
    const old = cache.getOrLoad(
      "same",
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await Promise.resolve();
    cache.clear();

    const fresh = await cache.getOrLoad("same", async () => blob("fresh"));
    expect(fresh.content.toString()).toBe("fresh");
    resolveOld(blob("old"));
    await old;
    expect(cache.get("same").content.toString()).toBe("fresh");
  });
});
