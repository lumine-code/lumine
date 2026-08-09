const getWindowLoadSettings = require("./get-window-load-settings");

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
