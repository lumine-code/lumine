// Public: Operating-system shell integrations.
class ShellService {
  constructor(applicationDelegate) {
    this.applicationDelegate = applicationDelegate;
  }

  // Public: Move an item to the operating system trash.
  //
  // Returns a {Promise} that resolves when the operation completes.
  trashItem(filePath) {
    return this.applicationDelegate.trashItem(filePath);
  }

  // Public: Reveal a path in the operating system file browser.
  //
  // Returns a {Promise} that resolves when the request completes.
  showItemInFolder(filePath) {
    return this.applicationDelegate.showItemInFolder(filePath);
  }

  // Public: Open a path with its operating system default application.
  //
  // Returns a {Promise} resolving to Electron's result string.
  openPath(filePath) {
    return this.applicationDelegate.openPath(filePath);
  }

  // Public: Open a URL with its operating system default handler.
  //
  // Returns a {Promise} that resolves when the request completes.
  openExternal(url) {
    return this.applicationDelegate.openExternalDirect(url);
  }
}

module.exports = ShellService;
