const _ = require("@lumine-code/underscore-plus");
const ChildProcess = require("child_process");
const { Emitter } = require("@lumine-code/event-kit");

/**
 * Like {@link Task}, but designed for file-watcher processes. Does not
 * start automatically; once it starts, it expects to run indefinitely.
 *
 * @private
 */
class WatcherTask {
  emitter = new Emitter();
  constructor(taskPath) {
    this.taskPath = taskPath;
  }

  createChildProcess() {
    let compileCachePath = require("./compile-cache").getCacheDirectory();
    let env = Object.assign({}, process.env, {
      userAgent: navigator.userAgent,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      LUMINE_COMPILE_CACHE_PATH: compileCachePath,
    });
    if (window.lumine?.unloading) {
      // Guard against spurious re-declarations of a `WatcherTask` while the
      // environment is unloading.
      this.childProcess = null;
    } else {
      // Fork the existing process. Electron patches this to automatically pass
      // `ELECTRON_RUN_AS_NODE=1` (or else Node libraries that think they’re in
      // a pure Node environment would be in for a rude awakening), but we set
      // it anyway above just out of paranoia.
      this.childProcess = ChildProcess.fork(
        require.resolve("./watcher-task-bootstrap"),
        ["--no-deprecation", this.taskPath],
        { env, silent: true, windowsHide: true },
      );
    }
    this.handleEvents();
  }

  handleEvents() {
    if (!this.childProcess) return;
    this.childProcess.removeAllListeners();
    this.childProcess.on("message", ({ event, args }) => {
      if (!this.childProcess) return;
      this.emitter.emit(event, args);
    });

    // A dying channel emits `error` on the child object; without a listener
    // that becomes an uncaught "Channel closed" exception in the renderer.
    // Treat both a channel error and an unexpected exit as the worker being
    // gone: drop the child so sends become no-ops and let owners react.
    this.childProcess.on("error", (error) => this.handleExit({ error: error?.message }));
    this.childProcess.on("exit", (code, signal) => this.handleExit({ code, signal }));

    const { stdout, stderr } = this.childProcess;

    // Catch the errors that happened before bootstrap.
    if (stdout != null) {
      stdout.removeAllListeners();
      stdout.on("data", (data) => console.log(data.toString()));
    }

    if (stderr != null) {
      stderr.removeAllListeners();
      stderr.on("data", (data) => console.error(data.toString()));
    }
  }

  start(...args) {
    // Don't spawn any workers during shutdown.
    if (window.lumine?.unloading) return;

    const [callback] = args.splice(-1);
    this.createChildProcess();
    if (_.isFunction(callback)) {
      this.callback = callback;
    } else {
      args.push(callback);
    }
    this.send({ event: "start", args });
    return;
  }

  send(message) {
    // `connected` can go false before `exit` is delivered; sending on a
    // closed channel would emit an `error` event rather than throw. Only an
    // explicit `connected: false` means closed, so test doubles without the
    // property keep the plain send path.
    if (this.childProcess && this.childProcess.connected !== false) {
      this.childProcess.send(message);
    }
  }

  // Called when the worker exits on its own or its channel breaks — not on
  // deliberate `terminate()`, which removes all listeners first. `detail`
  // carries the exit code/signal or channel error for diagnostics.
  handleExit(detail = {}) {
    if (!this.childProcess) return;
    this.childProcess.removeAllListeners();
    this.childProcess.stdout?.removeAllListeners();
    this.childProcess.stderr?.removeAllListeners();
    this.childProcess = null;
    this.emitter.emit("task:exited", [detail]);
  }

  on(eventName, callback) {
    return this.emitter.on(eventName, (args = []) => {
      callback(...args);
    });
  }

  once(eventName, callback) {
    return this.emitter.once(eventName, (args = []) => {
      callback(...args);
    });
  }

  terminate() {
    if (!this.childProcess) return false;
    this.childProcess.removeAllListeners();
    this.childProcess.stdout?.removeAllListeners();
    this.childProcess.stderr?.removeAllListeners();
    this.childProcess.kill();
    this.childProcess = null;
    return true;
  }

  cancel() {
    let didForcefullyTerminate = this.terminate();
    if (didForcefullyTerminate) {
      this.emitter.emit("task:cancelled");
    }
    return didForcefullyTerminate;
  }
}

module.exports = WatcherTask;
