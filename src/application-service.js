const getWindowLoadSettings = require("./get-window-load-settings");
const semver = require("semver");
const { getReleaseChannel } = require("./get-app-details");
const TaskProgress = require("./task-progress");

/**
 * @public
 * @status public
 *
 * Main-process application services exposed as serializable values.
 */
class ApplicationService {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
  }

  /** @category Application Information */

  /**
   * @public
   * @status public
   *
   * Return an Electron application path captured during bootstrap.
   *
   * @param {String} name - A supported Electron application-path name.
   * @returns {String} The cached path synchronously.
   */
  getPath(name) {
    const paths = getWindowLoadSettings().appPaths || {};
    if (!Object.hasOwn(paths, name)) throw new Error(`Unsupported application path: ${name}`);
    return paths[name];
  }

  /**
   * @public
   * @status public
   *
   * Return the application locale captured during bootstrap.
   *
   * @returns {String} The cached locale synchronously.
   */
  getLocale() {
    return getWindowLoadSettings().appLocale;
  }

  /**
   * @public
   * @status public
   *
   * Return the editor resource directory captured during bootstrap.
   *
   * @returns {String} The absolute resource path synchronously.
   */
  getResourcePath() {
    return getWindowLoadSettings().resourcePath;
  }

  /**
   * @public
   * @status public
   *
   * Return the full name of this Lumine application.
   *
   * @returns {String} The application name synchronously.
   */
  getName() {
    return getWindowLoadSettings().appName;
  }

  /**
   * @public
   * @status public
   *
   * Return the Lumine application version.
   *
   * @returns {String} The version synchronously.
   */
  getVersion() {
    return getWindowLoadSettings().appVersion;
  }

  /**
   * @public
   * @status public
   *
   * Determine whether the current application version satisfies a
   * semantic-version range.
   *
   * @param {String} range - A semantic-version range.
   * @returns {Boolean} Whether the current version satisfies the range.
   */
  versionSatisfies(range) {
    const [version] = this.getVersion().split("-");
    return semver.satisfies(version, range);
  }

  /**
   * @public
   * @status public
   *
   * Return the current release channel.
   *
   * @returns {String} The release channel.
   */
  getReleaseChannel() {
    return getReleaseChannel(this.getVersion());
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this build came from the release pipeline.
   *
   * @returns {Boolean} Whether this is a released build.
   */
  isReleasedVersion() {
    return /stable|beta|rc|nightly/.test(this.getReleaseChannel());
  }

  /** @category Application Lifecycle */

  /**
   * @public
   * @status public
   *
   * Open paths in a new or reusable Lumine window.
   *
   * The call returns immediately after sending the request to the main process.
   *
   * @param {Object} params - Paths and window options to open.
   */
  openWindow(params) {
    return this.applicationDelegate.open(params);
  }

  /** @category System Integration */

  /**
   * @public
   * @status public
   *
   * Create an owned reporter for work shown in the operating system's taskbar
   * or Dock. Each reporter contributes independently to this workspace's main
   * and detached windows; the application badge counts work across workspaces
   * on platforms that support native badges.
   *
   * Call `update({count, progress})` with a non-negative task count and an
   * optional progress fraction between zero and one. Omit progress, or use
   * `null`, for indeterminate work. A zero count clears this reporter. When
   * several reporters have known progress, the window displays their average
   * weighted by task count; any indeterminate work makes it indeterminate.
   *
   * Both `update()` and `dispose()` return promises. Dispose the reporter when
   * its owner unloads. A renderer reload or crash also clears its reports.
   * After disposal, updates reject; a failed disposal can be retried.
   *
   * @returns {Object} An owned reporter with `update(status)` and `dispose()` methods.
   */
  createTaskProgress() {
    return new TaskProgress(this.applicationDelegate);
  }

  /**
   * @public
   * @status public
   *
   * Read an operating-system user default.
   *
   * @returns {Promise<*>} resolving to a serializable preference value.
   * @param {String} key - The operating-system preference key.
   * @param {String} type - One of string, boolean, integer, float, double, url, array, or dictionary.
   */
  getUserDefault(key, type) {
    return this.applicationDelegate.invokeApp("getUserDefault", key, type);
  }

  /**
   * @public
   * @status public
   *
   * Read the operating system's accent color.
   *
   * @returns {Promise<String|null>} resolving to a `#rrggbb` string, or `null` where the
   *   platform has no accent color to report.
   */
  getAccentColor() {
    return this.applicationDelegate.invokeApp("getAccentColor");
  }

  /**
   * @public
   * @status public
   *
   * Render a complete HTML document to a PDF file.
   *
   * The document is loaded into an offscreen window of its own, so the result
   * holds only what was passed here — never the surrounding editor chrome — and
   * its scripts are not run.
   *
   * @param {String} html - A complete HTML document. Reference assets by data
   *   URI: nothing relative to the calling document resolves.
   * @param {String} outputPath - Where to write the PDF.
   * @param {Object} [options] - Electron `printToPDF` options. `printBackground`
   *   defaults to `true`.
   * @returns {Promise<Object>} resolving to `{outcome: 'success', result: outputPath}`,
   *   or `{outcome: 'failure', error}` when the document could not be printed.
   * @category Printing
   */
  printToPDF(html, outputPath, options = {}) {
    return this.applicationDelegate.invokeApp("printToPDF", html, outputPath, options);
  }

  /** @category Protocol Handling */

  /**
   * @public
   * @status public
   *
   * Determine whether Lumine is the default handler for a protocol.
   *
   * @returns {Promise<Boolean>} resolving to a `Boolean`.
   * @param {String} protocol - The protocol name without its trailing colon.
   * @param {String} [path] - The executable path used for protocol registration.
   * @param {Array<String>} [args] - Arguments supplied to the protocol executable.
   */
  isDefaultProtocolClient(protocol, path, args) {
    return this.applicationDelegate.invokeApp("isDefaultProtocolClient", protocol, path, args);
  }

  /**
   * @public
   * @status public
   *
   * Register Lumine as the default handler for a protocol.
   *
   * @returns {Promise<Boolean>} resolving to a `Boolean`.
   * @param {String} protocol - The protocol name without its trailing colon.
   * @param {String} [path] - The executable path used for protocol registration.
   * @param {Array<String>} [args] - Arguments supplied to the protocol executable.
   */
  setAsDefaultProtocolClient(protocol, path, args) {
    return this.applicationDelegate.invokeApp("setAsDefaultProtocolClient", protocol, path, args);
  }

  /**
   * @public
   * @status public
   *
   * Load an operating-system file icon as a data URL.
   *
   * @returns {Promise<String|null>} resolving to a data-URL `String`, or `null`.
   * @param {String} filePath - The filesystem path whose native icon is requested.
   * @param {Object} [options={}] - Native icon options.
   * @param {String} [options.size] - One of small, normal, or large.
   * @category System Integration
   */
  getFileIcon(filePath, options = {}) {
    return this.applicationDelegate.invokeApp("getFileIcon", filePath, options);
  }

  /**
   * @public
   * @status public
   *
   * Restart Lumine with the current launch options.
   *
   * @returns {Promise<void>} that resolves when restart is scheduled.
   * @category Application Lifecycle
   */
  restart() {
    return this.applicationDelegate.invokeApp("restart");
  }
}

module.exports = ApplicationService;
