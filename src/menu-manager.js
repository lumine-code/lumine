const path = require("path");
const _ = require("@lumine-code/underscore-plus");
const { ipcRenderer } = require("electron");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { Disposable } = require("@lumine-code/event-kit");
const MenuHelpers = require("./menu-helpers");

const buildMetadata = require("../package.json");
var platformMenu;
if (buildMetadata) {
  platformMenu = buildMetadata._atomMenu && buildMetadata._atomMenu.menu;
}

// Extended: Provides a registry for menu items that you'd like to appear in the
// application menu.
//
// An instance of this class is always available as the `atom.menu` global.
//
// ## Menu Object Format
//
// Here is an example from Lumine's bundled
// [tree-view](https://github.com/lumine-code/tree-view/blob/master/menus/tree-view-plus.json):
//
// ```json
// [
//   {
//     "label": "View",
//     "submenu": [
//       { "label": "Toggle Tree View", "command": "tree-view:toggle" }
//     ]
//   },
//   {
//     "label": "Packages",
//     "submenu": [
//       {
//         "label": "Tree View",
//         "submenu": [
//           { "label": "Focus", "command": "tree-view:toggle-focus" },
//           { "label": "Toggle", "command": "tree-view:toggle" },
//           { "label": "Reveal Active File", "command": "tree-view:reveal-active-file" },
//           { "label": "Toggle Tree Side", "command": "tree-view:toggle-side" }
//         ]
//       }
//     ]
//   }
// ]
// ```
//
// A package declares its menu in a file under `menus/`, with the structure
// above under a `menu` key:
//
// ```json
// {
//   "menu": [
//     {
//       "label": "View",
//       "submenu": [
//         { "label": "Toggle Tree View", "command": "tree-view:toggle" }
//       ]
//     }
//   ]
// }
// ```
//
// See {::add} for more information about adding menus directly.
module.exports = class MenuManager {
  constructor({ resourcePath, keymapManager, packageManager }) {
    this.resourcePath = resourcePath;
    this.keymapManager = keymapManager;
    this.packageManager = packageManager;
    this.initialized = false;
    this.pendingUpdateOperation = null;
    this.template = [];
    // Top-level menus the platform file declares. They belong to the menu bar
    // rather than to whichever package fills them, so `unmerge` must not splice
    // one out when it empties. See {MenuHelpers.unmerge}.
    this.structuralIds = new Set();
    this.keymapManager.onDidLoadBundledKeymaps(() => this.loadPlatformItems());
    this.packageManager.onDidActivateInitialPackages(() => this.sortPackagesMenu());
    // A package activated after startup — installed, re-enabled, or deferred
    // behind `activationCommands` — has already contributed its menus by the
    // time this fires, so the Packages menu can be put back in order.
    this.packageManager.onDidActivatePackage(() => this.sortPackagesMenu());
  }

  initialize({ resourcePath }) {
    this.resourcePath = resourcePath;
    this.keymapManager.onDidReloadKeymap(() => this.update());
    this.update();
    this.initialized = true;
  }

  // Public: Adds the given items to the application menu.
  //
  // ## Examples
  // ```javascript
  //   atom.menu.add([
  //     {
  //       label: 'Hello'
  //       submenu : [{label: 'World!', id: 'World!', command: 'hello:world'}]
  //     }
  //   ]);
  // ```
  //
  // * `items` An {Array} of menu item {Object}s containing the keys:
  //   * `label` The {String} menu label.
  //   * `submenu` An optional {Array} of sub menu items.
  //   * `command` An optional {String} command to trigger when the item is
  //     clicked.
  //
  //   * `id` (internal) A {String} containing the menu item's id.
  // Returns a {Disposable} on which `.dispose()` can be called to remove the
  // added menu items.
  add(items) {
    items = _.deepClone(items);
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
  // * `selector` A {String} selector to check.
  //
  // Returns a {Boolean}, true to include the selector, false otherwise.
  includeSelector(selector) {
    try {
      if (document.body.webkitMatchesSelector(selector)) {
        return true;
      }
    } catch {
      // Selector isn't valid
      return false;
    }
    // Simulate an atom-text-editor element attached to an atom-workspace element attached
    // to a body element that has the same classes as the current body element.
    if (this.testEditor == null) {
      // Use new document so that custom elements don't actually get created
      const testDocument = document.implementation.createDocument(document.namespaceURI, "html");
      const testBody = testDocument.createElement("body");
      testBody.classList.add(...this.classesForElement(document.body));
      const testWorkspace = testDocument.createElement("atom-workspace");
      let workspaceClasses = this.classesForElement(document.body.querySelector("atom-workspace"));
      if (workspaceClasses.length === 0) {
        workspaceClasses = ["workspace"];
      }
      testWorkspace.classList.add(...workspaceClasses);
      testBody.appendChild(testWorkspace);
      this.testEditor = testDocument.createElement("atom-text-editor");
      this.testEditor.classList.add("editor");
      testWorkspace.appendChild(this.testEditor);
    }
    let element = this.testEditor;
    while (element) {
      if (element.webkitMatchesSelector(selector)) {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  // Public: Refreshes the currently visible menu.
  update() {
    if (!this.initialized) {
      return;
    }
    if (this.pendingUpdateOperation != null) {
      clearTimeout(this.pendingUpdateOperation);
    }
    this.pendingUpdateOperation = setTimeout(() => {
      const unsetKeystrokes = new Set();
      for (let binding of this.keymapManager.getKeyBindings()) {
        if (binding.command === "unset!") {
          unsetKeystrokes.add(binding.keystrokes);
        }
      }
      const keystrokesByCommand = {};
      for (let binding of this.keymapManager.getKeyBindings()) {
        if (!this.includeSelector(binding.selector)) {
          continue;
        }
        if (unsetKeystrokes.has(binding.keystrokes)) {
          continue;
        }
        if (process.platform === "darwin" && /^alt-(shift-)?.$/.test(binding.keystrokes)) {
          continue;
        }
        if (process.platform === "win32" && /^ctrl-alt-(shift-)?.$/.test(binding.keystrokes)) {
          continue;
        }
        if (keystrokesByCommand[binding.command] == null) {
          keystrokesByCommand[binding.command] = [];
        }
        keystrokesByCommand[binding.command].unshift(binding.keystrokes);
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
    ipcRenderer.send("update-application-menu", template, keystrokesByCommand);
  }

  // Get an {Array} of {String} classes for the given element.
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
