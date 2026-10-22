const { isApplicable } = require("./electron-rm-sync-compatibility");
const BufferedProcess = require("./buffered-process");

/**
 * @public
 * @status extended
 *
 * Like {@link BufferedProcess}, but accepts a Node script as the command
 * to run.
 *
 * This is necessary on Windows since it doesn't support shebang `#!` lines.
 *
 * ## Examples
 *
 * ```js
 *   const {BufferedNodeProcess} = require('lumine')
 * ```
 */
module.exports = class BufferedNodeProcess extends BufferedProcess {
  /**
   * @public
   * @status extended
   *
   * Get a fresh array of runtime arguments for a Node script launched with the
   * editor's executable. Place these before the script path, or pass them as
   * `execArgv` to `child_process.fork`. Use these with the editor's
   * `process.execPath`. The array is empty outside Windows Electron, and
   * requesting it never changes the process environment.
   * @returns {Array<String>} Runtime arguments for the current editor process.
   */
  static getNodeExecArguments() {
    return isApplicable() ? ["--require", require.resolve("./electron-rm-sync-compatibility")] : [];
  }

  /**
   * @public
   * @status public
   *
   * Runs the given Node script by spawning a new child process.
   *
   * @param {Object} options - Process options.
   * @param {String} options.command - Path to the JavaScript script.
   * @param {Array<String>} [options.args] - Arguments passed to the script.
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
   * @category Construction
   */
  constructor({ command, args, options = {}, stdout, stderr, exit }) {
    options.env = options.env || Object.create(process.env);
    options.env.ELECTRON_RUN_AS_NODE = 1;
    options.env.ELECTRON_NO_ATTACH_CONSOLE = 1;

    args = args ? args.slice() : [];
    args.unshift(command);
    args.unshift(...BufferedNodeProcess.getNodeExecArguments());
    args.unshift("--no-deprecation");

    super({
      command: process.execPath,
      args,
      options,
      stdout,
      stderr,
      exit,
    });
  }
};
