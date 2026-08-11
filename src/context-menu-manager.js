const path = require("path");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { calculateSpecificity, validateSelector } = require("./css-selectors");
const { Disposable } = require("@lumine-code/event-kit");
const MenuHelpers = require("./menu-helpers");
const { sortMenuItems } = require("./menu-sort-helpers");
const _ = require("@lumine-code/underscore-plus");

const buildMetadata = require("../package.json");
var platformContextMenu;
if (
  buildMetadata != null &&
  buildMetadata._lumineMenu != null &&
  buildMetadata._lumineMenu["context-menu"]
) {
  platformContextMenu = buildMetadata._lumineMenu["context-menu"];
}

/**
 * Provides a registry for commands that you'd like to appear in the
 * context menu.
 *
 * An instance of this class is always available as the `lumine.contextMenu`
 * global.
 *
 * ## Context Menu Object Format
 *
 * ```json
 * {
 *   "lumine-workspace": [
 *     { "label": "Help", "command": "application:open-documentation" }
 *   ],
 *   "lumine-text-editor": [
 *     {
 *       "label": "History",
 *       "submenu": [
 *         { "label": "Undo", "command": "core:undo" },
 *         { "label": "Redo", "command": "core:redo" }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * A package declares its context menu in a file under `menus/`, with the
 * structure above under a `context-menu` key:
 *
 * ```json
 * {
 *   "context-menu": {
 *     "lumine-workspace": [
 *       { "label": "Help", "command": "application:open-documentation" }
 *     ]
 *   }
 * }
 * ```
 *
 * The format for use in {@link #add} is the same minus the `context-menu` key. See
 * {@link #add} for more information.
 *
 * @public
 * @api-status Extended
 */
