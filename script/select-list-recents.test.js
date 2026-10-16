"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { updateRecentItemIds } = require("../src/select-list-recents");
const PackageStorage = require("../src/package-storage");

test("record intent preserves newer stored entries and moves only its own ID", () => {
  const current = ["new", "old", "new"];
  assert.deepEqual(
    updateRecentItemIds(current, ["chosen", "old"], { type: "record", id: "chosen", limit: 3 }),
    ["chosen", "new", "old"],
  );
  assert.deepEqual(current, ["new", "old", "new"]);
});

test("removal and clearing cannot resurrect IDs from a stale proposed list", () => {
  assert.deepEqual(updateRecentItemIds(["new", "old"], ["old"], { type: "remove", id: "old" }), [
    "new",
  ]);
  assert.deepEqual(updateRecentItemIds(["new"], ["old"], { type: "clear" }), []);
  assert.deepEqual(updateRecentItemIds(["new"], ["old"], { type: "limit", limit: 1 }), ["new"]);
  assert.deepEqual(updateRecentItemIds(["new"], ["old"], { type: "replace" }), ["old"]);
});

test("primitive IDs use the model's identity and deduplication rules", () => {
  const symbol = Symbol("item");
  const ids = [false, 1, 1n, "1", symbol, NaN];
  assert.deepEqual(updateRecentItemIds(ids, [], { type: "record", id: symbol }), [
    symbol,
    false,
    1,
    1n,
    "1",
    NaN,
  ]);
  assert.deepEqual(updateRecentItemIds([NaN, "kept"], [], { type: "remove", id: NaN }), ["kept"]);
  assert.deepEqual(updateRecentItemIds(ids, [], { type: "limit", limit: 0 }), []);
  assert.throws(() => updateRecentItemIds([], [], { type: "record", id: {} }), TypeError);
  assert.throws(() => updateRecentItemIds([], [], { type: "limit", limit: -1 }), RangeError);
  assert.throws(() => updateRecentItemIds([], [], { type: "unknown" }), TypeError);
});

for (const scope of ["globalState", "workspaceState"]) {
  test(`${scope} retains concurrent records from independent profile connections`, async (t) => {
    const base = fs.realpathSync.native(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(base, "lumine-recent-intents-"));
    const managers = [new PackageStorage(), new PackageStorage()];
    t.after(async () => {
      await Promise.all(managers.map((manager) => manager.close()));
      assert.equal(path.dirname(fs.realpathSync.native(directory)), base);
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await Promise.all(
      managers.map((manager, index) =>
        manager.initialize({
          configDirPath: directory,
          projectPaths: ["same-project"],
          windowStateId: `window-${index}`,
        }),
      ),
    );
    const [a, b] = managers.map((manager) => manager.forPackage("recent-spec")[scope]);
    const record = (store, id) =>
      store.mutate("recent", (current = []) =>
        updateRecentItemIds(current, [id], { type: "record", id, limit: 10 }),
      );
    await Promise.all([record(a, "a"), record(b, "b")]);
    const committed = await a.mutate("recent", (current) => current);
    assert.deepEqual(committed.slice().sort(), ["a", "b"]);
    await b.mutate("recent", (current) => updateRecentItemIds(current, [], { type: "clear" }));
    await record(a, "after-clear");
    assert.deepEqual(a.get("recent"), ["after-clear"]);
    await b.mutate("recent", (current) =>
      updateRecentItemIds(current, ["a"], { type: "remove", id: "a" }),
    );
    assert.deepEqual(b.get("recent"), ["after-clear"]);
  });
}
