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

  /**
   * @public
   * @status public
   *
   * Move an item to the operating system trash.
   *
   * @returns {Promise} that resolves when the operation completes.
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
   * @returns {Promise} that resolves when the request completes.
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
   * @returns {Promise} resolving to Electron's result string.
   */
  openPath(filePath) {
    return this.applicationDelegate.openPath(filePath);
  }

  /**
   * @public
   * @status public
   *
   * Open a URL with its operating system default handler.
   *
   * @returns {Promise} that resolves when the request completes.
   */
  openExternal(url) {
    return this.applicationDelegate.openExternalDirect(url);
  }
}

module.exports = ShellService;
