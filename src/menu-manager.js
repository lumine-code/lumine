const path = require("path");
const _ = require("@lumine-code/underscore-plus");
const { ipcRenderer } = require("electron");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const MenuHelpers = require("./menu-helpers");
const ContextViewManager = require("./context-view-manager");

const buildMetadata = require("../package.json");
var platformMenu;
if (buildMetadata) {
  platformMenu = buildMetadata._lumineMenu && buildMetadata._lumineMenu.menu;
}

/**
 * @public
 * @status extended
 *
 * Provides a registry for menu items that you'd like to appear in the
 * application menu.
 *
 * An instance of this class is always available as the `lumine.menu` global.
 *
 * ## Menu Object Format
 *
 * Here is an example from Lumine's bundled
 * [tree-view](https://github.com/lumine-code/tree-view/blob/master/menus/main.json):
 *
 * ```json
 * [
 *   {
 *     "label": "View",
 *     "submenu": [
 *       { "label": "Toggle Tree View", "command": "tree-view:toggle" }
 *     ]
 *   },
 *   {
 *     "label": "Packages",
 *     "submenu": [
 *       {
 *         "label": "Tree View",
 *         "submenu": [
 *           { "label": "Focus", "command": "tree-view:toggle-focus" },
 *           { "label": "Toggle", "command": "tree-view:toggle" },
 *           { "label": "Reveal Active File", "command": "tree-view:reveal-active-file" },
 *           { "label": "Toggle Tree Side", "command": "tree-view:toggle-side" }
 *         ]
 *       }
 *     ]
 *   }
 * ]
 * ```
 *
 * A package declares its menu in a file under `menus/`, with the structure
 * above under a `menu` key:
 *
 * ```json
 * {
 *   "menu": [
 *     {
 *       "label": "View",
 *       "submenu": [
 *         { "label": "Toggle Tree View", "command": "tree-view:toggle" }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * See {@link #add} for more information about adding menus directly.
 */
