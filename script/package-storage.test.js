"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const PackageStorage = require("../src/package-storage");
const StateStore = require("../src/state-store");

async function profile(t, options = {}) {
  const configDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-package-storage-"));
  const managers = [];
  const open = async (overrides = {}) => {
    const manager = new PackageStorage(overrides);
    managers.push(manager);
    await manager.initialize({
      configDirPath,
      windowStateId: "window-one",
      projectPaths: ["project-a"],
      ...options,
      ...overrides,
    });
    return manager;
  };
  t.after(async () => {
    await Promise.all(managers.map((manager) => manager.close()));
    fs.rmSync(configDirPath, { recursive: true, force: true });
  });
  return { configDirPath, open };
}

test("fixture storage is immediately ready, isolated and detached", async () => {
  const manager = new PackageStorage();
  const first = manager.forPackage("first");
  const second = manager.forPackage("second");
  assert.deepEqual(Object.keys(first).sort(), ["globalState", "workspaceState"]);
  assert.equal(first.globalState.set, undefined);
  assert.equal(first.globalState.unset, undefined);
  const defaultValue = { values: [] };
  const absent = first.globalState.get("missing", defaultValue);
  absent.values.push(1);
  assert.deepEqual(defaultValue, { values: [] });
  const value = { values: [1] };
  const pending = first.globalState.update("key", value);
  value.values.push(2);
  assert.equal(first.globalState.get("key"), undefined);
  assert.equal(await pending, undefined);
  const read = first.globalState.get("key");
  read.values.push(4);
  assert.deepEqual(first.globalState.get("key"), { values: [1] });
  assert.equal(second.globalState.get("key"), undefined);
  assert.equal(first.workspaceState.get("key"), undefined);
  await first.globalState.update("__proto__", { safe: true });
  assert.deepEqual(first.globalState.get("__proto__"), { safe: true });
  const keys = first.globalState.keys();
  assert.deepEqual(keys.sort(), ["__proto__", "key"]);
  keys.push("detached");
  assert.equal(first.globalState.keys().length, 2);
  assert.equal(first.globalState.get("toString"), undefined);
  assert.equal(await first.globalState.update("key", undefined), undefined);
  assert.equal(first.globalState.get("key", "default"), "default");
  assert.deepEqual(first.globalState.keys(), ["__proto__"]);
  await manager.close();
});

test("persistent global and project values survive restart with distinct scope identities", async (t) => {
  const { open } = await profile(t);
  const first = await open();
  const storage = first.forPackage("example");
  await storage.globalState.update("shared", ["global"]);
  await storage.workspaceState.update("choice", "project-a");
  await first.switchProject(["project-b", "project-c"]);
  await storage.workspaceState.update("choice", "project-bc");
  await first.switchProject([]);
  await storage.workspaceState.update("choice", "empty-window-one");
  await first.close();

  const second = await open({ windowStateId: "window-two" });
  const restored = second.forPackage("example");
  assert.deepEqual(restored.globalState.get("shared"), ["global"]);
  assert.equal(restored.workspaceState.get("choice"), "project-a");
  await second.switchProject(["project-c", "project-b", "project-b"]);
  assert.equal(restored.workspaceState.get("choice"), "project-bc");
  await second.switchProject([]);
  assert.equal(restored.workspaceState.get("choice"), undefined);
  const sameWindow = await open({ projectPaths: [] });
  assert.equal(sameWindow.forPackage("example").workspaceState.get("choice"), "empty-window-one");
});

test("updates use the current durable value rather than a window's stale cache", async (t) => {
  const { open } = await profile(t);
  const first = await open();
  const second = await open({ windowStateId: "window-two" });
  const a = first.forPackage("counter").globalState;
  const b = second.forPackage("counter").globalState;
  await a.update("value", 1);
  assert.equal(b.get("value"), undefined);
  assert.equal(await b.mutate("value", (current) => current + 1), 2);
  assert.equal(await a.mutate("value", (current) => current + 1), 3);
  assert.equal(a.get("value"), 3);
});

