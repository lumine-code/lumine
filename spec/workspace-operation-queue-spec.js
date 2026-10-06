const path = require("path");
const WorkspaceOperationQueue = require("../src/workspace-operation-queue");
const { flushMicrotasks } = require("./helpers/async-spec-helpers");

describe("WorkspaceOperationQueue", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((callback) => (resolve = callback));
    return { promise, resolve };
  };

  function buildQueue() {
    let nextId = 1;
    const events = [];
    const observer = { callback: null };
    const execute = jasmine.createSpy("execute").and.callFake(async (name) => name);
    const queue = new WorkspaceOperationQueue({
      keyForPath: (directory) => {
        if (typeof directory !== "string" || !directory.length) throw new TypeError("Invalid path");
        return path.resolve(directory);
      },
      nextId: () => nextId++,
      execute,
      emit: (event, operation) => {
        events.push({ event, operation });
        observer.callback?.(event, operation);
      },
      snapshot: (operation) => ({ ...operation }),
    });
    return { queue, execute, events, observer };
  }

  for (const stage of ["queue", "start", "finish"]) {
    it(`cleans up a throwing ${stage} observer and allows another operation on that path`, async () => {
      const fixture = buildQueue();
      const failure = Object.freeze(new Error(`${stage} observer failed`));
      fixture.observer.callback = (event, operation) => {
        if (event === `did-${stage}-operation` && operation.name === "initialize") throw failure;
      };

      const result = await fixture.queue
        .enqueue("initialize", "destination")
        .catch((error) => error);

      expect(result).toBe(failure);
      expect(fixture.queue.getPendingOperations()).toEqual([]);
      expect(fixture.execute.calls.count()).toBe(stage === "finish" ? 1 : 0);
      const finished = fixture.events.filter(({ event }) => event === "did-finish-operation");
      expect(finished.length).toBe(1);
      expect(finished[0].operation.repository).toBeNull();
      expect(finished[0].operation.status).toBe(stage === "finish" ? "succeeded" : "failed");
      expect(await fixture.queue.enqueue("clone", "destination", ["remote"])).toBe("clone");
      expect(fixture.execute.calls.mostRecent().args.slice(0, 2)).toEqual(["clone", ["remote"]]);
    });
  }

  it("publishes the normalized path queue before its observer re-enters through an alias", async () => {
    const fixture = buildQueue();
    const initial = deferred();
    const destination = path.resolve("destination");
    const alias = `${destination}${path.sep}child${path.sep}..`;
    let clone;
    fixture.execute.and.callFake(async (name) => {
      if (name === "initialize") await initial.promise;
      return name;
    });
    fixture.observer.callback = (event, operation) => {
      if (event === "did-queue-operation" && operation.name === "initialize") {
        clone = fixture.queue.enqueue("clone", alias);
      }
    };
    const initialize = fixture.queue.enqueue("initialize", destination);
    await flushMicrotasks();

    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["initialize"]);
    initial.resolve();
    expect(await initialize).toBe("initialize");
    expect(await clone).toBe("clone");
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["initialize", "clone"]);
    expect(fixture.execute.calls.mostRecent().args[2].workingDirectory).toBe(alias);
  });

  it("keeps a failed queued slot's path barrier until its running predecessor completes", async () => {
    const fixture = buildQueue();
    const initial = deferred();
    const failure = new Error("Queued observer failed");
    fixture.execute.and.callFake(async (name) => {
      if (name === "initialize") await initial.promise;
      return name;
    });
    fixture.observer.callback = (event, operation) => {
      if (event === "did-queue-operation" && operation.name === "failed-slot") throw failure;
    };
    const initialize = fixture.queue.enqueue("initialize", "destination");
    await flushMicrotasks();
    let rejected = false;
    const failed = fixture.queue.enqueue("failed-slot", "destination").catch((error) => {
      rejected = true;
      return error;
    });
    await flushMicrotasks();
    const clone = fixture.queue.enqueue("clone", "destination");
    await flushMicrotasks();

    expect(rejected).toBe(true);
    expect(fixture.execute.calls.allArgs().map(([name]) => name)).toEqual(["initialize"]);
    initial.resolve();
    expect(await failed).toBe(failure);
    expect(await initialize).toBe("initialize");
    expect(await clone).toBe("clone");
    expect(fixture.queue.getPendingOperations()).toEqual([]);
  });

  it("runs different destination queues in parallel", async () => {
    const fixture = buildQueue();
    const writes = deferred();
    fixture.execute.and.callFake(async (name) => {
      await writes.promise;
      return name;
    });
    const first = fixture.queue.enqueue("initialize", "destination-a");
    const second = fixture.queue.enqueue("clone", "destination-b");
    await flushMicrotasks();

    expect(fixture.execute.calls.count()).toBe(2);
    expect(fixture.queue.getPendingOperations().map(({ status }) => status)).toEqual([
      "running",
      "running",
    ]);
    writes.resolve();
    expect(await Promise.all([first, second])).toEqual(["initialize", "clone"]);
  });

  it("orders pending snapshots by shared ids across keys while preserving each caller's path", async () => {
    const fixture = buildQueue();
    const writes = deferred();
    fixture.execute.and.callFake(async () => writes.promise);
    const firstPath = path.resolve("destination-a");
    const alias = `${firstPath}${path.sep}child${path.sep}..`;
    const first = fixture.queue.enqueue("initialize", firstPath);
    const second = fixture.queue.enqueue("clone", "destination-b");
    const third = fixture.queue.enqueue("clone", alias);
    await flushMicrotasks();
    const pending = fixture.queue.getPendingOperations();

    expect(pending.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(pending.map(({ workingDirectory }) => workingDirectory)).toEqual([
      firstPath,
      "destination-b",
      alias,
    ]);
    expect(pending.map(({ repository }) => repository)).toEqual([null, null, null]);
    expect(pending.map(({ status }) => status)).toEqual(["running", "running", "queued"]);
    expect(Object.isFrozen(pending)).toBe(true);
    writes.resolve();
    await Promise.all([first, second, third]);
    for (const { operation } of fixture.events) {
      expect(operation.repository).toBeNull();
      expect(operation.workingDirectory).toBe(
        [firstPath, "destination-b", alias][operation.id - 1],
      );
    }
  });

  it("rejects a path normalization failure as a Promise without pending operations", async () => {
    const fixture = buildQueue();
    let operation;
    expect(() => {
      operation = fixture.queue.enqueue("initialize", null);
    }).not.toThrow();
    await expectAsync(operation).toBeRejected();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
    expect(fixture.queue.getPendingOperations()).toEqual([]);
  });

  it("preserves the execution failure when its finish observer also throws", async () => {
    const fixture = buildQueue();
    const original = Object.freeze(new Error("Repository creation failed"));
    const finish = new Error("Completion observer failed");
    fixture.execute.and.callFake(async () => {
      throw original;
    });
    fixture.observer.callback = (event) => {
      if (event === "did-finish-operation") throw finish;
    };

    const failure = await fixture.queue
      .enqueue("initialize", "destination")
      .catch((error) => error);

    expect(failure.errors).toEqual([original, finish]);
    expect(failure.errors[0]).toBe(original);
    expect(failure.cause).toBe(original);
    expect(fixture.queue.getPendingOperations()).toEqual([]);
  });
});
