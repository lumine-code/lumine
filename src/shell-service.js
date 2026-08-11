/**
 * Operating-system shell integrations.
 *
 * @public
 * @api-status Public
 */
class ShellService {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
  }

  /**
   * Move an item to the operating system trash.
   *
   * @returns {Promise} that resolves when the operation completes.
   * @public
   * @api-status Public
   */
  trashItem(filePath) {
    return this.applicationDelegate.trashItem(filePath);
  }

  /**
   * Reveal a path in the operating system file browser.
   *
   * @returns {Promise} that resolves when the request completes.
   * @public
   * @api-status Public
   */
  showItemInFolder(filePath) {
    return this.applicationDelegate.showItemInFolder(filePath);
  }

  /**
   * Open a path with its operating system default application.
   *
   * @returns {Promise} resolving to Electron's result string.
   * @public
   * @api-status Public
   */
  openPath(filePath) {
    return this.applicationDelegate.openPath(filePath);
  }

  /**
   * Open a URL with its operating system default handler.
   *
   * @returns {Promise} that resolves when the request completes.
   * @public
   * @api-status Public
   */
  openExternal(url) {
    return this.applicationDelegate.openExternalDirect(url);
  }
}

module.exports = ShellService;
