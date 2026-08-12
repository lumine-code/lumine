const getWindowLoadSettings = require("./get-window-load-settings");
const semver = require("semver");
const { getReleaseChannel } = require("./get-app-details");

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

  /**
   * @public
   * @status public
   *
   * Read an operating-system user default.
   *
   * @returns {Promise} resolving to a serializable preference value.
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
   * @returns {Promise} resolving to a `#rrggbb` string, or `null` where the
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
   * @returns {Promise} resolving to `{outcome: 'success', result: outputPath}`,
   *   or `{outcome: 'failure', error}` when the document could not be printed.
   */
  printToPDF(html, outputPath, options = {}) {
    return this.applicationDelegate.invokeApp("printToPDF", html, outputPath, options);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether Lumine is the default handler for a protocol.
   *
   * @returns {Promise} resolving to a `Boolean`.
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
   * @returns {Promise} resolving to a `Boolean`.
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
   * @returns {Promise} resolving to a data-URL `String`, or `null`.
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
   * @returns {Promise} that resolves when restart is scheduled.
   */
  restart() {
    return this.applicationDelegate.invokeApp("restart");
  }
}

module.exports = ApplicationService;