test("a committed update refreshes a stale cache after another window clears storage", async (t) => {
  const { open } = await profile(t);
  const first = await open();
  const second = await open({ windowStateId: "second" });
  const a = first.forPackage("example").globalState;
  const b = second.forPackage("example").globalState;
  await b.update("value", 1);
  await b.update("value", 2);
  await first.clear();
  assert.equal(b.get("value"), 2);
  assert.equal(await b.mutate("value", (current) => (current ?? 0) + 1), 1);
  assert.equal(b.get("value"), 1);
  await first.reloadScope({ scopeId: "global", revision: Infinity, sourceId: "second" });
  assert.equal(a.get("value"), 1);
});

test("independent Node processes update the same profile without losing writes", async (t) => {
  const { open, configDirPath } = await profile(t);
  const manager = await open();
  const modulePath = require.resolve("../src/package-storage");
  const source = `
    const PackageStorage = require(process.argv[1]);
    (async () => {
      const manager = new PackageStorage();
      await manager.initialize({configDirPath: process.argv[2], windowStateId: process.argv[3]});
      const values = manager.forPackage('counter').globalState;
      for (let i = 0; i < 30; i++) await values.mutate('total', value => (value || 0) + 1);
      await manager.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const run = (windowStateId) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CI;
      const child = spawn(
        process.execPath,
        ["-e", source, modulePath, configDirPath, windowStateId],
        {
          env,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let errors = "";
      child.stderr.on("data", (chunk) => (errors += chunk));
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors))));
    });
  await Promise.all([run("child-a"), run("child-b")]);
  await manager.reloadScope({ scopeId: "global", revision: Infinity, sourceId: "another-process" });
  assert.equal(manager.forPackage("counter").globalState.get("total"), 60);
});

test("failed or asynchronous updaters preserve committed values and do not poison the queue", async (t) => {
  const { open } = await profile(t);
  const manager = await open();
  const values = manager.forPackage("example").globalState;
  await values.update("value", { count: 1 });
  await assert.rejects(
    values.mutate("value", (current) => {
      current.count = 99;
      throw new Error("Updater failed");
    }),
    /Updater failed/,
  );
  await assert.rejects(
    values.mutate("value", async () => {
      throw new Error("Async updater rejected");
    }),
    /must be synchronous/,
  );
  assert.deepEqual(values.get("value"), { count: 1 });
  await values.mutate("value", (current) => ({ count: current.count + 1 }));
  assert.deepEqual(values.get("value"), { count: 2 });
});

test("storage rejects data that cannot round-trip as JSON", async () => {
  const manager = new PackageStorage();
  const values = manager.forPackage("example").globalState;
  const cycle = {};
  cycle.self = cycle;
  for (const value of [NaN, Infinity, 1n, () => {}, Symbol("x"), cycle, new Date(), [undefined]])
    await assert.rejects(values.update("invalid", value), /only JSON data/);
  assert.equal(values.get("invalid"), undefined);
  await values.update("valid", { nested: [null, false, 1, "text"] });
  assert.deepEqual(values.get("valid"), { nested: [null, false, 1, "text"] });
  await values.update("ordinary-property", { then: "data" });
  assert.deepEqual(values.get("ordinary-property"), { then: "data" });
  await values.mutate("valid", () => undefined);
  assert.equal(values.get("valid"), undefined);
  await manager.close();
});

test("observers are immediate, detached, disposable and notified only after commit", async () => {
  const manager = new PackageStorage();
  const values = manager.forPackage("example").globalState;
  const observed = [];
  const changes = [];
  const observing = values.observe("value", (value) => observed.push(value));
  const changing = values.onDidChange("value", (value) => changes.push(value));
  assert.deepEqual(observed, [undefined]);
  const pending = values.update("value", { count: 1 });
  assert.deepEqual(observed, [undefined]);
  await pending;
  assert.deepEqual(changes, [{ oldValue: undefined, newValue: { count: 1 } }]);
  observed[1].count = 99;
  changes[0].newValue.count = 100;
  assert.deepEqual(values.get("value"), { count: 1 });
  await values.update("value", { count: 1 });
  assert.equal(observed.length, 2);
  await values.update("value", undefined);
  assert.equal(observed[2], undefined);
  observing.dispose();
  changing.dispose();
  await values.update("value", 2);
  assert.equal(observed.length, 3);
  assert.equal(changes.length, 2);
  await manager.close();
});

test("project observers follow stable facades across scope changes", async () => {
  const manager = new PackageStorage();
  await manager.initialize({ enabled: false, projectPaths: ["a"], windowStateId: "one" });
  const values = manager.forPackage("example").workspaceState;
  await values.update("value", "A");
  const observed = [];
  const changes = [];
  values.observe("value", (value) => observed.push(value));
  values.onDidChange("value", (value) => changes.push(value));
  await manager.switchProject(["b"]);
  await values.update("value", "B");
  await manager.switchProject(["a"]);
  assert.equal(manager.forPackage("example").workspaceState, values);
  assert.deepEqual(observed, ["A", undefined, "B", "A"]);
  assert.deepEqual(changes.at(-1), { oldValue: "B", newValue: "A" });
  await manager.switchProject(["a"]);
  assert.equal(observed.length, 4);
  await manager.close();
});

test("observer metadata distinguishes scope transitions from committed value changes", async () => {
  const manager = new PackageStorage();
  await manager.initialize({ enabled: false, projectPaths: ["a"], windowStateId: "one" });
  const { workspaceState, globalState } = manager.forPackage("example");
  await workspaceState.update("value", "same");
  await manager.switchProject(["b"]);
  await workspaceState.update("value", "same");
  await manager.switchProject(["a"]);
  const observed = [];
  const changes = [];
  workspaceState.observe("value", (value, metadata) => {
    observed.push({ value, metadata });
  });
  workspaceState.onDidChange("value", (value, metadata) => changes.push({ ...value, metadata }));
  const pending = workspaceState.update("value", "new-a");
  const switching = manager.switchProject(["b"]);
  assert.deepEqual(observed, [
    { value: "same", metadata: { scopeChanged: false } },
    { value: "same", metadata: { scopeChanged: true } },
  ]);
  assert.deepEqual(changes, []);
  await Promise.all([pending, switching]);
  await workspaceState.update("value", "new-b");
  await manager.switchProject(["a"]);
  await manager.switchProject(["a"]);
  assert.deepEqual(
    observed.map(({ value, metadata }) => [value, metadata.scopeChanged]),
    [
      ["same", false],
      ["same", true],
      ["new-b", false],
      ["new-a", true],
    ],
  );
  assert.deepEqual(changes, [
    { oldValue: "same", newValue: "new-b", metadata: { scopeChanged: false } },
    { oldValue: "new-b", newValue: "new-a", metadata: { scopeChanged: true } },
  ]);
  assert.ok(observed.every(({ metadata }) => Object.isFrozen(metadata)));
  const global = [];
  globalState.observe("value", (value, metadata) => global.push({ value, metadata }));
  await manager.switchProject(["c"]);
  await globalState.update("value", "global");
  assert.deepEqual(global, [
    { value: undefined, metadata: { scopeChanged: false } },
    { value: "global", metadata: { scopeChanged: false } },
  ]);
  await manager.close();
});

test("a pending write retains its original project scope after a synchronous switch", async () => {
  const manager = new PackageStorage();
  await manager.initialize({ enabled: false, projectPaths: ["a"], windowStateId: "one" });
  const values = manager.forPackage("example").workspaceState;
  const writing = values.update("value", "belongs-to-a");
  const switching = manager.switchProject(["b"]);
  assert.equal(values.get("value"), undefined);
  await Promise.all([switching, writing]);
  assert.equal(values.get("value"), undefined);
  await manager.switchProject(["a"]);
  assert.equal(values.get("value"), "belongs-to-a");
  await manager.close();
});

test("a reentrant scope change cannot deliver obsolete values to later package observers", async () => {
  const manager = new PackageStorage();
  const first = manager.forPackage("first").workspaceState;
  const second = manager.forPackage("second").workspaceState;
  for (const project of ["b", "c", "a"]) {
    await manager.switchProject([project]);
    await first.update("value", project);
    await second.update("value", project);
  }
  const firstValues = [];
  const laterFirstValues = [];
  const secondValues = [];
  first.observe("value", (value) => {
    firstValues.push(value);
    if (value === "b") manager.switchProject(["c"]);
  });
  first.observe("value", (value) => laterFirstValues.push(value));
  second.observe("value", (value) => secondValues.push(value));
  await manager.switchProject(["b"]);
  assert.equal(first.get("value"), "c");
  assert.deepEqual(firstValues, ["a", "b", "c"]);
  assert.deepEqual(laterFirstValues, ["a", "c"]);
  assert.deepEqual(secondValues, ["a", "c"]);
  await manager.close();
});

test("scope selection is immediate and consecutive identical switches leave observers alone", async () => {
  const manager = new PackageStorage();
  await manager.initialize({ enabled: false, projectPaths: ["start"], windowStateId: "one" });
  const values = manager.forPackage("example").workspaceState;
  const observed = [];
  values.observe("value", (value) => observed.push(value));
  const a = manager.switchProject(["a"]);
  assert.equal(observed.length, 2);
  assert.equal(manager.switchProject(["a"]), a);
  assert.equal(observed.length, 2);
  const b = manager.switchProject(["b"]);
  const finalA = manager.switchProject(["a"]);
  assert.equal(observed.length, 4);
  await Promise.all([a, b, finalA]);
  await values.update("value", "final-a");
  await manager.switchProject(["b"]);
  assert.equal(values.get("value"), undefined);
  await manager.switchProject(["a"]);
  assert.equal(values.get("value"), "final-a");
  await manager.close();
});

test("an immediate post-switch write uses the incoming persistent project", async (t) => {
  const { open } = await profile(t);
  const manager = await open();
  const values = manager.forPackage("example").workspaceState;
  await values.update("value", "A");
  const selecting = manager.switchProject(["project-b"]);
  assert.equal(values.get("value"), undefined);
  const writing = values.update("value", "B");
  await Promise.all([selecting, writing]);
  manager.switchProject(["project-a"]);
  assert.equal(values.get("value"), "A");
  manager.switchProject(["project-b"]);
  assert.equal(values.get("value"), "B");
});

test("commit notifications synchronize separate windows and ignore inactive projects", async (t) => {
  const { open } = await profile(t);
  const notifications = [];
  const first = await open({ onDidCommit: (change) => notifications.push(change) });
  const second = await open({ windowStateId: "second" });
  const a = first.forPackage("example");
  const b = second.forPackage("example");
  const observed = [];
  b.globalState.observe("value", (value) => observed.push(value));
  await a.globalState.update("value", "shared");
  await second.reloadScope(notifications.at(-1));
  assert.deepEqual(observed, [undefined, "shared"]);
  await second.reloadScope(notifications.at(-1));
  assert.equal(observed.length, 2);
  await a.workspaceState.update("value", "A");
  await second.reloadScope(notifications.at(-1));
  assert.equal(b.workspaceState.get("value"), "A");
  await second.switchProject(["project-b"]);
  await a.workspaceState.update("value", "new A");
  await second.reloadScope(notifications.at(-1));
  assert.equal(b.workspaceState.get("value"), undefined);
  await second.switchProject(["project-a"]);
  assert.equal(b.workspaceState.get("value"), "new A");
  await first.clear();
  await second.reloadScope(notifications.at(-1));
  assert.equal(b.globalState.get("value"), undefined);
  assert.equal(b.workspaceState.get("value"), undefined);
});

test("reset clears fixture memory but preserves persistent values, and close drains writes", async (t) => {
  const memory = new PackageStorage();
  const old = memory.forPackage("example").globalState;
  await old.update("value", 1);
  await memory.reset();
  assert.throws(() => old.get("value"), /disposed/);
  assert.equal(memory.forPackage("example").globalState.get("value"), undefined);
  await memory.close();

  const { open } = await profile(t);
  const first = await open();
  await first.forPackage("example").globalState.update("value", 2);
  await first.reset();
  assert.equal(first.forPackage("example").globalState.get("value"), 2);
  const writing = first.forPackage("example").globalState.update("value", 3);
  await first.close();
  await writing;
  const second = await open();
  assert.equal(second.forPackage("example").globalState.get("value"), 3);
});

test("explicit clear leaves unrelated session tables intact", async (t) => {
  const { open, configDirPath } = await profile(t);
  const manager = await open();
  const unrelated = new StateStore("unrelated", 1);
  unrelated.initialize({ configDirPath });
  await unrelated.save("session", { keep: true });
  try {
    await manager.forPackage("example").globalState.update("value", 1);
    await manager.clear();
    assert.deepEqual(await unrelated.load("session"), { keep: true });
    assert.equal(manager.forPackage("example").globalState.get("value"), undefined);
  } finally {
    unrelated.close();
  }
});
