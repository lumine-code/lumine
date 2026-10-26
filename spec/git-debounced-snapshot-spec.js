const path = require("path");
const CoreGitRepository = require("../src/git-repository");
const { parseStatusSnapshot } = require("../src/repository-status-snapshot");

async function flushMicrotasks() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

function snapshotResponse(request, suffix = "current") {
  const result = {};
  if (request.status) {
    result.status = {
      fingerprint: `status-${suffix}`,
      unchanged: false,
      value: parseStatusSnapshot(`# branch.oid abc123\0# branch.head main\0? ${suffix}.txt\0`, {
        generation: request.generations.status,
        includesIgnored: request.includeIgnored,
      }),
    };
  }
  if (request.refs) {
    result.refs = {
      fingerprint: `refs-${suffix}`,
      unchanged: false,
      value: {
        schemaVersion: 1,
        generation: request.generations.refs,
        initialized: true,
        head: { oid: "abc123", name: "main", detached: false, unborn: false },
        branches: [],
        remoteBranches: [],
        tags: [],
        remotes: [],
        worktrees: [],
      },
    };
  }
  return result;
}

describe("debounced repository snapshot requests", () => {
  let repository, getSnapshot;

  beforeEach(() => {
    const workingDirectory = path.resolve("debounced-snapshot-working-directory");
    getSnapshot = jasmine
      .createSpy("getSnapshot")
      .and.callFake(async (_descriptor, request) => snapshotResponse(request));
    repository = new CoreGitRepository(
      {
        getPath: () => path.join(workingDirectory, ".git"),
        getWorkingDirectory: () => workingDirectory,
      },
      {
        gitHostClient: { getSnapshot },
        statusSnapshotDebounceMs: 150,
        refsSnapshotDebounceMs: 150,
      },
    );
  });

  afterEach(() => repository.destroy());

  it("combines a burst of awaited status and refs requests with subscriber refreshes", async () => {
    repository.onDidChangeStatusSnapshot(() => {});
    repository.onDidChangeRefsSnapshot(() => {});
    const pending = [];
    for (let index = 0; index < 20; index++) {
      pending.push(repository.refreshStatusSnapshot({ debounce: true }));
      pending.push(repository.refreshRefsSnapshot({ debounce: true }));
      repository.scheduleStatusSnapshotRefresh();
      repository.scheduleRefsSnapshotRefresh();
    }
    await flushMicrotasks();
    expect(getSnapshot).not.toHaveBeenCalled();
    advanceClock(149);
    await flushMicrotasks();
    expect(getSnapshot).not.toHaveBeenCalled();

    advanceClock(1);
    const snapshots = await Promise.all(pending);
    expect(getSnapshot.calls.count()).toBe(1);
    const request = getSnapshot.calls.mostRecent().args[1];
    expect(request.status).toBe(true);
    expect(request.refs).toBe(true);
    expect(snapshots[0]).toBe(repository.getStatusSnapshot());
    expect(snapshots[1]).toBe(repository.getRefsSnapshot());
    expect(snapshots[38]).toBe(snapshots[0]);
    expect(snapshots[39]).toBe(snapshots[1]);
  });

  for (const kind of ["Status", "Refs"]) {
    const refresh = `refresh${kind}Snapshot`;
    const observe = `onDidChange${kind}Snapshot`;
    const get = `get${kind}Snapshot`;

    it(`awaits a debounced ${kind.toLowerCase()} refresh without subscribers`, async () => {
      const pending = repository[refresh]({ debounce: true });
      await flushMicrotasks();
      expect(getSnapshot).not.toHaveBeenCalled();
      advanceClock(150);

      const snapshot = await pending;
      expect(snapshot.initialized).toBe(true);
      expect(snapshot).toBe(repository[get]());
      expect(getSnapshot.calls.count()).toBe(1);
    });

    it(`lets an immediate ${kind.toLowerCase()} refresh fulfill deferred callers`, async () => {
      const deferred = repository[refresh]({ debounce: true });
      const immediate = repository[refresh]();
      const [deferredSnapshot, immediateSnapshot] = await Promise.all([deferred, immediate]);
      expect(deferredSnapshot).toBe(immediateSnapshot);
      expect(getSnapshot.calls.count()).toBe(1);
      advanceClock(300);
      await flushMicrotasks();
      expect(getSnapshot.calls.count()).toBe(1);
    });

    it(`does not cancel an awaited ${kind.toLowerCase()} request when the last subscriber leaves`, async () => {
      const subscription = repository[observe](() => {});
      const pending = repository[refresh]({ debounce: true });
      subscription.dispose();
      advanceClock(150);

      expect((await pending).initialized).toBe(true);
      expect(getSnapshot.calls.count()).toBe(1);
    });
  }

  it("aborts one deferred waiter while preserving another caller's refresh", async () => {
    const controller = new AbortController();
    const aborted = repository.refreshStatusSnapshot({
      debounce: true,
      signal: controller.signal,
    });
    const rejected = expectAsync(aborted).toBeRejectedWithError(Error, /aborted/);
    const kept = repository.refreshStatusSnapshot({ debounce: true });
    controller.abort();
    await rejected;
    await flushMicrotasks();
    expect(getSnapshot).not.toHaveBeenCalled();
    advanceClock(150);

    expect((await kept).initialized).toBe(true);
    expect(getSnapshot.calls.count()).toBe(1);
  });

  it("preserves background interest when the only deferred caller aborts", async () => {
    const changed = jasmine.createSpy("status changed");
    repository.onDidChangeStatusSnapshot(changed);
    const controller = new AbortController();
    const pending = repository.refreshStatusSnapshot({ debounce: true, signal: controller.signal });
    const rejected = expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    controller.abort();
    await rejected;
    advanceClock(150);
    await flushMicrotasks();

    expect(getSnapshot.calls.count()).toBe(1);
    expect(changed.calls.count()).toBe(1);
  });

  it("does not start work after its only deferred caller aborts", async () => {
    const controller = new AbortController();
    const pending = repository.refreshStatusSnapshot({ debounce: true, signal: controller.signal });
    const rejected = expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    controller.abort();
    await rejected;
    advanceClock(300);
    await flushMicrotasks();

    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("merges ignored-file and priority options from deferred callers", async () => {
    const first = repository.refreshStatusSnapshot({ debounce: true, includeIgnored: false });
    const second = repository.refreshStatusSnapshot({
      debounce: true,
      includeIgnored: true,
      priority: "interactive",
    });
    advanceClock(150);
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(getSnapshot.calls.count()).toBe(1);
    const [_descriptor, request, options] = getSnapshot.calls.mostRecent().args;
    expect(request.includeIgnored).toBe(true);
    expect(options.priority).toBe("interactive");
    expect(firstSnapshot.includesIgnored).toBe(true);
    expect(secondSnapshot).toBe(firstSnapshot);
  });

  it("keeps the original deadline while filesystem events continue arriving", async () => {
    const pending = [repository.refreshStatusSnapshot({ debounce: true })];
    for (let index = 0; index < 4; index++) {
      advanceClock(30);
      pending.push(repository.refreshStatusSnapshot({ debounce: true }));
    }
    await flushMicrotasks();
    expect(getSnapshot).not.toHaveBeenCalled();
    advanceClock(30);
    await Promise.all(pending);

    expect(getSnapshot.calls.count()).toBe(1);
  });

  it("cancels worker work when its only deferred caller aborts after dispatch", async () => {
    let ownedSignal;
    getSnapshot.and.callFake(
      (_descriptor, _request, options) =>
        new Promise((_resolve, reject) => {
          ownedSignal = options.signal;
          ownedSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("worker aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = repository.refreshStatusSnapshot({ debounce: true, signal: controller.signal });
    const rejected = expectAsync(pending).toBeRejectedWithError(Error, /aborted/);
    advanceClock(150);
    await flushMicrotasks();
    expect(getSnapshot.calls.count()).toBe(1);
    controller.abort();
    await rejected;

    expect(ownedSignal.aborted).toBe(true);
  });

  it("keeps an absorbed deferred caller when the immediate requester aborts", async () => {
    let finish, ownedSignal, request;
    getSnapshot.and.callFake(
      (_descriptor, snapshotRequest, options) =>
        new Promise((resolve) => {
          finish = resolve;
          ownedSignal = options.signal;
          request = snapshotRequest;
        }),
    );
    const deferred = repository.refreshStatusSnapshot({ debounce: true });
    const controller = new AbortController();
    const immediate = repository.refreshStatusSnapshot({ signal: controller.signal });
    const rejected = expectAsync(immediate).toBeRejectedWithError(Error, /aborted/);
    await flushMicrotasks();
    controller.abort();
    await rejected;
    expect(ownedSignal.aborted).toBe(false);
    finish(snapshotResponse(request));

    expect((await deferred).initialized).toBe(true);
    advanceClock(300);
    await flushMicrotasks();
    expect(getSnapshot.calls.count()).toBe(1);
  });

  it("rejects deferred callers when destroyed before the debounce expires", async () => {
    const status = repository.refreshStatusSnapshot({ debounce: true });
    const refs = repository.refreshRefsSnapshot({ debounce: true });
    const rejectedStatus = expectAsync(status).toBeRejectedWithError(Error, /aborted/);
    const rejectedRefs = expectAsync(refs).toBeRejectedWithError(Error, /aborted/);
    repository.destroy();
    await Promise.all([rejectedStatus, rejectedRefs]);
    advanceClock(300);
    await flushMicrotasks();

    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("queues a fresh trailing read for events arriving while a snapshot is in flight", async () => {
    const reads = [];
    getSnapshot.and.callFake(
      (_descriptor, request) =>
        new Promise((resolve) => {
          reads.push({ request, resolve });
        }),
    );
    const first = repository.refreshStatusSnapshot();
    await flushMicrotasks();
    expect(reads.length).toBe(1);
    const deferredA = repository.refreshStatusSnapshot({ debounce: true });
    const deferredB = repository.refreshStatusSnapshot({ debounce: true });
    advanceClock(150);
    await flushMicrotasks();
    expect(reads.length).toBe(1);

    reads[0].resolve(snapshotResponse(reads[0].request, "older"));
    expect((await first).files[0].path).toBe("older.txt");
    await flushMicrotasks();
    expect(reads.length).toBe(2);
    reads[1].resolve(snapshotResponse(reads[1].request, "newer"));
    const [snapshotA, snapshotB] = await Promise.all([deferredA, deferredB]);

    expect(snapshotA.files[0].path).toBe("newer.txt");
    expect(snapshotB).toBe(snapshotA);
    expect(repository.getStatusSnapshot()).toBe(snapshotA);
    expect(getSnapshot.calls.count()).toBe(2);
  });
});
