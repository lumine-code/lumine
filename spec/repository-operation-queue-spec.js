const RepositoryOperationQueue = require("../src/repository-operation-queue");
const { flushMicrotasks } = require("./helpers/async-spec-helpers");

describe("RepositoryOperationQueue", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((callback) => (resolve = callback));
    return { promise, resolve };
  };

  function buildQueue() {
    const retention = { held: 0 };
    const events = [];
    const observer = { callback: null };
    let nextId = 1;
    const release = jasmine.createSpy("release").and.callFake(() => retention.held--);
    const acquire = jasmine.createSpy("acquire").and.callFake(() => {
      retention.held++;
      return release;
    });
    const execute = jasmine.createSpy("execute").and.callFake(async (name) => name);
    const emit = jasmine.createSpy("emit").and.callFake((event, snapshot) => {
      events.push({ event, snapshot });
      observer.callback?.(event, snapshot);
    });
    const report = jasmine.createSpy("report completion failure");
    const queue = new RepositoryOperationQueue({
      report,
      repository: { getWorkingDirectory: () => "repository" },
      nextId: () => nextId++,
      acquire,
      execute,
      emit,
      snapshot: (operation) => ({ ...operation }),
    });
    return { queue, acquire, execute, emit, release, retention, events, observer, report };
  }

  for (const stage of ["queue", "start"]) {
    it(`finishes and releases a throwing ${stage} observer without executing the write, then recovers`, async () => {
      const fixture = buildQueue();
      const failure = Object.freeze(new Error(`${stage} observer failed`));
      const completions = [];
      fixture.observer.callback = (event, operation) => {
        if (event === "did-finish-operation") {
          completions.push({
            operation,
            pending: fixture.queue.getPendingOperations(),
            retained: fixture.retention.held,
          });
        }
        if (event === `did-${stage}-operation` && operation.name === "fault") throw failure;
      };

      expect(await fixture.queue.enqueue("fault").catch((error) => error)).toBe(failure);

      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fixture.retention.held).toBe(0);
      expect(fixture.queue.getPendingOperations()).toEqual([]);
      expect(completions.length).toBe(1);
      expect(completions[0].operation.status).toBe("failed");
      expect(completions[0].operation.error).toBe(failure);
      expect(completions[0].pending).toEqual([]);
      expect(completions[0].retained).toBe(1);
      expect(await fixture.queue.enqueue("recovery", ["argument"])).toBe("recovery");
      expect(fixture.execute.calls.mostRecent().args.slice(0, 2)).toEqual([
        "recovery",
        ["argument"],
      ]);
      expect(fixture.release).toHaveBeenCalledTimes(2);
    });
  }

  it("reserves FIFO order before a queue observer synchronously enqueues another write", async () => {
    const fixture = buildQueue();
    const firstWrite = deferred();
    let reentrant;
    fixture.execute.and.callFake(async (name) => {
      if (name === "first") await firstWrite.promise;
      return name;
    });
    fixture.observer.callback = (event, operation) => {
      if (event === "did-queue-operation" && operation.name === "first") {
        reentrant = fixture.queue.enqueue("second");
      }
    };
    const first = fixture.queue.enqueue("first");
    await flushMicrotasks();

    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["first"]);
    expect(fixture.queue.getPendingOperations().map(({ status }) => status)).toEqual([
      "running",
      "queued",
    ]);
    firstWrite.resolve();
    expect(await first).toBe("first");
    expect(await reentrant).toBe("second");
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["first", "second"]);
  });

  it("rejects a queued observer promptly while keeping successors behind an older running write", async () => {
    const fixture = buildQueue();
    const firstWrite = deferred();
    const failure = new Error("Queued observer failed");
    fixture.execute.and.callFake(async (name) => {
      if (name === "first") await firstWrite.promise;
      return name;
    });
    fixture.observer.callback = (event, operation) => {
      if (event === "did-queue-operation" && operation.name === "failed-slot") throw failure;
    };
    const first = fixture.queue.enqueue("first");
    await flushMicrotasks();
    let rejected = false;
    const failed = fixture.queue.enqueue("failed-slot").catch((error) => {
      rejected = true;
      return error;
    });
    const successor = fixture.queue.enqueue("successor");
    await flushMicrotasks();

    expect(rejected).toBe(true);
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["first"]);
    expect(fixture.queue.getPendingOperations().map(({ name }) => name)).toEqual([
      "first",
      "successor",
    ]);
    firstWrite.resolve();
    expect(await failed).toBe(failure);
    expect(await first).toBe("first");
    expect(await successor).toBe("successor");
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["first", "successor"]);
    expect(fixture.release).toHaveBeenCalledTimes(3);
    expect(fixture.retention.held).toBe(0);
  });

  it("reports a finish observer failure while preserving the completed write", async () => {
    const fixture = buildQueue();
    const failure = Object.freeze(new Error("Finish observer failed"));
    let retainedAtFinish;
    let pendingAtFinish;
    fixture.observer.callback = (event, operation) => {
      if (event !== "did-finish-operation" || operation.name !== "fault") return;
      retainedAtFinish = fixture.retention.held;
      pendingAtFinish = fixture.queue.getPendingOperations();
      throw failure;
    };

    expect(await fixture.queue.enqueue("fault")).toBe("fault");
    expect(fixture.report.calls.count()).toBe(1);
    expect(fixture.report.calls.mostRecent().args[0]).toBe(failure);
    expect(fixture.report.calls.mostRecent().args[1].phase).toBe("completion");

    expect(retainedAtFinish).toBe(1);
    expect(pendingAtFinish).toEqual([]);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.retention.held).toBe(0);
    const finished = fixture.events.filter(({ event }) => event === "did-finish-operation");
    expect(finished.length).toBe(1);
    expect(finished[0].snapshot.status).toBe("succeeded");
    expect(finished[0].snapshot.error).toBeNull();
    expect(await fixture.queue.enqueue("recovery")).toBe("recovery");
  });

  it("keeps write, finish, and release failures in order with the original write as cause", async () => {
    const fixture = buildQueue();
    const writeFailure = Object.freeze(new Error("Provider write failed"));
    const finishFailure = new Error("Finish observer failed");
    const releaseFailure = new Error("Retention release failed");
    fixture.execute.and.callFake(async () => {
      throw writeFailure;
    });
    fixture.observer.callback = (event) => {
      if (event === "did-finish-operation") throw finishFailure;
    };
    fixture.release.and.callFake(() => {
      fixture.retention.held--;
      throw releaseFailure;
    });

    const failure = await fixture.queue.enqueue("fault").catch((error) => error);

    expect(failure instanceof AggregateError).toBe(true);
    expect(failure.errors).toEqual([writeFailure, finishFailure, releaseFailure]);
    expect(failure.errors[0]).toBe(writeFailure);
    expect(failure.cause).toBe(writeFailure);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.retention.held).toBe(0);
    expect(fixture.queue.getPendingOperations()).toEqual([]);
  });

  it("reports a release failure after a successful write without changing its result", async () => {
    const fixture = buildQueue();
    const failure = new Error("Retention release failed");
    fixture.release.and.callFake(() => {
      fixture.retention.held--;
      if (fixture.release.calls.count() === 1) throw failure;
    });

    expect(await fixture.queue.enqueue("first")).toBe("first");
    expect(fixture.report.calls.count()).toBe(1);
    expect(fixture.report.calls.mostRecent().args[0]).toBe(failure);
    expect(fixture.report.calls.mostRecent().args[1].phase).toBe("completion");
    expect(await fixture.queue.enqueue("second")).toBe("second");
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["first", "second"]);
    expect(fixture.release).toHaveBeenCalledTimes(2);
    expect(fixture.retention.held).toBe(0);
    expect(fixture.queue.getPendingOperations()).toEqual([]);
  });

  it("is not idle while a finishing predecessor's release is pending even if a later queued slot fails", async () => {
    const fixture = buildQueue();
    const releaseStarted = deferred();
    const release = deferred();
    fixture.release.and.callFake(() => {
      fixture.retention.held--;
      if (fixture.release.calls.count() === 1) {
        releaseStarted.resolve();
        return release.promise;
      }
    });
    const failure = new Error("Queued observer failed");
    fixture.observer.callback = (event, operation) => {
      if (event === "did-queue-operation" && operation.name === "failed-slot") throw failure;
    };
    const first = fixture.queue.enqueue("first");
    await releaseStarted.promise;
    const failed = fixture.queue.enqueue("failed-slot").catch((error) => error);
    expect(await failed).toBe(failure);

    expect(fixture.queue.getPendingOperations()).toEqual([]);
    expect(fixture.queue.isIdle()).toBe(false);
    const successor = fixture.queue.enqueue("successor");
    await flushMicrotasks();
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["first"]);
    release.resolve();
    expect(await first).toBe("first");
    expect(await successor).toBe("successor");
    expect(fixture.queue.isIdle()).toBe(true);
  });
});
