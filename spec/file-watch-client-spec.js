const path = require("path");
const { EventEmitter } = require("events");
const FileWatchClient = require("../src/file-watch-client");
const FileWatchService = require("../src/file-watch-service");
const { deferred, VERSION } = require("../src/file-watch-protocol");

async function settlePromises() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("File watch client transport recovery", () => {
  let client;
  let emit;
  let requests;
  let subscription;
  let service;

  function createClient(request = () => Promise.resolve()) {
    requests = [];
    subscription = { dispose: jasmine.createSpy("dispose event listener") };
    client = new FileWatchClient({
      request(message) {
        requests.push(message);
        return request(message);
      },
      onEvent(callback) {
        emit = callback;
        return subscription;
      },
    });
    return client;
  }

  beforeEach(() => {
    client = undefined;
    service = undefined;
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    await service?.close();
  });

  it("closes the owner even when an unsubscribe request fails", async () => {
    const failure = new Error("Unsubscribe reply lost");
    const ownerCloseStarted = deferred();
    const releaseOwner = deferred();
    createClient((request) => {
      if (request.type === "unsubscribe") return Promise.reject(failure);
      if (request.type === "close") {
        ownerCloseStarted.resolve();
        return releaseOwner.promise;
      }
      return Promise.resolve();
    });
    const handle = client.watchFile(path.join(__dirname, "fixture"));
    await handle.ready;
    const closing = client.close();
    await ownerCloseStarted.promise;
    expect(requests.map(({ type }) => type)).toEqual(["subscribe", "unsubscribe", "close"]);
    expect(subscription.dispose).not.toHaveBeenCalled();
    releaseOwner.resolve();
    await expectAsync(closing).toBeRejectedWith(failure);
    expect(subscription.dispose).toHaveBeenCalledTimes(1);
    expect(client.close()).toBe(closing);
  });

  it("unblocks the service's queued deliveries after a failed acknowledgement", async () => {
    service = new FileWatchService({
      spawnWorker({ generation }) {
        const worker = new EventEmitter();
        const reply = (message) =>
          worker.emit("message", { version: VERSION, generation, ...message });
        worker.send = (message, callback) => {
          callback?.(null);
          queueMicrotask(() => reply({ type: "reply", requestId: message.requestId }));
        };
        worker.kill = () => worker.emit("exit", 0, null);
        queueMicrotask(() => reply({ type: "ready" }));
        return worker;
      },
    });
    let reject = true;
    createClient((request) => {
      if (request.type === "ack" && reject) {
        reject = false;
        return Promise.reject(new Error("IPC unavailable"));
      }
      return service.dispatch("retry", request, (event) => emit(event));
    });
    const handle = client.watchFile(path.join(__dirname, "fixture"));
    const changed = jasmine.createSpy("change");
    handle.onDidChange(changed);
    await handle.ready;
    const record = service.owners.get("retry").subscriptions.get(1);
    const first = [{ action: "updated", path: handle.path }];
    const second = [{ action: "deleted", path: handle.path }];
    service.enqueue(record, "changes", first);
    service.enqueue(record, "changes", second);
    await settlePromises();
    expect(changed.calls.allArgs()).toEqual([[first]]);
    expect(record.state.inFlight).toBe(1);
    advanceClock(250);
    await settlePromises();
    expect(requests.filter(({ type }) => type === "ack")).toEqual([
      { type: "ack", sequence: 1 },
      { type: "ack", sequence: 1 },
      { type: "ack", sequence: 2 },
    ]);
    expect(changed.calls.allArgs()).toEqual([[first], [second]]);
    expect(record.state.inFlight).toBe(null);
    expect(record.state.queuedEvents).toBe(0);
    expect(client.acknowledgements.size).toBe(0);
  });

  it("backs off failed acknowledgements and cancels retries on close", async () => {
    createClient((request) =>
      request.type === "ack" ? Promise.reject(new Error("IPC unavailable")) : Promise.resolve(),
    );
    emit({ id: 1, type: "changes", payload: [], sequence: 1 });
    await settlePromises();
    for (const delay of [250, 1000, 5000, 30000, 30000]) {
      const before = requests.length;
      advanceClock(delay - 1);
      await settlePromises();
      expect(requests.length).toBe(before);
      advanceClock(1);
      await settlePromises();
      expect(requests.length).toBe(before + 1);
      expect(client.acknowledgements.size).toBe(1);
    }
    await client.close();
    const before = requests.length;
    advanceClock(60000);
    await settlePromises();
    expect(requests.length).toBe(before);
    expect(client.acknowledgements.size).toBe(0);
  });

  it("discards obsolete retries when the service advanced despite a lost IPC reply", async () => {
    createClient((request) =>
      request.type === "ack" ? Promise.reject(new Error("Reply lost")) : Promise.resolve(),
    );
    for (let sequence = 1; sequence <= 100; sequence++) {
      emit({ id: 1, type: "changes", payload: [], sequence });
      await settlePromises();
      expect(client.acknowledgements.size).toBe(1);
    }
    emit({ id: 1, type: "changes", payload: [], sequence: 99 });
    emit({ id: 1, type: "changes", payload: [], sequence: 100 });
    await settlePromises();
    const before = requests.length;
    advanceClock(250);
    await settlePromises();
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)).toEqual({ type: "ack", sequence: 100 });
  });

  it("ignores a late failed IPC reply for an obsolete acknowledgement", async () => {
    const first = deferred();
    createClient((request) =>
      request.type === "ack" && request.sequence === 1 ? first.promise : Promise.resolve(),
    );
    emit({ id: 1, type: "changes", payload: [], sequence: 1 });
    await settlePromises();
    emit({ id: 1, type: "changes", payload: [], sequence: 2 });
    await settlePromises();
    first.reject(new Error("Late lost reply"));
    await settlePromises();
    const before = requests.length;
    advanceClock(60000);
    await settlePromises();
    expect(requests.length).toBe(before);
    expect(client.acknowledgements.size).toBe(0);
  });

  it("does not restart acknowledgement retries after the client closes", async () => {
    const reply = deferred();
    createClient((request) => (request.type === "ack" ? reply.promise : Promise.resolve()));
    emit({ id: 1, type: "changes", payload: [], sequence: 1 });
    await settlePromises();
    await client.close();
    reply.reject(new Error("Late IPC failure"));
    await settlePromises();
    const before = requests.length;
    advanceClock(60000);
    await settlePromises();
    expect(requests.length).toBe(before);
    expect(client.acknowledgements.size).toBe(0);
  });
});
