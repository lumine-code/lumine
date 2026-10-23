const { normalizeExternalUrl } = require("./external-url");

/**
 * @public
 * @status public
 *
 * Operating-system shell integrations.
 */
class ShellService {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
  }

  /** @category File Operations */

  /**
   * @public
   * @status public
   *
   * Move an item to the operating system trash.
   *
   * @returns {Promise<void>} that resolves when the operation completes.
   * @param {String} filePath - The filesystem path to move to the trash.
   */
  trashItem(filePath) {
    return this.applicationDelegate.trashItem(filePath);
  }

  /**
   * @public
   * @status public
   *
   * Reveal a path in the operating system file browser.
   *
   * @returns {Promise<void>} that resolves when the request completes.
   * @param {String} filePath - The filesystem path to reveal.
   */
  showItemInFolder(filePath) {
    return this.applicationDelegate.showItemInFolder(filePath);
  }

  /**
   * @public
   * @status public
   *
   * Open a path with its operating system default application.
   *
   * Rejects when the path is unavailable, the system refuses the request, or
   * the operating-system request does not settle within 60 seconds. A timed-out
   * system operation may still complete later.
   *
   * @returns {Promise<void>} that resolves when the request completes.
   * @param {String} filePath - The filesystem path to open.
   */
  openPath(filePath) {
    return this.applicationDelegate.openPath(filePath);
  }

  /** @category Application Launching */

  /**
   * @public
   * @status public
   *
   * Launch a GUI application directly from the main process, independently of
   * the editor's lifetime. Arguments are passed literally without a shell.
   *
   * @param {String} executablePath - Absolute path to the application executable.
   * @param {Array<String>} [args] - Literal application arguments.
   * @param {Object} [options] - An optional absolute working directory in `cwd`.
   * @returns {Promise<Number>} resolving to the process ID when the application
   * starts, or rejecting if it cannot start. Window activation remains subject
   * to the operating system and the application's own behavior.
   */
  openApplication(executablePath, args = [], options = {}) {
    return this.applicationDelegate.openApplication(executablePath, args, options);
  }

  /** @category External URLs */

  /**
   * @public
   * @status public
   *
   * Open an HTTP, HTTPS, or mailto URL with its operating system default handler.
   *
   * Relative, malformed, and other-scheme URLs are rejected before they reach
   * the operating system. Requests that do not settle within 60 seconds reject;
   * the operating-system operation may still complete later.
   *
   * @returns {Promise<void>} that resolves when the request completes.
   * @param {String} url - An absolute HTTP, HTTPS, or mailto URL.
   */
  openExternal(url) {
    try {
      return this.applicationDelegate.openExternalDirect(normalizeExternalUrl(url));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

module.exports = ShellService;
