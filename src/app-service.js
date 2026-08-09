const getWindowLoadSettings = require("./get-window-load-settings");
const semver = require("semver");
const { getReleaseChannel } = require("./get-app-details");

// Public: Main-process application services exposed as serializable values.
class AppService {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
  }

  // Public: Return an Electron application path captured during bootstrap.
  //
  // * `name` A supported Electron application-path {String}.
  //
  // Returns the cached path {String} synchronously.
  getPath(name) {
    const paths = getWindowLoadSettings().appPaths || {};
    if (!Object.hasOwn(paths, name)) throw new Error(`Unsupported application path: ${name}`);
    return paths[name];
  }

  // Public: Return the application locale captured during bootstrap.
  //
  // Returns the cached locale {String} synchronously.
  getLocale() {
    return getWindowLoadSettings().appLocale;
  }

  // Public: Return the editor resource directory captured during bootstrap.
  //
  // Returns the absolute resource path {String} synchronously.
  getResourcePath() {
    return getWindowLoadSettings().resourcePath;
  }

  // Public: Return the full name of this Lumine application.
  //
  // Returns the application name {String} synchronously.
  getName() {
    return getWindowLoadSettings().appName;
  }

  // Public: Return the Lumine application version.
  //
  // Returns the version {String} synchronously.
  getVersion() {
    return getWindowLoadSettings().appVersion;
  }

  // Public: Determine whether the current application version satisfies a
  // semantic-version range.
  versionSatisfies(range) {
    const [version] = this.getVersion().split("-");
    return semver.satisfies(version, range);
  }

  // Public: Return the current release channel.
  getReleaseChannel() {
    return getReleaseChannel(this.getVersion());
  }

  // Public: Determine whether this build came from the release pipeline.
  isReleasedVersion() {
    return /stable|beta|rc|nightly/.test(this.getReleaseChannel());
  }

  // Public: Open paths in a new or reusable Lumine window.
  //
  // Returns immediately after the open request is sent to the main process.
  openWindow(params) {
    return this.applicationDelegate.open(params);
  }

  // Public: Read an operating-system user default.
  //
  // Returns a {Promise} resolving to a serializable preference value.
  getUserDefault(key, type) {
    return this.applicationDelegate.invokeApp("getUserDefault", key, type);
  }

  // Public: Determine whether Lumine is the default handler for a protocol.
  //
  // Returns a {Promise} resolving to a {Boolean}.
  isDefaultProtocolClient(protocol, path, args) {
    return this.applicationDelegate.invokeApp("isDefaultProtocolClient", protocol, path, args);
  }

  // Public: Register Lumine as the default handler for a protocol.
  //
  // Returns a {Promise} resolving to a {Boolean}.
  setAsDefaultProtocolClient(protocol, path, args) {
    return this.applicationDelegate.invokeApp("setAsDefaultProtocolClient", protocol, path, args);
  }

  // Public: Load an operating-system file icon as a data URL.
  //
  // Returns a {Promise} resolving to a data-URL {String}, or `null`.
  getFileIcon(filePath, options = {}) {
    return this.applicationDelegate.invokeApp("getFileIcon", filePath, options);
  }

  // Public: Restart Lumine with the current launch options.
  //
  // Returns a {Promise} that resolves when restart is scheduled.
  restart() {
    return this.applicationDelegate.invokeApp("restart");
  }
}

module.exports = AppService;
