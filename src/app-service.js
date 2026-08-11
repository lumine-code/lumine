const getWindowLoadSettings = require("./get-window-load-settings");
const semver = require("semver");
const { getReleaseChannel } = require("./get-app-details");

/**
 * Main-process application services exposed as serializable values.
 *
 * @public
 * @api-status Public
 */
class AppService {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
  }

  /**
   * Return an Electron application path captured during bootstrap.
   *
   * @param {String} name - A supported Electron application-path name.
   * @returns {String} The cached path synchronously.
   * @public
   * @api-status Public
   */
  getPath(name) {
    const paths = getWindowLoadSettings().appPaths || {};
    if (!Object.hasOwn(paths, name)) throw new Error(`Unsupported application path: ${name}`);
    return paths[name];
  }

  /**
   * Return the application locale captured during bootstrap.
   *
   * @returns {String} The cached locale synchronously.
   * @public
   * @api-status Public
   */
  getLocale() {
    return getWindowLoadSettings().appLocale;
  }

  /**
   * Return the editor resource directory captured during bootstrap.
   *
   * @returns {String} The absolute resource path synchronously.
   * @public
   * @api-status Public
   */
  getResourcePath() {
    return getWindowLoadSettings().resourcePath;
  }

  /**
   * Return the full name of this Lumine application.
   *
   * @returns {String} The application name synchronously.
   * @public
   * @api-status Public
   */
  getName() {
    return getWindowLoadSettings().appName;
  }

  /**
   * Return the Lumine application version.
   *
   * @returns {String} The version synchronously.
   * @public
   * @api-status Public
   */
  getVersion() {
    return getWindowLoadSettings().appVersion;
  }

  /**
   * Determine whether the current application version satisfies a
   * semantic-version range.
   *
   * @param {String} range - A semantic-version range.
   * @returns {Boolean} Whether the current version satisfies the range.
   * @public
   * @api-status Public
   */
  versionSatisfies(range) {
    const [version] = this.getVersion().split("-");
    return semver.satisfies(version, range);
  }

  /**
   * Return the current release channel.
   *
   * @returns {String} The release channel.
   * @public
   * @api-status Public
   */
  getReleaseChannel() {
    return getReleaseChannel(this.getVersion());
  }

  /**
   * Determine whether this build came from the release pipeline.
   *
   * @returns {Boolean} Whether this is a released build.
   * @public
   * @api-status Public
   */
  isReleasedVersion() {
    return /stable|beta|rc|nightly/.test(this.getReleaseChannel());
  }

  /**
   * Open paths in a new or reusable Lumine window.
   *
   * The call returns immediately after sending the request to the main process.
   *
   * @param {Object} params - Paths and window options to open.
   * @public
   * @api-status Public
   */
  openWindow(params) {
    return this.applicationDelegate.open(params);
  }

  /**
   * Read an operating-system user default.
   *
   * @returns {Promise} resolving to a serializable preference value.
   * @public
   * @api-status Public
   */
  getUserDefault(key, type) {
    return this.applicationDelegate.invokeApp("getUserDefault", key, type);
  }

  /**
   * Determine whether Lumine is the default handler for a protocol.
   *
   * @returns {Promise} resolving to a `Boolean`.
   * @public
   * @api-status Public
   */
  isDefaultProtocolClient(protocol, path, args) {
    return this.applicationDelegate.invokeApp("isDefaultProtocolClient", protocol, path, args);
  }

  /**
   * Register Lumine as the default handler for a protocol.
   *
   * @returns {Promise} resolving to a `Boolean`.
   * @public
   * @api-status Public
   */
  setAsDefaultProtocolClient(protocol, path, args) {
    return this.applicationDelegate.invokeApp("setAsDefaultProtocolClient", protocol, path, args);
  }

  /**
   * Load an operating-system file icon as a data URL.
   *
   * @returns {Promise} resolving to a data-URL `String`, or `null`.
   * @public
   * @api-status Public
   */
  getFileIcon(filePath, options = {}) {
    return this.applicationDelegate.invokeApp("getFileIcon", filePath, options);
  }

  /**
   * Restart Lumine with the current launch options.
   *
   * @returns {Promise} that resolves when restart is scheduled.
   * @public
   * @api-status Public
   */
  restart() {
    return this.applicationDelegate.invokeApp("restart");
  }
}

module.exports = AppService;
