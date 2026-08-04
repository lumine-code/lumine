"use strict";
const path = require("path");
const SQL = require("./sql");

module.exports = class StateStore {
  constructor(databaseName, version) {
    this.databaseName = databaseName;
    this.version = version;
  }

  initialize({ configDirPath }) {
    this.configDirPath = configDirPath;
  }

  isConnected() {
    return this.sql?.isConnected() ?? false;
  }

  connect() {
    return this._getOrCreateImplementation().connect();
  }

  save(key, value) {
    return this._getOrCreateImplementation().save(key, value);
  }

  load(key) {
    return this._getOrCreateImplementation().load(key);
  }

  delete(key) {
    return this._getOrCreateImplementation().delete(key);
  }

  clear() {
    return this._getOrCreateImplementation().clear();
  }

  count() {
    return this._getOrCreateImplementation().count();
  }

  // Release the backing connection. A subsequent operation lazily recreates it.
  close() {
    if (this.sql) {
      this.sql.close();
      this.sql = null;
    }
  }

  get dbPromise() {
    // Exposed because the `project-plus` community package reaches for it.
    return this._getOrCreateImplementation().dbPromise;
  }

  _getOrCreateImplementation() {
    if (!this.configDirPath) {
      throw new Error(`state-store: Must initialize with configDirPath`);
    }
    this.sql ??= new SQL(this.databaseName, this.version, {
      storagePath: path.join(this.configDirPath, "storage"),
    });
    return this.sql;
  }
};
