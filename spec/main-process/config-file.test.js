const assert = require("node:assert/strict");
const sinon = require("sinon");
const CSON = require("@lumine-code/season");
const ConfigFile = require("../../src/config-file");

describe("ConfigFile updates", function () {
  let sandbox, file, writes, reads, writeWaiters, readWaiters, changes, errors;

  beforeEach(function () {
    sandbox = sinon.createSandbox();
    file = new ConfigFile("the-config.json");
    writes = [];
    reads = [];
    writeWaiters = new Map();
    readWaiters = new Map();
    changes = [];
    errors = [];
    sandbox.stub(CSON, "writeFile").callsFake((_path, data, callback) => {
      const index = writes.length;
      const write = { data, callback };
      writes.push(write);
      writeWaiters.get(index)?.(write);
      writeWaiters.delete(index);
    });
    sandbox.stub(CSON, "readFile").callsFake((_path, callback) => {
      const index = reads.length;
      reads.push(callback);
      readWaiters.get(index)?.(callback);
      readWaiters.delete(index);
    });
    file.onDidChange((value) => changes.push(value));
    file.onDidError((error) => errors.push(error));
  });

  afterEach(function () {
    file.requestSave.cancel();
    file.requestLoad.cancel();
    file.emitter.dispose();
    sandbox.restore();
  });

  function whenWritten(index) {
    return writes[index]
      ? Promise.resolve(writes[index])
      : new Promise((resolve) => writeWaiters.set(index, resolve));
  }

  function whenRead(index) {
    return reads[index]
      ? Promise.resolve(reads[index])
      : new Promise((resolve) => readWaiters.set(index, resolve));
  }

  it("coalesces updates into the latest write and completes them after reading disk", async function () {
    let completed = 0;
    const first = file.update({ value: "earlier" }).then(() => completed++);
    const second = file.update({ value: "latest" }).then(() => completed++);
    const write = await whenWritten(0);
    assert.equal(writes.length, 1);
    assert.deepEqual(write.data, { value: "latest" });
    assert.equal(completed, 0);

    write.callback();
    const read = await whenRead(0);
    assert.equal(completed, 0);
    const diskValue = { value: "read back from disk" };
    read(null, diskValue);
    await Promise.all([first, second]);

    assert.equal(completed, 2);
    assert.deepEqual(file.get(), diskValue);
    assert.deepEqual(changes, [diskValue]);
    assert.deepEqual(errors, []);
    assert.equal(file.pendingUpdates.length, 0);
    assert.equal(file.reloadCallbacks.length, 0);
  });

  it("rejects every update in a failed write batch and allows a later update", async function () {
    const error = Object.assign(new Error("Write denied"), { code: "EACCES" });
    const first = assert.rejects(file.update({ value: "earlier" }), (actual) => actual === error);
    const second = assert.rejects(file.update({ value: "latest" }), (actual) => actual === error);
    (await whenWritten(0)).callback(error);
    await Promise.all([first, second]);

    assert.deepEqual(file.get(), {});
    assert.deepEqual(changes, []);
    assert.equal(reads.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Failed to write `the-config.json`/);
    assert.match(errors[0], /Write denied/);
    assert.equal(file.pendingUpdates.length, 0);
    assert.equal(file.reloadCallbacks.length, 0);

    const recovered = file.update({ value: "recovered" });
    (await whenWritten(1)).callback();
    (await whenRead(0))(null, { value: "recovered" });
    await recovered;
    assert.deepEqual(file.get(), { value: "recovered" });
  });

  it("rejects an authoritative read failure after writing and recovers on the next update", async function () {
    file.value = { value: "previous" };
    const error = new Error("Invalid configuration on disk");
    const failed = assert.rejects(file.update({ value: "written" }), (actual) => actual === error);
    (await whenWritten(0)).callback();
    (await whenRead(0))(error);
    await failed;

    assert.deepEqual(file.get(), { value: "previous" });
    assert.deepEqual(changes, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Failed to load `the-config.json`/);
    assert.equal(file.reloadCallbacks.length, 0);

    const recovered = file.update({ value: "recovered" });
    (await whenWritten(1)).callback();
    (await whenRead(1))(null, { value: "recovered" });
    await recovered;
    assert.deepEqual(file.get(), { value: "recovered" });
  });

  it("does not complete an update from a watcher read preceding its write", async function () {
    let completed = false;
    const update = file.update({ value: "new" }).then(() => (completed = true));
    const earlierRead = file.reload();
    reads[0](null, { value: "old" });
    await earlierRead;
    assert.equal(completed, false);

    (await whenWritten(0)).callback();
    (await whenRead(1))(null, { value: "new" });
    await update;
    assert.equal(completed, true);
    assert.deepEqual(changes, [{ value: "old" }, { value: "new" }]);
  });

  it("ignores an obsolete read error and waits for the newest read", async function () {
    let completed = false;
    const update = file.update({ value: "saved" }).then(() => (completed = true));
    (await whenWritten(0)).callback();
    const oldRead = await whenRead(0);
    const newest = file.reload();
    oldRead(new Error("Obsolete read failure"));
    await Promise.resolve();
    assert.equal(completed, false);
    assert.deepEqual(errors, []);

    reads[1](null, { value: "saved" });
    await Promise.all([newest, update]);
    assert.equal(completed, true);
    assert.deepEqual(changes, [{ value: "saved" }]);
  });

  it("completes updates when a superseding read's change observer throws", async function () {
    const observerError = new Error("Change observer failed");
    file.onDidChange(() => {
      throw observerError;
    });
    const update = file.update({ value: "saved" });
    (await whenWritten(0)).callback();
    const oldRead = await whenRead(0);
    const newest = file.reload();
    const observedFailure = assert.rejects(newest, (error) => error === observerError);
    oldRead(null, { value: "obsolete" });
    // The queued write can finish before the newer independent read delivers
    // its result. It can no longer rescue promises abandoned by that read.
    await new Promise((resolve) => setImmediate(resolve));
    reads[1](null, { value: "saved" });
    await Promise.all([observedFailure, update]);

    assert.deepEqual(file.get(), { value: "saved" });
    assert.deepEqual(changes, [{ value: "saved" }]);
    assert.deepEqual(errors, []);
    assert.equal(file.reloadCallbacks.length, 0);
  });

  it("preserves read rejection when a superseding read's error observer throws", async function () {
    file.value = { value: "previous" };
    const readError = new Error("Read failed");
    const observerError = new Error("Error observer failed");
    file.onDidError(() => {
      throw observerError;
    });
    const update = assert.rejects(file.update({ value: "saved" }), (error) => error === readError);
    (await whenWritten(0)).callback();
    const oldRead = await whenRead(0);
    const newest = file.reload();
    const observedFailure = assert.rejects(newest, (error) => error === observerError);
    oldRead(null, { value: "obsolete" });
    await new Promise((resolve) => setImmediate(resolve));
    reads[1](readError);
    await Promise.all([observedFailure, update]);

    assert.deepEqual(file.get(), { value: "previous" });
    assert.deepEqual(changes, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Failed to load `the-config.json`/);
    assert.equal(file.reloadCallbacks.length, 0);
  });

  it("reports a queued observer exception without reporting a successful write as failed", async function () {
    const observerError = new Error("Change observer failed");
    const log = sandbox.stub(console, "error");
    const subscription = file.onDidChange(() => {
      throw observerError;
    });
    const update = file.update({ value: "saved" });
    (await whenWritten(0)).callback();
    (await whenRead(0))(null, { value: "saved" });
    await update;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(file.get(), { value: "saved" });
    assert.deepEqual(errors, []);
    assert.equal(log.callCount, 1);
    assert.equal(log.firstCall.args[1], observerError);
    assert.equal(file.reloadCallbacks.length, 0);

    subscription.dispose();
    const recovered = file.update({ value: "recovered" });
    (await whenWritten(1)).callback();
    (await whenRead(1))(null, { value: "recovered" });
    await recovered;
    assert.deepEqual(file.get(), { value: "recovered" });
    assert.equal(log.callCount, 1);
  });

  it("keeps a reentrant change observer's update for its own write", async function () {
    let second,
      secondCompleted = false;
    file.onDidChange((value) => {
      if (value.value === "first") {
        second = file.update({ value: "second" }).then(() => (secondCompleted = true));
      }
    });
    const first = file.update({ value: "first" });
    (await whenWritten(0)).callback();
    (await whenRead(0))(null, { value: "first" });
    await first;
    assert.equal(secondCompleted, false);
    assert.equal(file.pendingUpdates.length, 1);

    (await whenWritten(1)).callback();
    (await whenRead(1))(null, { value: "second" });
    await second;
    assert.equal(secondCompleted, true);
    assert.deepEqual(changes, [{ value: "first" }, { value: "second" }]);
    assert.equal(file.pendingUpdates.length, 0);
    assert.equal(file.reloadCallbacks.length, 0);
  });

  it("rejects a failed write without rejecting the next queued batch", async function () {
    const error = new Error("First write failed");
    const failed = assert.rejects(file.update({ value: "first" }), (actual) => actual === error);
    const firstWrite = await whenWritten(0);
    const saved = file.update({ value: "second" });
    // Allow the second debounce to enqueue while the first write is pending.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(writes.length, 1);
    firstWrite.callback(error);
    await failed;
    const secondWrite = await whenWritten(1);
    assert.deepEqual(secondWrite.data, { value: "second" });
    secondWrite.callback();
    (await whenRead(0))(null, { value: "second" });
    await saved;
    assert.deepEqual(file.get(), { value: "second" });
    assert.equal(errors.length, 1);
  });
});
