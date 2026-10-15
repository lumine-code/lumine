const path = require("path");
const _ = require("@lumine-code/underscore-plus");
const { ipcRenderer } = require("electron");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable, Disposable, Emitter } = require("@lumine-code/event-kit");
const MenuHelpers = require("./menu-helpers");
const ContextViewManager = require("./context-view-manager");
const { keyBindingsForTarget, resolveKeyBindingTarget } = require("./key-binding-helpers");
const menuLayout = require("./menu-layout");

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
 *       {
 *         "label": "Toggle View",
 *         "submenu": [{ "label": "Tree View", "command": "tree-view:toggle" }]
 *       }
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
 *         {
 *           "label": "Toggle View",
 *           "submenu": [{ "label": "Tree View", "command": "tree-view:toggle" }]
 *         }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * See {@link #add} for more information about adding menus directly.
 */
module.exports = class MenuManager {
  constructor({
    resourcePath,
    keymapManager,
    packageManager,
    commandRegistry,
    platform = process.platform,
  }) {
    this.resourcePath = resourcePath;
    this.keymapManager = keymapManager;
    this.packageManager = packageManager;
    this.commandRegistry = commandRegistry;
    this.platform = platform;
    this.initialized = false;
    this.pendingUpdateOperation = null;
    this.disposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.contextViewManager = null;
    this.contextViewManagers = new Map();
    this.nativeDocuments = new Map();
    this.nativeMenuSession = null;
    this.template = [];
    // Paths of the submenus declared by core. Keep their positions when the
    // last contributing package deactivates. See {@link MenuHelpers.unmerge}.
    this.structuralIds = new Set();
    this.coreLayouts = new Map();
    this.disposables.add(
      this.keymapManager.onDidLoadBundledKeymaps(() => this.loadPlatformItems()),
      this.packageManager.onDidActivateInitialPackages(() => this.sortPackageMenus()),
    );
    // A package activated after startup — for example after being installed or
    // re-enabled — has already contributed its menus by the time this fires,
    // so the shared package contribution lists can be put back in order.
    this.disposables.add(this.packageManager.onDidActivatePackage(() => this.sortPackageMenus()));
  }

  initialize({ resourcePath }) {
    this.resourcePath = resourcePath;
    this.ensureContextViewManager();
    this.disposables.add(this.keymapManager.onDidReloadKeymap(() => this.update()));
    this.disposables.add(this.keymapManager.onDidUnloadKeymap(() => this.update()));
    if (this.commandRegistry)
      this.disposables.add(this.commandRegistry.onDidChange(() => this.scheduleNativeUpdate()));
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
    for (const document of this.nativeDocuments.keys()) this.releaseNativeDocument(document);
    for (const manager of this.contextViewManagers.values()) manager.destroy();
    this.contextViewManagers.clear();
    this.contextViewManager = null;
    this.emitter.dispose();
  }

  /**
   * @category Event Subscription
   */

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
    const template = _.deepClone(this.template);
    const restoreCoreLayout = (items, parentPath = []) => {
      for (const item of items) {
        if (item.type === "separator") continue;
        const itemPath = [...parentPath, item.id ?? MenuHelpers.normalizeLabel(item.label)];
        const coreLayout = this.coreLayouts.get(JSON.stringify(itemPath));
        if (coreLayout) {
          for (const key of ["group", "order", "groupOrder", "sortBy"]) {
            if (Object.hasOwn(coreLayout, key)) item[key] = _.deepClone(coreLayout[key]);
            else delete item[key];
          }
        }
        if (item.submenu) restoreCoreLayout(item.submenu, itemPath);
      }
    };
    restoreCoreLayout(template);
    return menuLayout(template);
  }

  ensureContextViewManager(document = globalThis.document) {
    let manager = this.contextViewManagers.get(document);
    if (!manager) {
      manager = new ContextViewManager({ document });
      this.contextViewManagers.set(document, manager);
    }
    if (document === globalThis.document) this.contextViewManager = manager;
    return manager;
  }

  releaseDocument(document) {
    this.contextViewManagers.get(document)?.destroy();
    this.contextViewManagers.delete(document);
    this.releaseNativeDocument(document);
  }

  attachWorkspace(workspace) {
    this.workspace = workspace;
    if (this.platform !== "darwin") return;
    this.disposables.add(
      workspace.observeWindows((presentation) =>
        this.observeNativeDocument(presentation.getDocument()),
      ),
    );
    this.scheduleNativeUpdate();
  }

  observeNativeDocument(document) {
    if (!document || this.nativeDocuments.has(document)) return;
    const record = { target: this.focusTargetForDocument(document) };
    const didFocus = (event) => {
      if (event.target.closest?.("lumine-context-view, .menu-bar")) return;
      record.target = this.focusTargetForDocument(document, event.target);
      if (
        this.nativeMenuSession &&
        !this.nativeMenuSession.open &&
        (this.nativeMenuSession.document !== document ||
          this.nativeMenuSession.target !== record.target)
      )
        this.nativeMenuSession = null;
      this.nativeDocument = document;
      this.scheduleNativeUpdate();
    };
    const didFocusWindow = () => {
      if (
        this.nativeMenuSession &&
        !this.nativeMenuSession.open &&
        this.nativeMenuSession.document !== document
      )
        this.nativeMenuSession = null;
      this.nativeDocument = document;
      this.scheduleNativeUpdate();
    };
    const didBlurWindow = () => {
      if (!this.nativeMenuSession?.open) this.nativeMenuSession = null;
    };
    const didBlurTarget = () => {
      queueMicrotask(() => {
        if (
          !this.nativeDocuments.has(document) ||
          !document.hasFocus() ||
          this.nativeMenuSession?.open
        )
          return;
        const target = this.focusTargetForDocument(document);
        if (target?.closest?.("lumine-context-view, .menu-bar") || target === record.target) return;
        record.target = target;
        this.nativeMenuSession = null;
        this.scheduleNativeUpdate();
      });
    };
    document.addEventListener("focusin", didFocus, true);
    document.addEventListener("focusout", didBlurTarget, true);
    document.defaultView.addEventListener("focus", didFocusWindow);
    document.defaultView.addEventListener("blur", didBlurWindow);
    const observer = new document.defaultView.MutationObserver((mutations) => {
      if (!record.target?.isConnected) {
        record.target = this.focusTargetForDocument(document);
        this.scheduleNativeUpdate();
      } else if (
        mutations.some(
          (mutation) => mutation.type === "attributes" && mutation.target.contains(record.target),
        )
      )
        this.scheduleNativeUpdate();
    });
    observer.observe(document.body, { attributes: true, childList: true, subtree: true });
    record.dispose = () => {
      document.removeEventListener("focusin", didFocus, true);
      document.removeEventListener("focusout", didBlurTarget, true);
      document.defaultView.removeEventListener("focus", didFocusWindow);
      document.defaultView.removeEventListener("blur", didBlurWindow);
      observer.disconnect();
    };
    this.nativeDocuments.set(document, record);
  }

  releaseNativeDocument(document) {
    this.nativeDocuments.get(document)?.dispose();
    this.nativeDocuments.delete(document);
    if (this.nativeDocument === document) this.nativeDocument = null;
    if (this.nativeMenuSession?.document === document) this.nativeMenuSession = null;
  }

  focusTargetForDocument(document, target = document?.activeElement) {
    return target === document?.body
      ? (document.body.querySelector("lumine-workspace") ?? target)
      : target;
  }

  getNativeMenuTarget(document) {
    if (this.nativeMenuSession?.document === document) return this.nativeMenuSession.target;
    return this.nativeDocuments.get(document)?.target ?? this.focusTargetForDocument(document);
  }

  beginNativeMenu(document) {
    if (!document || this.nativeMenuSession?.open) return;
    this.nativeMenuSession = {
      document,
      target: this.nativeDocuments.get(document)?.target ?? this.focusTargetForDocument(document),
      open: true,
    };
  }

  endNativeMenu() {
    // Cocoa may deliver the selected command after menu-will-close. Keep its
    // original target until the command arrives or another session begins.
    if (this.nativeMenuSession) this.nativeMenuSession.open = false;
  }

  dispatchNativeMenuCommand(command, detail, { scope } = {}, document) {
    document = this.nativeMenuSession?.document ?? document;
    const target = this.getNativeMenuTarget(document);
    this.nativeMenuSession = null;
    if (!target?.isConnected || !MenuHelpers.matchesScope(target, scope)) return null;
    const commands = this.commandRegistry ?? globalThis.lumine?.commands;
    if (!commands?.canDispatch(target, command)) return null;
    return commands.dispatch(target, command, detail);
  }

  /**
   * @category Creating Menu Controls
   */

  /**
   * @public
   * @status public
   *
   * Create an HTML application-menu bar bound to this manager's live template.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.autoHide=false] - Show the menu bar only while it has focus.
   * @param {Boolean} [options.altGivesFocus=true] - Give the menu bar focus when Alt is pressed alone.
   * @param {Document} [options.document] - The document that owns the menu bar; defaults to the workspace document.
   * @returns {Object} a disposable menu-bar controller and its `element`.
   */
  createMenuBar(options = {}) {
    const MenuBarView = require("./menu-bar-view");
    this.ensureContextViewManager(options.document);
    return new MenuBarView(this, options);
  }

  /**
   * @public
   * @status public
   *
   * Show a theme-aware HTML command menu at an element, pointer event, or rect.
   *
   * @param {Object} [options]
   * @param {Array<Object>} options.template - The menu items to display.
   * @param {Element} [options.target] - The element that receives selected commands.
   * @param {Element|MouseEvent|Object} [options.anchor] - The element, pointer event, or rectangle used for popup positioning.
   * @param {String} [options.placement] - Popup placement relative to the anchor.
   * @param {String} [options.alignment] - Popup alignment along the anchor.
   * @param {Boolean} [options.autoSelectFirstItem=false] - Select the first enabled menu item when the popup opens.
   * @returns {Object} a disposable popup controller.
   */
  showPopup(options = {}) {
    const { showMenuPopup } = require("./menu-view");
    const document =
      options.target?.ownerDocument ??
      options.anchor?.ownerDocument ??
      options.anchor?.target?.ownerDocument ??
      globalThis.document;
    return showMenuPopup(this.ensureContextViewManager(document), options);
  }

  /**
   * @public
   * @status public
   *
   * Create a theme-aware single-choice control with an HTML listbox popup.
   *
   * @param {Object} [options]
   * @param {Array<*>} [options.items=[]] - Values or objects with `value`, `label`, and optional `disabled` fields.
   * @param {*} [options.value] - The selected value; defaults to the first enabled item when unmatched.
   * @param {Boolean} [options.disabled=false] - Disable the control.
   * @param {String} [options.className] - Additional CSS classes for the control.
   * @param {String} [options.id] - The control element ID; generated when omitted.
   * @param {String} [options.ariaLabel] - An accessible label for the control.
   * @returns {Object} a disposable select-box controller and its `element`.
   */
  createSelectBox(options = {}) {
    const SelectBoxView = require("./select-box-view");
    this.ensureContextViewManager();
    return new SelectBoxView(this, options);
  }

  /**
   * @category Managing Application Menu
   */

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
   *       label: 'Hello',
   *       submenu : [{label: 'World!', id: 'World!', command: 'hello:world'}]
   *     }
   *   ]);
   * ```
   *
   * @param {Array<Object>} items - An `Array` of menu item `Objects` containing the keys:
   * @param {String} items.label - The `String` menu label.
   * @param {Array} items.submenu - An optional `Array` of sub menu items.
   * @param {String} items.command - An optional `String` command to trigger when the item is clicked.
   * @param {String} items.scope - An optional CSS selector that must match the command target or an ancestor.
   * @param {String} items.commandTarget - `focus` or `context`; application-menu rows use the focus captured before opening.
   * @param {String} items.group - An optional group declared by the containing core menu; defaults to its extensions group.
   * @param {Number} items.order - An optional position within the group; items without a position follow ordered items.
   * @param {Array<String>} items.groupOrder - The ordered group names for a submenu the caller owns.
   * @param {String} items.sortBy - Set to `label` for an alphabetical list of surfaces; omit for an authored action sequence.
   * @param {String} items.id - (internal) A `String` containing the menu item's id.
   * @returns {Disposable} on which `.dispose()` can be called to remove the added menu items.
   */
  add(items) {
    items = _.deepClone(items);
    // Packages contribute configuration files under File on every platform.
    // macOS presents the same shared submenu under the application menu.
    if (this.platform === "darwin") {
      items = items.flatMap((item) => {
        if ((item.id ?? MenuHelpers.normalizeLabel(item.label)) !== "File" || !item.submenu)
          return [item];
        const configurations = item.submenu.filter(
          (child) =>
            (child.id ?? MenuHelpers.normalizeLabel(child.label)) === "Configuration Files",
        );
        if (configurations.length === 0) return [item];
        const remaining = item.submenu.filter((child) => !configurations.includes(child));
        return [
          ...(remaining.length > 0 ? [{ ...item, submenu: remaining }] : []),
          { label: "Lumine", submenu: configurations },
        ];
      });
    }
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

  prepareNativeTemplate(target) {
    const commands = this.commandRegistry ?? globalThis.lumine?.commands;
    const bindingsByTarget = new Map();
    const keystrokesForTarget = (bindingTarget) => {
      if (bindingsByTarget.has(bindingTarget)) return bindingsByTarget.get(bindingTarget);
      const byCommand = new Map();
      for (const binding of keyBindingsForTarget(this.keymapManager, bindingTarget)) {
        if (/^alt-(shift-)?.$/.test(binding.keystrokes)) continue;
        const keystrokes = byCommand.get(binding.command) ?? [];
        keystrokes.push(binding.keystrokes);
        byCommand.set(binding.command, keystrokes);
      }
      bindingsByTarget.set(bindingTarget, byCommand);
      return byCommand;
    };
    const prepare = (items) =>
      items.map((item) => {
        if (item.submenu) item.submenu = prepare(item.submenu);
        // Application commands and Electron roles are handled by the main
        // process. They do not require a renderer command registration.
        const native = item.role || /^application:/.test(item.command ?? "");
        item.enabled = MenuHelpers.isMenuItemEnabled(
          native ? { ...item, command: undefined } : item,
          target,
          commands,
        );
        const bindingCommand =
          item.keyBindingCommand !== undefined
            ? item.keyBindingCommand
            : item.commandDetail == null
              ? item.command
              : null;
        const bindingTarget = resolveKeyBindingTarget(item.keyBindingTarget, target, target);
        item.keystrokes =
          bindingCommand && bindingTarget && item.enabled
            ? [...(keystrokesForTarget(bindingTarget).get(bindingCommand) ?? [])]
            : [];
        // DOM elements and callback resolvers must never cross the IPC boundary.
        delete item.keyBindingTarget;
        delete item.keyBindingCommand;
        return item;
      });
    return prepare(this.getTemplate());
  }

  /**
   * @public
   * @status public
   *
   * Refreshes the currently visible menu.
   */
  update() {
    if (this.emitter.listenerCountForEventName("did-change") > 0) {
      this.emitter.emit("did-change", this.getTemplate());
    }
    this.scheduleNativeUpdate();
  }

  scheduleNativeUpdate() {
    // Only macOS presents the application template in the main process. The
    // HTML menu bar on Windows and Linux reads the same prepared snapshot and
    // resolves displayed bindings when it opens.
    if (!this.initialized || this.platform !== "darwin") return;
    if (this.pendingUpdateOperation != null) {
      clearTimeout(this.pendingUpdateOperation);
    }
    this.pendingUpdateOperation = setTimeout(() => {
      this.pendingUpdateOperation = null;
      const document = this.nativeMenuSession?.open
        ? this.nativeMenuSession.document
        : (this.workspace?.getFocusedWindow()?.getDocument() ??
          this.nativeDocument ??
          globalThis.document);
      const target = this.nativeMenuSession?.open
        ? this.nativeMenuSession.target
        : (this.nativeDocuments.get(document)?.target ?? this.focusTargetForDocument(document));
      this.sendToBrowserProcess(this.prepareNativeTemplate(target));
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
    const rememberSubmenus = (items, parentPath = []) => {
      for (const item of items) {
        if (item.type === "separator") continue;
        const id = item.id ?? MenuHelpers.normalizeLabel(item.label);
        const itemPath = [...parentPath, id];
        this.coreLayouts.set(
          JSON.stringify(itemPath),
          _.pick(item, "group", "order", "groupOrder", "sortBy"),
        );
        if (item.submenu) {
          this.structuralIds.add(itemPath.join("/"));
          rememberSubmenus(item.submenu, itemPath);
        }
      }
    };
    rememberSubmenus(menu);
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

  sendToBrowserProcess(template) {
    if (this.platform !== "darwin") return;
    if (global.lumine?.isDestroying || global.lumine?.unloading) return;
    void ipcRenderer.invoke("lumine:window", "updateApplicationMenu", template).catch((error) => {
      // The main process can unregister the window between this asynchronous
      // invocation leaving the renderer and its handler running. That race
      // is expected only during teardown; active-window failures still need
      // to remain visible.
      if (global.lumine?.isDestroying || global.lumine?.unloading) return;
      console.error(error);
    });
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

  sortPackageMenus() {
    this.sortPackagesMenu();
    const viewMenu = this.template.find(({ id }) => id === "View");
    for (const id of ["Toggle View", "Open or Focus View", "Editor"]) {
      const section = viewMenu?.submenu?.find((item) => item.id === id);
      section?.submenu?.sort((left, right) =>
        (MenuHelpers.normalizeLabel(left.label) || "").localeCompare(
          MenuHelpers.normalizeLabel(right.label) || "",
        ),
      );
    }
    return this.update();
  }
};
