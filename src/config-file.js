const _ = require("@lumine-code/underscore-plus");
const fs = require("@lumine-code/fs-plus");
const dedent = require("dedent");
const { Disposable, Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const CSON = require("@lumine-code/season");
const Path = require("path");
const asyncQueue = require("async/queue");

module.exports = class ConfigFile {
  static at(path, fileWatchClient) {
    if (!this._known) {
      this._known = new Map();
    }

    const existing = this._known.get(path);
    if (existing) {
      if (fileWatchClient) existing.fileWatchClient = fileWatchClient;
      return existing;
    }

    const created = new ConfigFile(path, fileWatchClient);
    this._known.set(path, created);
    return created;
  }

  constructor(path, fileWatchClient) {
    this.path = path;
    this.fileWatchClient = fileWatchClient;
    this.emitter = new Emitter();
    this.value = {};
    this.pendingUpdates = [];
    this.reloadCallbacks = [];
    this.loadGeneration = 0;

    // Use a queue to prevent multiple concurrent write to the same file.
    const writeQueue = asyncQueue(async ({ data, updates }) => {
      try {
        await new Promise((resolve, reject) => {
          CSON.writeFile(this.path, data, (error) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        for (const update of updates) update.reject(error);
        this.emitter.emit(
          "did-error",
          dedent`
            Failed to write \`${Path.basename(this.path)}\`.

            ${error.message}
          `,
        );
        return;
      }
      // A watcher read before this write finishes must not complete its updates.
      // Read explicitly as well, so a missing watcher notification cannot leave
      // a successful write waiting forever.
      this.reloadCallbacks.push(...updates);
      await this.reload();
    });

    this.requestLoad = _.debounce(() => this.reload(), 200);
    this.requestSave = _.debounce((data) => {
      const updates = this.pendingUpdates.splice(0);
      writeQueue.push({ data, updates }, (error) => {
        // I/O has already settled the update promises. An observer throwing
        // while reporting that outcome must not be presented as a failed write.
        if (error) console.error("Failed to notify configuration observers", error);
      });
    }, 200);
  }

  get() {
    return this.value;
  }

  update(value) {
    return new Promise((resolve, reject) => {
      this.pendingUpdates.push({ resolve, reject });
      this.requestSave(value);
    });
  }

  async watch() {
    if (!fs.existsSync(this.path)) {
      fs.makeTreeSync(Path.dirname(this.path));
      CSON.writeFileSync(this.path, {}, { flag: "wx" });
    }

    let subscriptions;
    try {
      const watcher = this.fileWatchClient.watchFile(this.path);
      subscriptions = new CompositeDisposable(
        watcher,
        watcher.onDidChange(() => this.requestLoad()),
        watcher.onDidInvalidate(() => this.requestLoad()),
        watcher.onDidError((error) =>
          this.emitter.emit("did-error", `Unable to watch ${this.path}: ${error.message}`),
        ),
      );
      await watcher.ready;
      await this.reload();
      return subscriptions;
    } catch {
      subscriptions?.dispose();
      await this.reload();
      //TODO_LUMINE: Find out why the lumine global variable isn't available at this point
      this.emitter.emit(
        "did-error",
        dedent`
        Unable to watch path: \`${Path.basename(this.path)}\`.

        Make sure you have permissions to \`${this.path}\`.
        On Linux the per-user inotify watch limit is often too low.
        See [this document][watches] for more info.

        [watches]:https://lumine-code.github.io/docs.html#troubleshooting/common-issues
      `,
      );
      return new Disposable();
    }
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidError(callback) {
    return this.emitter.on("did-error", callback);
  }

  async reload() {
    const generation = ++this.loadGeneration;
    let data, error;
    try {
      data = await new Promise((resolve, reject) => {
        CSON.readFile(this.path, (readError, value) =>
          readError ? reject(readError) : resolve(value),
        );
      });
    } catch (readError) {
      error = readError;
    }
    // A delayed read must not overwrite a newer filesystem observation or
    // report an error for contents that have already been read successfully.
    if (generation !== this.loadGeneration) return;

    // Observers can request another update while handling this read. Only
    // writes already completed before it may settle against these contents.
    const updates = this.reloadCallbacks.splice(0);
    if (error) {
      for (const update of updates) update.reject(error);
      this.emitter.emit(
        "did-error",
        `Failed to load \`${Path.basename(this.path)}\` - ${error.message}`,
      );
    } else {
      this.value = data || {};
      try {
        this.emitter.emit("did-change", this.value);
      } finally {
        for (const update of updates) update.resolve();
      }
    }
  }
};
