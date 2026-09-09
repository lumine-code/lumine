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
    this.reloadCallbacks = [];

    // Use a queue to prevent multiple concurrent write to the same file.
    const writeQueue = asyncQueue((data, callback) =>
      CSON.writeFile(this.path, data, (error) => {
        if (error) {
          this.emitter.emit(
            "did-error",
            dedent`
              Failed to write \`${Path.basename(this.path)}\`.

              ${error.message}
            `,
          );
        }
        callback();
      }),
    );

    this.requestLoad = _.debounce(() => this.reload(), 200);
    this.requestSave = _.debounce((data) => writeQueue.push(data), 200);
  }

  get() {
    return this.value;
  }

  update(value) {
    return new Promise((resolve) => {
      this.requestSave(value);
      this.reloadCallbacks.push(resolve);
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

  reload() {
    return new Promise((resolve) => {
      CSON.readFile(this.path, (error, data) => {
        if (error) {
          this.emitter.emit(
            "did-error",
            `Failed to load \`${Path.basename(this.path)}\` - ${error.message}`,
          );
        } else {
          this.value = data || {};
          this.emitter.emit("did-change", this.value);

          for (const callback of this.reloadCallbacks) callback();
          this.reloadCallbacks.length = 0;
        }
        resolve();
      });
    });
  }
};
