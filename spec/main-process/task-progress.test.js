const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const TaskProgressManager = require("../../src/task-progress-manager");
const TaskProgress = require("../../src/task-progress");

function createWindow() {
  return {
    destroyed: false,
    calls: [],
    webContents: new EventEmitter(),
    isDestroyed() {
      return this.destroyed;
    },
    setProgressBar(value) {
      this.calls.push(value);
    },
  };
}

function setup() {
  const badges = [];
  const manager = new TaskProgressManager({ setBadgeCount: (count) => badges.push(count) });
  const owner = {
    browserWindow: createWindow(),
    auxiliaryWindowBroker: { windows: new Map() },
  };
  manager.beginGeneration(owner);
  return { manager, owner, badges };
}

function update(manager, owner, id, status) {
  return manager.update(owner, id, status, manager.generations.get(owner)?.token);
}

test("aggregates owned reporters without letting one workspace clear another", () => {
  const { manager, owner, badges } = setup();
  const second = { browserWindow: createWindow() };
  manager.beginGeneration(second);
  update(manager, owner, "build", { count: 2, progress: 0.5 });
  update(manager, owner, "scan", { count: 1, progress: 0.2 });
  assert.ok(Math.abs(owner.browserWindow.calls.at(-1) - 0.4) < 1e-12);
  update(manager, second, "build", { count: 3 });
  assert.equal(second.browserWindow.calls.at(-1), 2);
  assert.equal(badges.at(-1), 6);

  manager.remove(owner, "build", manager.generations.get(owner)?.token);
  assert.equal(owner.browserWindow.calls.at(-1), 0.2);
  assert.equal(badges.at(-1), 4);
  update(manager, owner, "scan", { count: 0 });
  assert.equal(owner.browserWindow.calls.at(-1), -1);
  assert.equal(second.browserWindow.calls.at(-1), 2);
  assert.equal(badges.at(-1), 3);
  manager.dispose();
  assert.equal(second.browserWindow.calls.at(-1), -1);
  assert.equal(badges.at(-1), 0);
  assert.equal(manager.owners.size, 0);
  assert.equal(manager.windows.size, 0);
});

test("any indeterminate work wins until it finishes, then known progress resumes", () => {
  const { manager, owner } = setup();
  update(manager, owner, "build", { count: 1, progress: 0 });
  update(manager, owner, "scan", { count: 1, progress: null });
  assert.deepEqual(owner.browserWindow.calls, [0, 2]);
  manager.remove(owner, "scan", manager.generations.get(owner)?.token);
  assert.equal(owner.browserWindow.calls.at(-1), 0);
  update(manager, owner, "build", { count: 1, progress: 1 });
  assert.equal(owner.browserWindow.calls.at(-1), 1);
  manager.dispose();
});

test("new detached windows inherit workspace progress and retired windows clear it", () => {
  const { manager, owner, badges } = setup();
  update(manager, owner, "build", { count: 1 });
  const auxiliary = createWindow();
  owner.auxiliaryWindowBroker.windows.set(2, { window: auxiliary });
  manager.refresh(owner);
  assert.deepEqual(auxiliary.calls, [2]);
  assert.deepEqual(badges, [1]);
  owner.auxiliaryWindowBroker.windows.delete(2);
  manager.refresh(owner);
  assert.deepEqual(auxiliary.calls, [2, -1]);
  manager.dispose();
});

test("renderer reload, crash and destruction release reports and listeners", () => {
  for (const event of ["navigation", "render-process-gone", "destroyed"]) {
    const { manager, owner, badges } = setup();
    const contents = owner.browserWindow.webContents;
    update(manager, owner, "build", { count: 1 });
    contents.emit("did-start-navigation", {}, "file:///other", false, false);
    contents.emit("did-start-navigation", {}, "file:///index#heading", true, true);
    assert.equal(badges.at(-1), 1);
    if (event === "navigation")
      contents.emit("did-start-navigation", {}, "file:///index", false, true);
    else contents.emit(event);
    assert.equal(owner.browserWindow.calls.at(-1), -1);
    assert.equal(badges.at(-1), 0);
    assert.deepEqual(contents.eventNames(), []);
    assert.equal(manager.owners.size, 0);
    // A fresh renderer generation can report work after a reload or crash.
    manager.beginGeneration(owner);
    update(manager, owner, "build", { count: 2 });
    assert.equal(badges.at(-1), 2);
    manager.dispose();
  }
});