module.exports = class MenuManager {
  constructor({ resourcePath, keymapManager, packageManager, platform = process.platform }) {
    this.resourcePath = resourcePath;
    this.keymapManager = keymapManager;
    this.packageManager = packageManager;
    this.platform = platform;
    this.initialized = false;
    this.pendingUpdateOperation = null;
    this.disposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.contextViewManager = null;
    this.template = [];
    // Top-level menus the platform file declares. They belong to the menu bar
    // rather than to whichever package fills them, so `unmerge` must not splice
    // one out when it empties. See {@link MenuHelpers.unmerge}.
    this.structuralIds = new Set();
    this.disposables.add(
      this.keymapManager.onDidLoadBundledKeymaps(() => this.loadPlatformItems()),
      this.packageManager.onDidActivateInitialPackages(() => this.sortPackagesMenu()),
    );
    // A package activated after startup — installed, re-enabled, or deferred
    // behind `activationCommands` — has already contributed its menus by the
    // time this fires, so the Packages menu can be put back in order.
    this.disposables.add(this.packageManager.onDidActivatePackage(() => this.sortPackagesMenu()));
  }

  initialize({ resourcePath }) {
    this.resourcePath = resourcePath;
    this.contextViewManager ??= new ContextViewManager();
    this.disposables.add(this.keymapManager.onDidReloadKeymap(() => this.update()));
    this.update();
    this.initialized = true;
  }

  destroy() {
    this.initialized = false;
    if (this.pendingUpdateOperation != null) {
      clearTimeout(this.pendingUpdateOperation);
      this.pendingUpdateOperation = null;
    }
    this.disposables.dispose();
    this.contextViewManager?.destroy();
    this.contextViewManager = null;
    this.emitter.dispose();
  }

  /**
   * @public
   * @status public
   *
   * Invoke `callback` whenever the canonical application-menu template or the
   * key bindings displayed beside its commands change.
   *
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  getTemplate() {
    return _.deepClone(this.template);
  }

  ensureContextViewManager() {
    this.contextViewManager ??= new ContextViewManager();
    return this.contextViewManager;
  }

  /**
   * @public
   * @status public
   *
   * Create an HTML application-menu bar bound to this manager's live template.
   *
   * @param {Object} options
   * @returns {Object} a disposable menu-bar controller and its `element`.
   */
  createMenuBar(options = {}) {
    const MenuBarView = require("./menu-bar-view");
    this.ensureContextViewManager();
    return new MenuBarView(this, options);
  }

  /**
   * @public
   * @status public
   *
   * Show a theme-aware HTML command menu at an element, pointer event, or rect.
   *
   * @param {Object} options
   * @returns {Object} a disposable popup controller.
   */
  showPopup(options = {}) {
    const { showMenuPopup } = require("./menu-view");
    return showMenuPopup(this.ensureContextViewManager(), options);
  }

  /**
   * @public
   * @status public
   *
   * Create a theme-aware single-choice control with an HTML listbox popup.
   *
   * @param {Object} options
   * @returns {Object} a disposable select-box controller and its `element`.
   */
  createSelectBox(options = {}) {
    const SelectBoxView = require("./select-box-view");
    this.ensureContextViewManager();
    return new SelectBoxView(this, options);
  }

  /**
   * @public
   * @status public
   *
   * Adds the given items to the application menu.
   *
   * ## Examples
   * ```javascript
   *   lumine.menu.add([
   *     {
   *       label: 'Hello'
   *       submenu : [{label: 'World!', id: 'World!', command: 'hello:world'}]
   *     }
   *   ]);
   * ```
   *
   * @param items - An `Array` of menu item `Objects` containing the keys:
   * @param items.label - The `String` menu label.
   * @param items.submenu - An optional `Array` of sub menu items.
   * @param items.command - An optional `String` command to trigger when the item is clicked.
   * @param items.id - (internal) A `String` containing the menu item's id.
   * @returns {Disposable} on which `.dispose()` can be called to remove the added menu items.
   */
  add(items) {
    items = _.deepClone(items);
    // The application menu has no positioning pass of its own — `sortMenuItems`
    // is the context menu's. Left in place these would reach Electron's
    // `Menu.buildFromTemplate`, which reads the same keys against `id` rather
    // than `command`, so an item could be moved by a rule Lumine never applied.
    // Stripped after the clone, so a package's own menu object is untouched.
    MenuHelpers.stripPositioningKeys(items);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.label == null) {
        continue; // TODO: Should we emit a warning here?
      }

      this.merge(this.template, item);
    }
    this.update();
    return new Disposable(() => this.remove(items));
  }

  remove(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this.unmerge(this.template, item);
    }
    return this.update();
  }

  clear() {
    this.template = [];
    return this.update();
  }

  // Should the binding for the given selector be included in the menu
  // commands.
  //
  // * `selector` A `String` selector to check.
  //
  // Returns a `Boolean`, true to include the selector, false otherwise.
  includeSelector(selector) {
    try {
      if (document.body.webkitMatchesSelector(selector)) {
        return true;
      }
    } catch {
      // Selector isn't valid
      return false;
    }
    // The simulated tree mirrors the real body's classes, and those change
    // under the editor's feet — a theme swap, `is-blurred`, a package adding
    // one. `update` builds one tree for the length of its pass and clears it
    // again; a call from anywhere else builds and discards its own. Caching it
    // across passes is what made a menu accelerator answer for the theme that
    // was active when the first menu was built.
    let element = this.testEditor ?? this.buildTestEditor();
    while (element) {
      if (element.webkitMatchesSelector(selector)) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  // Simulate an lumine-text-editor element attached to an lumine-workspace
  // element attached to a body element that has the same classes as the current
  // body element.
  buildTestEditor() {
    // Use new document so that custom elements don't actually get created
    const testDocument = document.implementation.createDocument(document.namespaceURI, "html");
    const testBody = testDocument.createElement("body");
    testBody.classList.add(...this.classesForElement(document.body));
    const testWorkspace = testDocument.createElement("lumine-workspace");
    let workspaceClasses = this.classesForElement(document.body.querySelector("lumine-workspace"));
    if (workspaceClasses.length === 0) {
      workspaceClasses = ["workspace"];
    }
    testWorkspace.classList.add(...workspaceClasses);
    testBody.appendChild(testWorkspace);
    const testEditor = testDocument.createElement("lumine-text-editor");
    testEditor.classList.add("editor");
    testWorkspace.appendChild(testEditor);
    return testEditor;
  }

  /**
   * @public
   * @status public
   *
   * Refreshes the currently visible menu.
   */
  update() {
    this.emitter.emit("did-change", this.getTemplate());
    if (!this.initialized) {
      return;
    }
    // Only macOS presents the application template in the main process. The
    // HTML menu bar on Windows and Linux reads `this.template` directly and
    // resolves displayed bindings when it opens.
    if (this.platform !== "darwin") return;
    if (this.pendingUpdateOperation != null) {
      clearTimeout(this.pendingUpdateOperation);
    }
    this.pendingUpdateOperation = setTimeout(() => {
      this.pendingUpdateOperation = null;
      const unsetKeystrokes = new Set();
      for (let binding of this.keymapManager.getKeyBindings()) {
        if (binding.command === "unset!") {
          unsetKeystrokes.add(binding.keystrokes);
        }
      }
      // A command is an arbitrary string out of a keymap file, so a plain
      // object would answer `constructor` and friends from `Object.prototype`:
      // the `== null` check below would not fire and `unshift` would run on
      // `Object`, throwing inside this timeout and killing every later update.
      // The main process needs its own guard as well — the prototype does not
      // survive the structured clone in `sendToBrowserProcess`, only the keys.
      const keystrokesByCommand = Object.create(null);
      // One simulated tree for the whole pass — every binding is measured
      // against the same body classes — and none of it kept afterwards.
      this.testEditor = this.buildTestEditor();
      try {
        for (let binding of this.keymapManager.getKeyBindings()) {
          if (!this.includeSelector(binding.selector)) {
            continue;
          }
          if (unsetKeystrokes.has(binding.keystrokes)) {
            continue;
          }
          if (this.platform === "darwin" && /^alt-(shift-)?.$/.test(binding.keystrokes)) {
            continue;
          }
          if (this.platform === "win32" && /^ctrl-alt-(shift-)?.$/.test(binding.keystrokes)) {
            continue;
          }
          if (keystrokesByCommand[binding.command] == null) {
            keystrokesByCommand[binding.command] = [];
          }
          keystrokesByCommand[binding.command].unshift(binding.keystrokes);
        }
      } finally {
        this.testEditor = null;
      }
      this.sendToBrowserProcess(this.template, keystrokesByCommand);
    }, 1);
  }

  loadPlatformItems() {
    let menu;
    if (platformMenu != null) {
      menu = platformMenu;
    } else {
      const menusDirPath = path.join(this.resourcePath, "menus");
      const platformMenuPath = fs.resolve(menusDirPath, process.platform, ["json", "jsonc"]);
      ({ menu } = CSON.readFileSync(platformMenuPath));
    }
    for (const item of menu) {
      if (item.label != null) {
        this.structuralIds.add(item.id != null ? item.id : MenuHelpers.normalizeLabel(item.label));
      }
    }
    return this.add(menu);
  }

  // Merges an item in a submenu aware way such that new items are always
  // appended to the bottom of existing menus where possible.
  merge(menu, item) {
    MenuHelpers.merge(menu, item);
  }

  unmerge(menu, item) {
    MenuHelpers.unmerge(menu, item, this.structuralIds);
  }

  sendToBrowserProcess(template, keystrokesByCommand) {
    if (this.platform !== "darwin") return;
    if (global.lumine?.isDestroying || global.lumine?.unloading) return;
    void ipcRenderer
      .invoke("lumine:window", "updateApplicationMenu", template, keystrokesByCommand)
      .catch((error) => {
        // The main process can unregister the window between this asynchronous
        // invocation leaving the renderer and its handler running. That race
        // is expected only during teardown; active-window failures still need
        // to remain visible.
        if (global.lumine?.isDestroying || global.lumine?.unloading) return;
        console.error(error);
      });
  }

  // Get an `Array` of `String` classes for the given element.
  classesForElement(element) {
    if (element && element.classList) {
      return Array.prototype.slice.apply(element.classList);
    } else {
      return [];
    }
  }

  sortPackagesMenu() {
    const packagesMenu = _.find(
      this.template,
      ({ id }) => MenuHelpers.normalizeLabel(id) === "Packages",
    );
    if (!(packagesMenu && packagesMenu.submenu != null)) {
      return;
    }
    // The platform file declares its own items and ends them with a separator;
    // everything past that separator is a package's contribution and is the
    // only part that sorts. Sorting the whole array would move the core items,
    // and a comparator that answers 0 for a separator is not a total order, so
    // the outcome would depend on the sort algorithm rather than on the menu.
    // Packages never add a separator to a core menu, so the last separator here
    // is always the platform file's.
    const start = packagesMenu.submenu.findLastIndex(({ type }) => type === "separator") + 1;
    const sorted = packagesMenu.submenu
      .slice(start)
      .sort((item1, item2) =>
        (MenuHelpers.normalizeLabel(item1.label) || "").localeCompare(
          MenuHelpers.normalizeLabel(item2.label) || "",
        ),
      );
    packagesMenu.submenu.splice(start, sorted.length, ...sorted);
    return this.update();
  }
};
