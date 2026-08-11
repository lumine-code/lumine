const _ = require("@lumine-code/underscore-plus");
const ChildProcess = require("child_process");
const { Emitter } = require("@lumine-code/event-kit");
const path = require("path");

/**
 * A wrapper which provides standard error/output line buffering for
 * Node's ChildProcess.
 *
 * ## Examples
 *
 * ```js
 * {BufferedProcess} = require('lumine')
 *
 * const command = 'ps'
 * const args = ['-ef']
 * const stdout = (output) => console.log(output)
 * const exit = (code) => console.log("ps -ef exited with #{code}")
 * const process = new BufferedProcess({command, args, stdout, exit})
 * ```
 *
 * @public
 * @api-status Extended
 */
module.exports = class BufferedProcess {
  /**
   * @category Construction
   */

  /**
   * Runs the given command by spawning a new child process.
   *
   * @param {Object} [options] - Process options.
   * @param {String} options.command - The command to execute.
   * @param {Array<String>} [options.args] - Arguments passed to the command.
   * @param {Object} [options.options] - Options passed to Node's
   *   `ChildProcess.spawn`.
   * @param {Function} [options.stdout] - Receives buffered, complete lines of
   *   standard output and any remaining data when the stream closes.
   * @param {String} options.stdout.data - Standard-output data.
   * @param {Function} [options.stderr] - Receives buffered, complete lines of
   *   standard error and any remaining data when the stream closes.
   * @param {String} options.stderr.data - Standard-error data.
   * @param {Function} [options.exit] - Receives the process exit status.
   * @param {Number} options.exit.code - The exit status.
   * @param {Boolean} [options.autoStart=true] - Whether to start immediately.
   * @public
   * @api-status Public
   */
  constructor({ command, args, options = {}, stdout, stderr, exit, autoStart = true } = {}) {
    this.emitter = new Emitter();
    this.command = command;
    this.args = args;
    this.options = options;
    this.stdout = stdout;
    this.stderr = stderr;
    this.exit = exit;
    if (autoStart === true) {
      this.start();
    }
    this.killed = false;
  }

  start() {
    if (this.started === true) return;

    this.started = true;
    // Related to joyent/node#2318
    if (process.platform === "win32" && this.options.shell === undefined) {
      this.spawnWithEscapedWindowsArgs(this.command, this.args, this.options);
    } else {
      this.spawn(this.command, this.args, this.options);
    }
    this.handleEvents(this.stdout, this.stderr, this.exit);
  }

  // Windows has a bunch of special rules that node still doesn't take care of for you
  spawnWithEscapedWindowsArgs(command, args, options) {
    let cmdArgs = [];
    // Quote all arguments and escapes inner quotes
    if (args) {
      cmdArgs = args
        .filter((arg) => arg != null)
        .map((arg) => {
          if (this.isExplorerCommand(command) && /^\/[a-zA-Z]+,.*$/.test(arg)) {
            // Don't wrap /root,C:\folder style arguments to explorer calls in
            // quotes since they will not be interpreted correctly if they are
            return arg;
          } else {
            // Escape double quotes by putting a backslash in front of them
            return `"${arg.toString().replace(/"/g, '\\"')}"`;
          }
        });
    }

    // The command itself is quoted if it contains spaces, &, ^, | or # chars
    cmdArgs.unshift(/\s|&|\^|\(|\)|\||#/.test(command) ? `"${command}"` : command);

    const cmdOptions = _.clone(options);
    cmdOptions.windowsVerbatimArguments = true;

    this.spawn(this.getCmdPath(), ["/s", "/d", "/c", `"${cmdArgs.join(" ")}"`], cmdOptions);
  }

  /**
   * @category Event Subscription
   */

  /**
   * Invoke the given callback when the process raises an error.
   * Usually this is due to the command not being available or not on the PATH.
   * You can call `handle()` on the object passed to your callback to indicate
   * that you have handled this error.
   *
   * @param {Function} callback - callback
   * @param {Object} callback.errorObject
   * @param {Object} callback.errorObject.error - the error object
   * @param {Function} callback.errorObject.handle - call this to indicate you have handled the error. The error will not be thrown if this function is called.
   * @returns {Disposable}
   * @public
   * @api-status Public
   */
  onWillThrowError(callback) {
    return this.emitter.on("will-throw-error", callback);
  }

  /**
   * @category Helper Methods
   */

  // Helper method to pass data line by line.
  //
  // * `stream` The Stream to read from.
  // * `onLines` The callback to call with each line of data.
  // * `onDone` The callback to call when the stream has closed.
  bufferStream(stream, onLines, onDone) {
    stream.setEncoding("utf8");
    let buffered = "";

    stream.on("data", (data) => {
      if (this.killed) return;

      let bufferedLength = buffered.length;
      buffered += data;
      let lastNewlineIndex = data.lastIndexOf("\n");

      if (lastNewlineIndex !== -1) {
        let lineLength = lastNewlineIndex + bufferedLength + 1;
        onLines(buffered.substring(0, lineLength));
        buffered = buffered.substring(lineLength);
      }
    });

    stream.on("close", () => {
      if (this.killed) return;
      if (buffered.length > 0) onLines(buffered);
      onDone();
    });
  }

  // Kill all child processes of the spawned cmd.exe process on Windows.
  //
  // This is required since killing the cmd.exe does not terminate child
  // processes.
  killOnWindows() {
    if (!this.process) return;

    const parentPid = this.process.pid;
    const cmd = "wmic";
    const args = ["process", "where", `(ParentProcessId=${parentPid})`, "get", "processid"];

    let wmicProcess;

    try {
      wmicProcess = ChildProcess.spawn(cmd, args);
    } catch {
      this.killProcess();
      return;
    }

    wmicProcess.on("error", () => {}); // ignore errors

    let output = "";
    wmicProcess.stdout.on("data", (data) => {
      output += data;
    });
    wmicProcess.stdout.on("close", () => {
      for (let pid of output.split(/\s+/)) {
        if (!/^\d{1,10}$/.test(pid)) continue;
        pid = parseInt(pid, 10);

        if (!pid || pid === parentPid) continue;

        try {
          process.kill(pid);
        } catch {
          /* ignore */
        }
      }

      this.killProcess();
    });
  }

  killProcess() {
    if (this.process) this.process.kill();
    this.process = null;
  }

  isExplorerCommand(command) {
    if (command === "explorer.exe" || command === "explorer") {
      return true;
    } else if (process.env.SystemRoot) {
      return (
        command === path.join(process.env.SystemRoot, "explorer.exe") ||
        command === path.join(process.env.SystemRoot, "explorer")
      );
    } else {
      return false;
    }
  }

  getCmdPath() {
    if (process.env.comspec) {
      return process.env.comspec;
    } else if (process.env.SystemRoot) {
      return path.join(process.env.SystemRoot, "System32", "cmd.exe");
    } else {
      return "cmd.exe";
    }
  }

  /**
   * Terminate the process.
   *
   * @public
   * @api-status Public
   */
  kill() {
    if (this.killed) return;

    this.killed = true;
    if (process.platform === "win32") {
      this.killOnWindows();
    } else {
      this.killProcess();
    }
  }

  spawn(command, args, options) {
    try {
      this.process = ChildProcess.spawn(command, args, options);
    } catch (spawnError) {
      process.nextTick(() => this.handleError(spawnError));
    }
  }

  handleEvents(stdout, stderr, exit) {
    if (!this.process) return;

    const triggerExitCallback = () => {
      if (this.killed) return;
      if (stdoutClosed && stderrClosed && processExited && typeof exit === "function") {
        exit(exitCode);
      }
    };

    let stdoutClosed = true;
    let stderrClosed = true;
    let processExited = true;
    let exitCode = 0;

    if (stdout) {
      stdoutClosed = false;
      this.bufferStream(this.process.stdout, stdout, () => {
        stdoutClosed = true;
        triggerExitCallback();
      });
    }

    if (stderr) {
      stderrClosed = false;
      this.bufferStream(this.process.stderr, stderr, () => {
        stderrClosed = true;
        triggerExitCallback();
      });
    }

    if (exit) {
      processExited = false;
      this.process.on("exit", (code) => {
        exitCode = code;
        processExited = true;
        triggerExitCallback();
      });
    }

    this.process.on("error", (error) => {
      this.handleError(error);
    });
  }

  handleError(error) {
    let handled = false;

    const handle = () => {
      handled = true;
    };

    this.emitter.emit("will-throw-error", { error, handle });

    if (error.code === "ENOENT" && error.syscall.indexOf("spawn") === 0) {
      error = new Error(
        `Failed to spawn command \`${this.command}\`. Make sure \`${
          this.command
        }\` is installed and on your PATH`,
        error.path,
      );
      error.name = "BufferedProcessError";
    }

    if (!handled) throw error;
  }
};
