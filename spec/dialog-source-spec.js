const DialogSource = require("../src/dialog-source");

describe("DialogSource", () => {
  let applied, errors, loading, query, source;

  function deferred() {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function build(sourceDefinition, overrides = {}) {
    source = new DialogSource({
      source: sourceDefinition,
      getQuery: () => query,
      getParsedQuery: (value) => ({ value, length: value.length }),
      apply: (publication) => applied.push(publication),
      setLoading: (value) => loading.push(value),
      setError: (error) => errors.push(error),
      ...overrides,
    });
    return source;
  }

  beforeEach(() => {
    applied = [];
    errors = [];
    loading = [];
    query = "initial";
  });

  afterEach(() => {
    source?.destroy();
    source = null;
  });

  it("validates its hooks and source descriptors", () => {
    expect(() => new DialogSource()).toThrowError(TypeError, /apply callback/);
    expect(() => new DialogSource({ apply: () => {}, getQuery: true })).toThrowError(
      TypeError,
      /getQuery must be a function/,
    );
    expect(() => build([])).toThrowError(TypeError, /object or null/);
    expect(() => build({ mode: "live", load() {} })).toThrowError(TypeError, /source mode/);
    expect(() => build({ mode: "snapshot", load: true })).toThrowError(TypeError, /source load/);
    expect(() => build({ mode: "query", debounceMs: -1, load() {} })).toThrowError(
      RangeError,
      /non-negative finite number/,
    );
  });

  it("loads an initial snapshot immediately with raw and parsed queries", async () => {
    const load = jasmine.createSpy("load").and.returnValue(["one", "two"]);
    build({ mode: "snapshot", load });

    const completion = source.open();

    expect(load).toHaveBeenCalledTimes(1);
    expect(source.isLoading()).toBe(true);
    const request = load.calls.mostRecent().args[0];
    expect(request.query).toBe("initial");
    expect(request.parsedQuery).toEqual({ value: "initial", length: 7 });
    expect(request.signal).toEqual(jasmine.any(AbortSignal));

    await completion;
    expect(applied).toEqual([["one", "two"]]);
    expect(loading).toEqual([true, false]);
    expect(source.isLoading()).toBe(false);
  });

  it("accepts progressive publications followed by a final return value", async () => {
    build({
      mode: "snapshot",
      async load({ publish }) {
        expect(await publish("first")).toBe(true);
        expect(await publish("second")).toBe(true);
        return "final";
      },
    });

    await source.open();

    expect(applied).toEqual(["first", "second", "final"]);
  });

  it("waits for asynchronous publications before settling the load", async () => {
    const appliedPublication = deferred();
    build(
      { mode: "snapshot", load: () => "final" },
      {
        apply: async (publication) => {
          applied.push(publication);
          await appliedPublication.promise;
        },
      },
    );

    let settled = false;
    const completion = source.open().then(() => (settled = true));
    await flushMicrotasks();
    expect(applied).toEqual(["final"]);
    expect(settled).toBe(false);
    expect(source.isLoading()).toBe(true);

    appliedPublication.resolve();
    await completion;
    expect(settled).toBe(true);
    expect(source.isLoading()).toBe(false);
  });

  it("treats an undefined return as no final publication", async () => {
    build({
      mode: "snapshot",
      load({ publish }) {
        publish(null);
      },
    });

    await source.open();

    expect(applied).toEqual([null]);
  });

  it("does not react to query changes in snapshot mode", async () => {
    const pending = deferred();
    let request;
    const load = jasmine.createSpy("load").and.callFake((value) => {
      request = value;
      return pending.promise;
    });
    build({ mode: "snapshot", load });
    const completion = source.open();

    query = "changed";
    expect(source.queryChanged()).toBe(false);
    advanceClock(1000);

    expect(load).toHaveBeenCalledTimes(1);
    expect(request.signal.aborted).toBe(false);
    pending.resolve("snapshot");
    await completion;
    expect(applied).toEqual(["snapshot"]);
  });

  it("loads query mode immediately on open and debounces later query changes by 100ms", async () => {
    const seen = [];
    build({
      mode: "query",
      load({ query: requestedQuery }) {
        seen.push(requestedQuery);
        return requestedQuery;
      },
    });
    await source.open();
    applied.length = 0;
    loading.length = 0;

    query = "first";
    expect(source.queryChanged()).toBe(true);
    expect(source.isLoading()).toBe(true);
    advanceClock(99);
    expect(seen).toEqual(["initial"]);

    query = "latest";
    source.queryChanged();
    advanceClock(99);
    expect(seen).toEqual(["initial"]);
    advanceClock(1);
    await flushMicrotasks();

    expect(seen).toEqual(["initial", "latest"]);
    expect(applied).toEqual(["latest"]);
    expect(loading).toEqual([true, false]);
    expect(source.isLoading()).toBe(false);
  });

  it("honors a custom debounce and lets zero start synchronously", async () => {
    const load = jasmine.createSpy("load").and.callFake(({ query }) => query);
    build({ mode: "query", debounceMs: 25, load });
    await source.open();

    query = "delayed";
    source.queryChanged();
    advanceClock(24);
    expect(load).toHaveBeenCalledTimes(1);
    advanceClock(1);
    expect(load).toHaveBeenCalledTimes(2);
    await flushMicrotasks();

    await source.setSource({ mode: "query", debounceMs: 0, load });
    query = "now";
    source.queryChanged();
    expect(load).toHaveBeenCalledTimes(4);
    await flushMicrotasks();
    expect(applied.at(-1)).toBe("now");
  });

  it("aborts an in-flight query as soon as a new query is scheduled", async () => {
    const requests = [];
    build({
      mode: "query",
      load(request) {
        requests.push(request);
        return new Promise(() => {});
      },
    });
    void source.open();

    query = "replacement";
    source.queryChanged();

    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[0].signal.reason).toBe("query-changed");
    expect(source.isLoading()).toBe(true);
  });

  it("ignores stale progressive publications and return values", async () => {
    const first = deferred();
    const second = deferred();
    const requests = [];
    build({
      mode: "snapshot",
      load(request) {
        requests.push(request);
        return requests.length === 1 ? first.promise : second.promise;
      },
    });

    const firstCompletion = source.open();
    const secondCompletion = source.reload();
    expect(requests[0].signal.aborted).toBe(true);
    expect(await requests[0].publish("stale-progress")).toBe(false);

    second.resolve("current");
    await secondCompletion;
    first.resolve("stale-final");
    await firstCompletion;

    expect(applied).toEqual(["current"]);
    expect(loading).toEqual([true, false]);
  });

  it("reloads immediately in either mode and uses the latest query", async () => {
    const seen = [];
    build({
      mode: "query",
      debounceMs: 500,
      load({ query: requestedQuery }) {
        seen.push(requestedQuery);
      },
    });
    await source.open();

    query = "changed";
    await source.reload();

    expect(seen).toEqual(["initial", "changed"]);
  });

  it("replaces an open source immediately and leaves a closed replacement idle", async () => {
    const old = deferred();
    let oldRequest;
    build({
      mode: "snapshot",
      load(request) {
        oldRequest = request;
        return old.promise;
      },
    });
    const oldCompletion = source.open();
    const replacement = jasmine.createSpy("replacement").and.returnValue("new");

    await source.setSource({ mode: "snapshot", load: replacement });
    expect(oldRequest.signal.aborted).toBe(true);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(applied).toEqual(["new"]);

    old.resolve("old");
    await oldCompletion;
    source.cancel();
    await source.setSource({ mode: "snapshot", load: replacement });
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending debounce and aborts with the supplied reason", async () => {
    const pending = deferred();
    let request;
    const load = jasmine.createSpy("load").and.callFake((value) => {
      request = value;
      return pending.promise;
    });
    build({ mode: "query", load });
    const completion = source.open();
    query = "queued";
    source.queryChanged();

    expect(source.cancel("dialog-hidden")).toBe(true);
    expect(source.cancel("again")).toBe(false);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe("query-changed");
    expect(source.isLoading()).toBe(false);
    advanceClock(100);
    expect(load).toHaveBeenCalledTimes(1);

    pending.resolve("late");
    await completion;
    expect(applied).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("passes an explicit cancel reason to the active load", () => {
    let signal;
    build({
      mode: "snapshot",
      load(request) {
        signal = request.signal;
        return new Promise(() => {});
      },
    });
    void source.open();

    source.cancel("user-cancelled");

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("user-cancelled");
    expect(loading).toEqual([true, false]);
  });

  it("silences AbortError and reports a regular current error", async () => {
    const abortError = new Error("stopped");
    abortError.name = "AbortError";
    build({
      mode: "snapshot",
      load: jasmine.createSpy("load").and.rejectWith(abortError),
    });
    await source.open();
    expect(errors).toEqual([]);

    const failure = new Error("network failed");
    await source.setSource({
      mode: "snapshot",
      load: jasmine.createSpy("load").and.rejectWith(failure),
    });
    expect(errors).toEqual([failure]);
    expect(source.isLoading()).toBe(false);
  });

  it("ignores a stale regular error from a superseded load", async () => {
    const stale = deferred();
    build({ mode: "snapshot", load: () => stale.promise });
    const staleCompletion = source.open();
    await source.setSource({ mode: "snapshot", load: () => "current" });

    stale.reject(new Error("stale failure"));
    await staleCompletion;

    expect(applied).toEqual(["current"]);
    expect(errors).toEqual([]);
  });

  it("destroys idempotently, aborts work, and rejects later operations", async () => {
    const pending = deferred();
    let signal,
      aborts = 0;
    build({
      mode: "snapshot",
      load(request) {
        signal = request.signal;
        signal.addEventListener("abort", () => aborts++);
        return pending.promise;
      },
    });
    const completion = source.open();

    source.destroy();
    source.destroy();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("destroyed");
    expect(aborts).toBe(1);
    expect(source.isLoading()).toBe(false);
    expect(() => source.open()).toThrowError(/destroyed/);
    expect(() => source.queryChanged()).toThrowError(/destroyed/);
    expect(() => source.reload()).toThrowError(/destroyed/);
    expect(() => source.setSource(null)).toThrowError(/destroyed/);

    pending.resolve("late");
    await completion;
    expect(applied).toEqual([]);
  });
});
