"use strict";

const path = require("path");
const fs = require("node:fs");
// Electron 43 ships the synchronous Node SQLite API used by this adapter.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { DatabaseSync } = require("node:sqlite");

module.exports = class SQLStateStore {
  constructor(databaseName, version, { storagePath }) {
    const table = `${databaseName}${version}`;
    this.tableName = `"${table}"`;

    const dbPath = path.join(storagePath, "session-store.db");
    let db;
    try {
      // Ensure the storage directory exists before opening the database.
      // Normally it is the config dir and already present, but it can be missing
      // (a first run, or a test whose teardown removed its temp home), in which
      // case `DatabaseSync` would throw and the store would silently stop
      // persisting. Recreating it is a no-op when the directory already exists.
      fs.mkdirSync(storagePath, { recursive: true });
      db = new DatabaseSync(dbPath);
      // Initialize inside the try so a transient failure (e.g. a WAL lock on the
      // shared session store) can't escape the constructor leaving a half-open
      // connection leaked. Close the partially-opened handle before bailing.
      //
      // Several windows restored together open this database concurrently, and
      // the journal-mode switch plus table creation take write locks. The
      // default busy timeout is 0, which turns that startup race into an
      // immediate "database is locked" failure, so wait for the lock instead.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS ${this.tableName} (key VARCHAR, value JSON)`);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${table}_index" ON ${this.tableName}(key)`);
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Nothing more we can do if closing the failed handle also throws.
      }
      const stack = new Error("Error loading SQLite database for state storage").stack;
      lumine.notifications.addFatalError("Error loading database", { stack, dismissable: true });
      console.error("Error loading SQLite database", error);
      this.connected = false;
      return;
    }

    this.db = db;
    this.connected = true;
  }

  // The contract for this adapter expects promises, so these methods are async
  // even though Node's built-in SQLite API is synchronous.
  get dbPromise() {
    return Promise.resolve(this.db);
  }

  isConnected() {
    return this.connected;
  }

  async connect() {
    return true;
  }

  async save(key, value) {
    if (!this.db) return null;
    return exec(
      this.db,
      `REPLACE INTO ${this.tableName} VALUES (?, ?)`,
      key,
      JSON.stringify({ value, storedAt: new Date().toString() }),
    );
  }

  async load(key) {
    if (!this.db) return null;
    const result = getOne(this.db, `SELECT value FROM ${this.tableName} WHERE key = ?`, key);
    if (!result) return null;
    const parsed = JSON.parse(result.value, reviver);
    return parsed?.value;
  }

  async update(key, updater) {
    if (typeof updater !== "function") throw new TypeError("State updater must be a function");
    if (!this.db) throw new Error("State storage is unavailable");

    // Lock before reading: another renderer must not change this value between
    // the read and write. Updaters run synchronously while the lock is held.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = getOne(this.db, `SELECT value FROM ${this.tableName} WHERE key = ?`, key);
      const current = row ? JSON.parse(row.value, reviver)?.value : null;
      const updated = updater(current);
      if (updated && typeof updated.then === "function") {
        // A rejected async updater must not escape as an unhandled rejection.
        Promise.resolve(updated).catch(() => {});
        throw new TypeError("State updater must be synchronous");
      }
      exec(
        this.db,
        `REPLACE INTO ${this.tableName} VALUES (?, ?)`,
        key,
        JSON.stringify({ value: updated, storedAt: new Date().toString() }),
      );
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if the connection also became unusable.
      }
      throw error;
    }
  }

  async delete(key) {
    if (!this.db) return null;
    exec(this.db, `DELETE FROM ${this.tableName} WHERE key = ?`, key);
  }

  async clear() {
    if (!this.db) return null;
    exec(this.db, `DELETE from ${this.tableName}`);
  }

  // Release the underlying connection so its file handle and WAL lock on the
  // shared session store are not held for the life of the process.
  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore: the connection may already be gone.
      }
      this.db = null;
    }
    this.connected = false;
  }

  async count() {
    if (!this.db) return null;
    const result = getOne(this.db, `SELECT COUNT(key) itemCount FROM ${this.tableName}`);
    return result.itemCount;
  }
};

function getOne(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function exec(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function reviver(_, value) {
  if (value?.type === "Buffer") {
    return Buffer.from(value.data);
  } else {
    return value;
  }
}
