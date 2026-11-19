const { EventEmitter } = require("node:events");
const GitLineDiffWorker = require("../src/git-line-diff-worker-client");

describe("Git line diff worker", () => {
  let client;

  afterEach(() => client?.dispose());

  it("preserves zero-length ranges and converts Git blobs off the host thread", async () => {
    client = new GitLineDiffWorker();
    expect(
      await client.request(Buffer.from("gone\r\nsame\r\n"), "same\nadded\n", {
        ignoreEolWhitespace: true,
      }),
    ).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 },
      { oldStart: 3, oldLines: 0, newStart: 2, newLines: 1 },
    ]);
  });

  function createFakeWorker() {
    const worker = new EventEmitter();
    worker.postMessage = jasmine.createSpy("postMessage");
    worker.terminate = jasmine.createSpy("terminate").and.resolveTo(0);
    worker.unref = () => {};
    return worker;
  }

  it("retires cancelled active work and skips cancelled queued work", async () => {
    const workers = [];
    client = new GitLineDiffWorker({
      createWorker: () => {
        const worker = createFakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const active = new AbortController();
    const queued = new AbortController();
    const running = expectAsync(
      client.request("a", "b", { signal: active.signal }),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    const waiting = expectAsync(
      client.request("b", "c", { signal: queued.signal }),
    ).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
    const survivor = client.request("a", "a");

    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    queued.abort();
    active.abort();
    workers[0].emit("message", [{ obsolete: true }]);
    await Promise.all([running, waiting]);

    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[1].postMessage).toHaveBeenCalledTimes(1);
    expect(workers[1].postMessage.calls.argsFor(0)[0]).toEqual(
      jasmine.objectContaining({ oldSource: "a", newSource: "a" }),
    );
    workers[1].emit("message", []);
    expect(await survivor).toEqual([]);
  });

  it("bounds work that cannot finish by the watchdog deadline", async () => {
    const worker = createFakeWorker();
    client = new GitLineDiffWorker({ createWorker: () => worker, watchdogMs: 5 });
    await expectAsync(client.request("a", "b")).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_GIT_LINE_DIFF_TOO_LARGE" }),
    );
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
