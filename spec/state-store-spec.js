const fs = require("fs");
const path = require("path");
// Electron 43 ships the synchronous Node SQLite API used by the state store.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");
const StateStore = require("../src/state-store.js");

describe("StateStore", () => {
  let databaseName = `test-database-${Date.now()}`;
  let version = 1;

  describe("with the SQLite3 backend", () => {
    beforeEach(() => {
      jasmine.useRealClock();
    });

    it("can save, load, and delete states", async () => {
      const store = new StateStore(databaseName, version);
      store.initialize({ configDirPath: lumine.getConfigDirPath() });

      await store.save("key", { foo: "bar" });

      let state = await store.load("key");
      expect(state).toEqual({ foo: "bar" });

      await store.delete("key");

      expect(await store.load("key")).toBeNull();
      expect(await store.count()).toBe(0);
    });

    it("resolves with null when a non-existent key is loaded", () => {
      const store = new StateStore(databaseName, version);
      store.initialize({ configDirPath: lumine.getConfigDirPath() });
      return store.load("no-such-key").then((value) => {
        expect(value).toBeNull();
      });
    });

    it("can clear the state object store", async () => {
      const store = new StateStore(databaseName, version);
      store.initialize({ configDirPath: lumine.getConfigDirPath() });

      await store.save("key", { foo: "bar" });
      expect(await store.count()).toBe(1);

      await store.clear();
      expect(await store.count()).toBe(0);
    });

    it("returns a database instance via dbPromise", async () => {
      const store = new StateStore(databaseName, version);
      store.initialize({ configDirPath: lumine.getConfigDirPath() });
      const instance = await store.dbPromise;
      expect(instance instanceof DatabaseSync).toBe(true);
    });

    it("configures a busy timeout so concurrently restored windows wait for the lock", async () => {
      const store = new StateStore(databaseName, version);
      store.initialize({ configDirPath: lumine.getConfigDirPath() });
      const db = await store.dbPromise;
      expect(db.prepare("PRAGMA busy_timeout").get().timeout).toBe(5000);
    });

    it("reads state from an existing SQLite database", async () => {
      const existingDatabaseName = `${databaseName}-existing`;
      const table = `${existingDatabaseName}${version}`;
      const storagePath = path.join(lumine.getConfigDirPath(), "storage");
      fs.mkdirSync(storagePath, { recursive: true });
      const databasePath = path.join(storagePath, "session-store.db");
      const database = new DatabaseSync(databasePath);
      database.exec(`CREATE TABLE IF NOT EXISTS "${table}" (key VARCHAR, value JSON)`);
      database
        .prepare(`REPLACE INTO "${table}" VALUES (?, ?)`)
        .run("existing-key", JSON.stringify({ value: { migrated: true } }));
      database.close();

      const store = new StateStore(existingDatabaseName, version);
      store.initialize({ configDirPath: lumine.getConfigDirPath() });
      expect(await store.load("existing-key")).toEqual({ migrated: true });
    });
  });

  describe("atomic updates", () => {
    let first, second;
    let updateDatabaseIndex = 0;

    beforeEach(() => {
      jasmine.useRealClock();
      const name = `${databaseName}-atomic-${updateDatabaseIndex++}`;
      first = new StateStore(name, version);
      second = new StateStore(name, version);
      for (const store of [first, second]) {
        store.initialize({ configDirPath: lumine.getConfigDirPath() });
      }
    });

    afterEach(() => {
      first.close();
      second.close();
    });

    it("updates a missing value and returns the stored value", async () => {
      const changed = await first.update("key", (current) => {
        expect(current).toBeNull();
        return { count: 1 };
      });
      expect(changed).toEqual({ count: 1 });
      expect(await second.load("key")).toEqual({ count: 1 });
    });

    it("reads the latest value from independent connections for overlapping updates", async () => {
      await first.save("key", { count: 0 });
      await Promise.all([
        first.update("key", (current) => ({ count: current.count + 1 })),
        second.update("key", (current) => ({ count: current.count + 1 })),
      ]);
      expect(await first.load("key")).toEqual({ count: 2 });
    });

    it("rolls back a failing updater and releases the lock for another connection", async () => {
      await first.save("key", { count: 0 });
      await expectAsync(
        first.update("key", (current) => {
          current.count = 99;
          throw new Error("Updater failed");
        }),
      ).toBeRejectedWithError("Updater failed");
      expect(await second.load("key")).toEqual({ count: 0 });
      expect(await second.update("key", (current) => ({ count: current.count + 1 }))).toEqual({
        count: 1,
      });
    });

    it("rejects asynchronous updaters without changing stored state", async () => {
      await first.save("key", { count: 0 });
      await expectAsync(first.update("key", async () => ({ count: 99 }))).toBeRejectedWithError(
        TypeError,
        "State updater must be synchronous",
      );
      expect(await second.load("key")).toEqual({ count: 0 });
      expect(await second.update("key", () => ({ count: 1 }))).toEqual({ count: 1 });
    });

    it("rolls back values that cannot be serialized", async () => {
      await first.save("key", { count: 0 });
      await expectAsync(
        first.update("key", () => {
          const circular = {};
          circular.self = circular;
          return circular;
        }),
      ).toBeRejected();
      expect(await second.load("key")).toEqual({ count: 0 });
      expect(await second.update("key", () => ({ count: 1 }))).toEqual({ count: 1 });
    });
  });
});
