const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const FileWatchService = require("../../src/file-watch-service");
const { deferred, VERSION } = require("../../src/file-watch-protocol");

test("forced close immediately escalates a pending native release and waits for confirmed worker exit", async () => {
  let worker,
    kills = 0;
  const unsubscribing = deferred();
  const service = new FileWatchService({
    spawnWorker({ generation }) {
      worker = new EventEmitter();
      const reply = (message) =>
        worker.emit("message", { version: VERSION, generation, ...message });
      worker.send = (message, callback) => {
        callback?.(null);
        if (message.type === "unsubscribe") {
          unsubscribing.resolve();
          return;
        }
        queueMicrotask(() => reply({ type: "reply", requestId: message.requestId }));
      };
      worker.kill = () => {
        kills++;
        return true;
      };
      queueMicrotask(() => reply({ type: "ready" }));
      return worker;
    },
  });
  const client = service.createClient("force-close-test");
  try {
    await client.watchFile(path.join(__dirname, "fixture")).ready;
    const graceful = service.close();
    let completed = false;
    graceful.then(() => {
      completed = true;
    });
    await unsubscribing.promise;
    assert.equal(kills, 0);
    assert.equal(completed, false);

    const forced = service.close({ force: true });
    assert.equal(kills, 1);
    assert.equal(forced, graceful);
    assert.equal(completed, false);
    assert.equal(service.pending.size, 1);

    worker.emit("exit", 0, null);
    await forced;
    assert.equal(completed, true);
    assert.equal(service.worker, null);
    assert.equal(service.pending.size, 0);
    assert.equal(service.subscriptions.size, 0);
    assert.equal(service.owners.size, 0);
  } finally {
    if (service.worker) worker.emit("exit", 0, null);
    await service.close({ force: true });
    await client.close();
  }
});