test("cleanup skips destroyed native windows", () => {
  const { manager, owner, badges } = setup();
  update(manager, owner, "build", { count: 1 });
  owner.browserWindow.destroyed = true;
  owner.browserWindow.webContents.emit("destroyed");
  assert.deepEqual(owner.browserWindow.calls, [2]);
  assert.equal(badges.at(-1), 0);
  assert.equal(manager.windows.size, 0);
});

test("rejects invalid IPC input without overwriting live progress", () => {
  const { manager, owner, badges } = setup();
  update(manager, owner, "build", { count: 1, progress: 0.25 });
  for (const status of [
    null,
    [],
    {},
    { count: -1 },
    { count: 0.5 },
    { count: Infinity },
    { count: 1, progress: NaN },
    { count: 1, progress: "0.5" },
    { count: 1, progress: -1 },
    { count: 1, progress: 2 },
  ]) {
    assert.throws(() => update(manager, owner, "build", status), TypeError);
  }
  for (const id of [null, "", 3, "a".repeat(129)]) {
    assert.throws(() => update(manager, owner, id, { count: 1 }), TypeError);
    assert.throws(() => manager.remove(owner, id), TypeError);
  }
  assert.deepEqual(owner.browserWindow.calls, [0.25]);
  assert.deepEqual(badges, [1]);
  manager.dispose();
  assert.throws(() => update(manager, owner, "build", { count: 1 }), /teardown/);
});

test("capture and test windows never change native presentation", () => {
  for (const flag of ["offscreen", "headless", "isSpec"]) {
    const { manager, owner, badges } = setup();
    owner[flag] = true;
    update(manager, owner, "build", { count: 1 });
    manager.refresh(owner);
    manager.dispose();
    assert.deepEqual(owner.browserWindow.calls, []);
    assert.deepEqual(badges, []);
    assert.equal(owner.browserWindow.webContents.eventNames().length, 0);
  }
});

test("reporter disposal is idempotent, rejects later updates and retries failed cleanup", async () => {
  const calls = [];
  let fail = false;
  const reporter = new TaskProgress(
    {
      invokeApp(...args) {
        calls.push(args);
        if (fail) throw new Error("IPC unavailable");
        return Promise.resolve();
      },
    },
    "renderer-generation",
  );
  await reporter.update({ count: 2 });
  fail = true;
  await assert.rejects(reporter.dispose(), /IPC unavailable/);
  await assert.rejects(reporter.update({ count: 1 }), /disposed/);
  fail = false;
  const disposal = reporter.dispose();
  assert.equal(reporter.dispose(), disposal);
  await disposal;
  assert.deepEqual(calls, [
    ["setTaskProgress", reporter.id, { count: 2 }, "renderer-generation"],
    ["removeTaskProgress", reporter.id, "renderer-generation"],
    ["removeTaskProgress", reporter.id, "renderer-generation"],
  ]);
});

test("late outgoing reports cannot survive navigation or clear a replacement generation", () => {
  const { manager, owner, badges } = setup();
  const outgoing = manager.generations.get(owner).token;
  manager.update(owner, "build", { count: 1 }, outgoing);
  owner.browserWindow.webContents.emit("did-start-navigation", {}, "file:///index", false, true);
  assert.equal(manager.generations.size, 0);
  assert.equal(badges.at(-1), 0);
  assert.throws(
    () => manager.update(owner, "late", { count: 2 }, outgoing),
    /generation has ended/,
  );
  assert.equal(manager.owners.size, 0);

  const incoming = manager.beginGeneration(owner);
  assert.notEqual(incoming, outgoing);
  manager.update(owner, "build", { count: 3 }, incoming);
  assert.throws(
    () => manager.update(owner, "late", { count: 2 }, outgoing),
    /generation has ended/,
  );
  manager.remove(owner, "build", outgoing);
  assert.equal(badges.at(-1), 3);
  owner.unloading = true;
  assert.throws(() => manager.update(owner, "late", { count: 2 }, incoming), /unloading/);
  manager.remove(owner, "build", incoming);
  assert.equal(badges.at(-1), 0);
  manager.dispose();
  assert.equal(manager.generations.size, 0);
  assert.deepEqual(owner.browserWindow.webContents.eventNames(), []);
});

test("navigation invalidates an idle renderer's bootstrap token too", () => {
  const { manager, owner } = setup();
  const outgoing = manager.generations.get(owner).token;
  assert.equal(manager.owners.size, 0);
  owner.browserWindow.webContents.emit("render-process-gone");
  assert.throws(
    () => manager.update(owner, "late", { count: 1 }, outgoing),
    /generation has ended/,
  );
  assert.equal(manager.generations.size, 0);
});