module.exports = class ContextMenuManager {
  constructor({ keymapManager, applicationDelegate }) {
    this.keymapManager = keymapManager;
    this.applicationDelegate = applicationDelegate;
    this.definitions = {};
    this.clear();
    this.keymapManager.onDidLoadBundledKeymaps(() => this.loadPlatformItems());
  }

  initialize({ resourcePath, devMode }) {
    this.resourcePath = resourcePath;
    this.devMode = devMode;
  }

  loadPlatformItems() {
    if (platformContextMenu != null) {
      return this.add(platformContextMenu, this.devMode || false);
    } else {
      const menusDirPath = path.join(this.resourcePath, "menus");
      const platformMenuPath = fs.resolve(menusDirPath, process.platform, ["json", "jsonc"]);
      const map = CSON.readFileSync(platformMenuPath);
      return this.add(map["context-menu"]);
    }
  }

  /**
   * Add context menu items scoped by CSS selectors.
   *
   * ## Examples
   *
   * To add a context menu, pass a selector matching the elements to which you
   * want the menu to apply as the top level key, followed by a menu descriptor.
   * The invocation below adds a global 'Help' context menu item and a 'History'
   * submenu on the editor supporting undo/redo. This is only an example and is
   * not how Lumine's menu is configured by default.
   *
   * ```javascript
   * lumine.contextMenu.add({
   *   'lumine-workspace': [{label: 'Help', command: 'application:open-documentation'}]
   *   'lumine-text-editor': [{
   *     label: 'History',
   *     submenu: [
   *       {label: 'Undo', command:'core:undo'}
   *       {label: 'Redo', command:'core:redo'}
   *     ]
   *   }]
   * })
   * ```
   *
   * ## Arguments
   *
   * @param itemsBySelector - An `Object` whose keys are CSS selectors and whose values are `Arrays` of item `Objects` containing the following keys:
   * @param [itemsBySelector.label] - A `String` containing the menu item's label.
   * @param [itemsBySelector.command] - A `String` containing the command to invoke on the target of the right click that invoked the context menu.
   * @param [itemsBySelector.enabled] - A `Boolean` indicating whether the menu item should be clickable. Disabled menu items typically appear grayed out. Defaults to `true`.
   * @param [itemsBySelector.submenu] - An `Array` of additional items.
   * @param [itemsBySelector.type] - If you want to create a separator, provide an item with `type: 'separator'` and no other keys.
   * @param [itemsBySelector.visible] - A `Boolean` indicating whether the menu item should appear in the menu. Defaults to `true`.
   * @param [itemsBySelector.created] - A `Function` that is called on the item each time a context menu is created via a right click. You can assign properties to `this` to dynamically compute the command, label, etc. This method is actually called on a clone of the original item template to prevent state from leaking across context menu deployments. Called with the following argument:
   * @param itemsBySelector.created.event - The click event that deployed the context menu.
   * @param [itemsBySelector.shouldDisplay] - A `Function` that is called to determine whether to display this item on a given context menu deployment. Called with the following argument:
   * @param itemsBySelector.shouldDisplay.event - The click event that deployed the context menu.
   * @public
   * @api-status Public
   */

  //   * `id` (internal) A `String` containing the menu item's id.
  // Returns a `Disposable` on which `.dispose()` can be called to remove the
  // added menu items.
  add(itemsBySelector, throwOnInvalidSelector = true) {
    const addedItemSets = [];
    for (let selector in itemsBySelector) {
      const items = itemsBySelector[selector];
      if (throwOnInvalidSelector) {
        validateSelector(selector);
      }
      const itemSet = new ContextMenuItemSet(selector, items);
      addedItemSets.push(itemSet);
      this.itemSets.push(itemSet);
    }
    return new Disposable(() => {
      for (let itemSet of addedItemSets) {
        this.itemSets.splice(this.itemSets.indexOf(itemSet), 1);
      }
    });
  }

  templateForElement(target) {
    return this.templateForEvent({ target });
  }

  templateForEvent(event) {
    const template = [];
    let currentTarget = event.target;
    while (currentTarget != null) {
      const currentTargetItems = [];
      const matchingItemSets = this.itemSets.filter((itemSet) =>
        currentTarget.webkitMatchesSelector(itemSet.selector),
      );
      for (let itemSet of matchingItemSets) {
        for (let item of itemSet.items) {
          const itemForEvent = this.cloneItemForEvent(item, event);
          if (itemForEvent) {
            MenuHelpers.merge(currentTargetItems, itemForEvent, itemSet.specificity);
          }
        }
      }
      for (let item of currentTargetItems) {
        MenuHelpers.merge(template, item, false);
      }
      // An element carrying `data-context-menu-boundary` owns its context
      // menu outright: an embedded surface — a result bubble, a rendered
      // widget — whose host's items would not apply inside it. Its own level
      // still contributes; nothing above it does. Selectors can otherwise
      // only add, so without this every embedded surface inherits its host's
      // entire menu.
      if (currentTarget.hasAttribute?.("data-context-menu-boundary")) {
        break;
      }
      currentTarget = currentTarget.parentElement;
    }
    this.pruneRedundantSeparators(template);
    this.addAccelerators(template);
    return this.sortTemplate(template);
  }

  // Adds an `accelerator` property to items that have key bindings. Electron
  // uses this property to surface the relevant keymaps in the context menu.
  addAccelerators(template) {
    for (let id in template) {
      const item = template[id];
      if (item.command) {
        const keymaps = this.keymapManager.findKeyBindings({
          command: item.command,
          target: document.activeElement,
        });
        const keystrokes = keymaps && keymaps[0] ? keymaps[0].keystrokes : undefined;
        if (keystrokes) {
          // Electron does not support multi-keystroke accelerators. Expose
          // them separately so the native menu path can render them next to
          // the item's label without polluting the label itself.
          if (keystrokes.includes(" ")) {
            item.multiKeystrokeLabel = _.humanizeKeystroke(keystrokes);
          } else {
            item.accelerator = MenuHelpers.acceleratorForKeystroke(keystrokes);
          }
        }
      }
      if (Array.isArray(item.submenu)) {
        this.addAccelerators(item.submenu);
      }
    }
  }

  pruneRedundantSeparators(menu) {
    let keepNextItemIfSeparator = false;
    let index = 0;
    while (index < menu.length) {
      if (menu[index].type === "separator") {
        if (!keepNextItemIfSeparator || index === menu.length - 1) {
          menu.splice(index, 1);
        } else {
          index++;
        }
      } else {
        keepNextItemIfSeparator = true;
        index++;
      }
    }
  }

  sortTemplate(template) {
    template = sortMenuItems(template);
    for (let id in template) {
      const item = template[id];
      if (Array.isArray(item.submenu)) {
        item.submenu = this.sortTemplate(item.submenu);
      }
    }
    return template;
  }

  // Returns an object compatible with `::add()` or `null`.
  cloneItemForEvent(item, event) {
    if (item.devMode && !this.devMode) {
      return null;
    }
    item = Object.create(item);
    if (typeof item.shouldDisplay === "function" && !item.shouldDisplay(event)) {
      return null;
    }
    if (typeof item.created === "function") {
      item.created(event);
    }
    if (Array.isArray(item.submenu)) {
      item.submenu = item.submenu
        .map((submenuItem) => this.cloneItemForEvent(submenuItem, event))
        .filter((submenuItem) => submenuItem !== null);
    }
    return item;
  }

  // The native menu cannot render multi-keystroke accelerators, so show the
  // keystrokes next to the item's label instead.
  appendMultiKeystrokeLabels(template) {
    for (const item of template) {
      if (item.multiKeystrokeLabel) {
        item.label += ` [${item.multiKeystrokeLabel}]`;
      }
      if (Array.isArray(item.submenu)) {
        this.appendMultiKeystrokeLabels(item.submenu);
      }
    }
  }

  showForEvent(event) {
    const menuTemplate = this.templateForEvent(event);
    if (!(menuTemplate && menuTemplate.length > 0)) {
      return;
    }
    this.appendMultiKeystrokeLabels(menuTemplate);
    return this.show(event.target, menuTemplate);
  }

  /**
   * Show a native context menu for a DOM target.
   *
   * @param target - The local DOM `Element` that receives selected commands.
   * @param menuTemplate - A serializable Electron menu-template `Array`; functions and native Electron objects are not allowed.
   * @returns {Promise} that resolves after the menu is shown.
   * @public
   * @api-status Public
   */
  show(target, menuTemplate) {
    this.activeElement = target;
    return this.applicationDelegate.showContextMenu(menuTemplate);
  }

  clear() {
    this.activeElement = null;
    this.itemSets = [];
  }
};

var ContextMenuItemSet = class ContextMenuItemSet {
  constructor(selector1, items1) {
    this.selector = selector1;
    this.items = items1;
    this.specificity = calculateSpecificity(this.selector);
  }
};
