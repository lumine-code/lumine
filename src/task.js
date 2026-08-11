const _ = require("@lumine-code/underscore-plus");
const ChildProcess = require("child_process");
const { Emitter } = require("@lumine-code/event-kit");
const Grim = require("@lumine-code/grim");

/**
 * @public
 * @status extended
 *
 * Run a node script in a separate process.
 *
 * Used by fuzzy file search and find-and-replace in project.
 *
 * For a real-world example, see the [replace-handler](https://github.com/lumine-code/lumine/blob/master/src/replace-handler.js).
 *
 * ## Examples
 *
 * In your package code:
 *
 * ```javascript
 * const {Task} = require('lumine');
 *
 * let task = Task.once('/path/to/task-file.js', parameter1, parameter2, function() {
 *   console.log('task has finished');
 * });
 *
 * task.on('some-event-from-the-task', (data) => {
 *   console.log(data.someString); // prints 'yep this is it'
 * });
 * ```
 *
 * In `'/path/to/task-file.js'`:
 *
 * ```javascript
 * module.exports = function(parameter1, parameter2) {
 *   // Indicates that this task will be async.
 *   // Call the `callback` to finish the task
 *   const callback = this.async();
 *   emit('some-event-from-the-task', {
 *     someString: 'yep this is it'
 *   });
 *   return callback();
 * };
 * ```
 */
module.exports = class Task {
  /**
   * @public
   * @status public
   *
   * A helper method to easily launch and run a task once.
   *
   * @param taskPath - The `String` path to the CoffeeScript/JavaScript file which exports a single `Function` to execute.
   * @param args - The arguments to pass to the exported function.
   */

  // Returns the created {@link Task}.
  static once(taskPath, ...args) {
    const task = new Task(taskPath);
    task.once("task:completed", () => task.terminate());
    task.start(...args);
    return task;
  }

  // Called upon task completion.
  //
  // It receives the same arguments that were passed to the task.
  //
  // If subclassed, this is intended to be overridden. However if {@link #start}
  // receives a completion callback, this is overridden.
  callback = null;

  /**
   * @public
   * @status public
   *
   * Creates a task. You should probably use {.once}
   *
   * @param taskPath - The `String` path to the CoffeeScript/JavaScript file that exports a single `Function` to execute.
   */
  constructor(taskPath) {
    this.emitter = new Emitter();
    const compileCachePath = require("./compile-cache").getCacheDirectory();
    taskPath = require.resolve(taskPath);
    const env = Object.assign({}, process.env, { userAgent: navigator.userAgent });

    if (lumine.unloading) {
      this.childProcess = null;
    } else {
      this.childProcess = ChildProcess.fork(
        require.resolve("./task-bootstrap"),
        [compileCachePath, taskPath],
        { env, silent: true },
      );
    }

    this.on("task:log", (...args) => console.log(...args));
    this.on("task:warn", (...args) => console.warn(...args));
    this.on("task:error", (...args) => console.error(...args));

    this.on("task:deprecations", (deprecations) => {
      for (let i = 0; i < deprecations.length; i++) {
        Grim.addSerializedDeprecation(deprecations[i]);
      }
    });
    this.on("task:completed", (...args) => {
      if (typeof this.callback === "function") {
        this.callback(...args);
      }
    });
    this.handleEvents();
  }

  // Routes messages from the child to the appropriate event.
  handleEvents() {
    if (!this.childProcess) return;
    this.childProcess.removeAllListeners();
    this.childProcess.on("message", ({ event, args }) => {
      if (this.childProcess != null) {
        this.emitter.emit(event, args);
      }
    });
    // A dying IPC channel emits `error` on the child object; without a
    // listener that becomes an uncaught "Channel closed" exception in the
    // renderer. Clean up as if the task had been terminated.
    this.childProcess.on("error", () => this.terminate());
    // Catch the errors that happened before task-bootstrap.
    if (this.childProcess.stdout != null) {
      this.childProcess.stdout.removeAllListeners();
      this.childProcess.stdout.on("data", (data) => console.log(data.toString()));
    }
    if (this.childProcess.stderr != null) {
      this.childProcess.stderr.removeAllListeners();
      this.childProcess.stderr.on("data", (data) => console.error(data.toString()));
    }
  }

  /**
   * @public
   * @status public
   *
   * Starts the task.
   *
   * Throws an error if this task has already been terminated or if sending a
   * message to the child process fails.
   *
   * @param {...*} args - Arguments passed to the function exported by the task script.
   * @param {Function} [callback] - Called when the task completes.
   */
  start(...args) {
    // Don't spawn any new tasks during shutdown.
    if (lumine.unloading) return;
    const [callback] = args.splice(-1);
    if (this.childProcess == null) {
      throw new Error("Cannot start terminated process");
    }
    this.handleEvents();
    if (_.isFunction(callback)) {
      this.callback = callback;
    } else {
      args.push(callback);
    }
    this.send({ event: "start", args });
    return undefined;
  }

  /**
   * @public
   * @status public
   *
   * Send message to the task.
   *
   * Throws an error if this task has already been terminated or if sending a
   * message to the child process fails.
   *
   * @param message - The message to send to the task.
   */
  send(message) {
    if (this.childProcess != null && !this.isChildRunning()) {
      // The child exited or its channel closed without a deliberate
      // terminate(); sending would emit an uncaught `error` event instead of
      // throwing. Clean up and fail the documented way.
      this.terminate();
    }
    if (this.childProcess != null) {
      this.childProcess.send(message);
    } else {
      throw new Error("Cannot send message to terminated process");
    }
    return undefined;
  }

  // A dead child keeps reporting `connected: true` until the last of its stdio
  // streams closes, and on Linux that lands well after `exit`, so the exit
  // status has to be consulted as well.
  isChildRunning() {
    const child = this.childProcess;
    return child.connected !== false && child.exitCode == null && child.signalCode == null;
  }

  /**
   * @public
   * @status public
   *
   * Call a function when an event is emitted by the child process
   *
   * @param eventName - The `String` name of the event to handle.
   * @param callback - The `Function` to call when the event is emitted.
   * @returns {Disposable} that can be used to stop listening for the event.
   */
  on(eventName, callback) {
    return this.emitter.on(eventName, (args) => callback(...(args || [])));
  }

  once(eventName, callback) {
    var disposable = this.on(eventName, function (...args) {
      disposable.dispose();
      callback(...args);
    });
  }

  /**
   * @public
   * @status public
   *
   * Forcefully stop the running task.
   *
   * No more events are emitted once this method is called.
   *
   * @returns {Boolean} indicating whether the task was terminated.
   */
  terminate() {
    if (this.childProcess == null) {
      return false;
    }
    this.childProcess.removeAllListeners();
    this.childProcess.stdout?.removeAllListeners();
    this.childProcess.stderr?.removeAllListeners();
    this.childProcess.kill();
    this.childProcess = null;
    return true;
  }

  /**
   * @public
   * @status public
   *
   * Cancel the running task and emit an event if it was canceled.
   *
   * @returns {Boolean} indicating whether the task was terminated.
   */
  cancel() {
    const didForcefullyTerminate = this.terminate();
    if (didForcefullyTerminate) {
      this.emitter.emit("task:cancelled");
    }
    return didForcefullyTerminate;
  }
};
