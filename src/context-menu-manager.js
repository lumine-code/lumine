const path = require("path");
const CSON = require("@lumine-code/season");
const fs = require("@lumine-code/fs-plus");
const { calculateSpecificity, validateSelector } = require("./css-selectors");
const { Disposable } = require("@lumine-code/event-kit");
const MenuHelpers = require("./menu-helpers");
const { sortMenuItems } = require("./menu-sort-helpers");
const menuLayout = require("./menu-layout");

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
 * @public
 * @status extended
 *
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
 */
module.exports = class ContextMenuManager {
  constructor({ keymapManager, menuManager }) {
    this.keymapManager = keymapManager;
    this.menuManager = menuManager;
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
   * @public
   * @status public
   *
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
   *   'lumine-workspace': [{label: 'Help', command: 'application:open-documentation'}],
   *   'lumine-text-editor:not([mini])': [{
   *     label: 'History',
   *     submenu: [
   *       {label: 'Undo', command:'core:undo'},
   *       {label: 'Redo', command:'core:redo'}
   *     ]
   *   }]
   * })
   * ```
   *
   * A selector can also declare named groups. The nearest matching DOM element
   * supplies the group order; when several policies match that element, the
   * most specific selector wins, with the most recently added policy breaking
   * a tie. A context-menu boundary stops both item and policy inheritance.
   * Contributions from other selectors can join these groups without adding
   * separators. Unclassified items retain their existing separator blocks in
   * the `extensions` group.
   *
   * ```javascript
   * lumine.contextMenu.add({
   *   'lumine-text-editor:not([mini])': {
   *     groupOrder: ['history', 'clipboard', 'extensions'],
   *     items: [
   *       {label: 'Undo', command: 'core:undo', group: 'history', order: 10},
   *       {label: 'Redo', command: 'core:redo', group: 'history', order: 20},
   *       {label: 'Copy', command: 'core:copy', group: 'clipboard', order: 10}
   *     ]
   *   }
   * })
   * ```
   *
   * ## Arguments
   *
   * @param {Object} itemsBySelector - An `Object` whose keys are CSS selectors and whose values are item `Arrays` or `{items, groupOrder, sortBy}` descriptors. A descriptor's `groupOrder` lists named groups in display order; `sortBy: 'label'` sorts its items by label. Items contain the following keys:
   * @param {String} [itemsBySelector.label] - A `String` containing the menu item's label.
   * @param {String} [itemsBySelector.command] - A `String` containing the command to invoke on the target of the right click that invoked the context menu.
   * @param {String} [itemsBySelector.scope] - An additional CSS selector restricting this row to its command target or an ancestor. It never selects another target or command registration.
   * @param {String} [itemsBySelector.commandTarget] - Set to `focus` to dispatch at the element focused before the menu opened, or `context` to use the clicked element (the default). A selector descriptor and submenu may supply an inherited default.
   * @param {String} [itemsBySelector.keyBindingCommand] - An equivalent public command whose keyboard shortcut should be displayed. Use this for a contextual wrapper that preserves the same operation; behavior-changing command variants must not borrow a different action's shortcut.
   * @param {Element|Function} [itemsBySelector.keyBindingTarget] - The element used only to resolve the shortcut. A function is called with the invoking element as `this` and its first argument, matching tooltip target callbacks; return its editor or another binding scope, or `null` to suppress the shortcut. The selected command still dispatches to the original menu target.
   * @param {Boolean} [itemsBySelector.enabled] - A `Boolean` indicating whether the menu item should be clickable. Disabled menu items typically appear grayed out. Defaults to `true`.
   * @param {Array} [itemsBySelector.submenu] - An `Array` of additional items.
   * @param {String} [itemsBySelector.type] - If you want to create a separator, provide an item with `type: 'separator'` and no other keys.
   * @param {Boolean} [itemsBySelector.visible] - A `Boolean` indicating whether the menu item should appear in the menu. Defaults to `true`.
   * @param {String} [itemsBySelector.id] - A stable identifier for this item. Defaults to its normalized label. Give shared submenu contributions the same id so they merge into one item.
   * @param {String} [itemsBySelector.group] - The named group this item joins in the selected layout policy. Unknown or omitted groups join `extensions`.
   * @param {Number} [itemsBySelector.order] - The item's position within its named group. Lower numbers appear first; equal or omitted positions sort by label.
   * @param {Array<String>} [itemsBySelector.groupOrder] - Named groups for this item's submenu, in display order. Empty groups are omitted and surviving groups receive one separator between them.
   * @param {String} [itemsBySelector.sortBy] - Set to `'label'` to sort this item's submenu by label.
   * @param {Array} [itemsBySelector.before] - References to items that this item precedes. Strings name commands; objects such as `{ id: "terminal:tree-context" }` name item ids, including commandless submenu parents. These references merge the corresponding separator groups and order their items.
   * @param {Array} [itemsBySelector.after] - References to items that this item follows, using the same command-string or id-object format as `before`.
   * @param {Array} [itemsBySelector.beforeGroupContaining] - References to items whose whole separator group this item's group precedes. The first existing reference is used as a fallback anchor; only the first matching group rule applies within a group.
   * @param {Array} [itemsBySelector.afterGroupContaining] - References to items whose whole separator group this item's group follows, using the same reference format and fallback behavior as `beforeGroupContaining`. Group positioning preserves the separator between groups.
   * @param {Function} [itemsBySelector.created] - A `Function` that is called on the item each time a context menu is created via a right click. You can assign properties to `this` to dynamically compute the command, label, etc. This method is actually called on a clone of the original item template to prevent state from leaking across context menu deployments. Called with the following argument:
   * @param {MouseEvent} itemsBySelector.created.event - The click event that deployed the context menu.
   * @param {Function} [itemsBySelector.shouldDisplay] - A `Function` that is called to determine whether to display this item on a given context menu deployment. Called with the following argument:
   * @param {MouseEvent} itemsBySelector.shouldDisplay.event - The click event that deployed the context menu.
   * @param {Boolean} [throwOnInvalidSelector=true] - Throw for an invalid selector.
   * @returns {Disposable} Removes the added context-menu items.
   */
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

  templateForEvent(event, options = {}) {
    const focusTarget = Object.hasOwn(options, "focusTarget")
      ? options.focusTarget
      : this.focusTargetForEvent(event);
    const template = [];
    let layoutPolicy = null;
    let currentTarget = event.target;
    while (currentTarget != null) {
      const currentTargetItems = [];
      const matchingItemSets = this.itemSets.filter((itemSet) =>
        currentTarget.webkitMatchesSelector(itemSet.selector),
      );
      if (layoutPolicy === null) {
        let policyItemSet = null;
        for (const itemSet of matchingItemSets) {
          if (
            itemSet.layoutPolicy !== null &&
            (policyItemSet === null || itemSet.specificity >= policyItemSet.specificity)
          ) {
            policyItemSet = itemSet;
          }
        }
        if (policyItemSet !== null) layoutPolicy = policyItemSet.layoutPolicy;
      }
      for (let itemSet of matchingItemSets) {
        for (let item of itemSet.items) {
          const itemForEvent = this.cloneItemForEvent(item, event, itemSet.commandTarget);
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
    this.addAccelerators(template, event.target, focusTarget);
    // Build each layout from the filtered contributions. Named groups supply
    // their own separators; arrays retain their legacy positioning rules.
    // Rendering metadata is spent once sorting has read it.
    return MenuHelpers.stripPositioningKeys(this.sortTemplate(template, layoutPolicy));
  }

  // Resolve displayed key bindings at the element the command will target.
  // The HTML renderer receives one canonical label produced by
  // underscore-plus for both single strokes and chords.
  addAccelerators(template, target, focusTarget = target, bindingsByTarget = new Map()) {
    for (const item of template) {
      const commandTarget = item.commandTarget === "focus" ? focusTarget : target;
      const label = MenuHelpers.keyBindingLabelForMenuItem(
        item,
        commandTarget,
        this.keymapManager,
        target,
        bindingsByTarget,
      );
      if (label !== undefined) item.keyBindingLabel = label;
      // Resolve DOM references and callbacks in the invoking renderer. The
      // prepared template carries only the label, not those lookup resources.
      delete item.keyBindingCommand;
      delete item.keyBindingTarget;
      if (Array.isArray(item.submenu))
        this.addAccelerators(item.submenu, target, focusTarget, bindingsByTarget);
    }
  }

  sortTemplate(template, layoutPolicy) {
    return menuLayout(template, {
      ...layoutPolicy,
      sortItems: sortMenuItems,
      preserveUngrouped: true,
    });
  }

  // Returns an object compatible with `::add()` or `null`.
  cloneItemForEvent(item, event, commandTarget) {
    if (item.devMode && !this.devMode) {
      return null;
    }
    item = Object.create(item);
    if (item.commandTarget == null && commandTarget != null) item.commandTarget = commandTarget;
    if (typeof item.shouldDisplay === "function" && !item.shouldDisplay(event)) {
      return null;
    }
    if (typeof item.created === "function") {
      item.created(event);
    }
    if (Array.isArray(item.submenu)) {
      item.submenu = item.submenu
        .map((submenuItem) => this.cloneItemForEvent(submenuItem, event, item.commandTarget))
        .filter((submenuItem) => submenuItem !== null);
    }
    return item;
  }

  showForEvent(event) {
    const focusTarget = this.focusTargetForEvent(event);
    const menuTemplate = this.templateForEvent(event, { focusTarget });
    if (!(menuTemplate && menuTemplate.length > 0)) {
      return;
    }
    return this.show(event.target, menuTemplate, { anchor: event, focusTarget });
  }

  focusTargetForEvent(event) {
    const document = event.target?.ownerDocument ?? globalThis.document;
    const manager = this.menuManager.ensureContextViewManager?.(document);
    return manager ? manager.getFocusTarget(event) : document.activeElement;
  }

  /**
   * @public
   * @status public
   *
   * Show a theme-aware HTML context menu for a DOM target.
   *
   * @param {Element} target - The local DOM `Element` that receives selected commands.
   * @param {Array} menuTemplate - A menu-template `Array`.
   * @param {Object} [options] - Optional popup placement options, including `anchor`.
   * @param {Element|MouseEvent|Object} [options.anchor=target] - The element, pointer event, or rectangle used for popup positioning.
   * @param {String} [options.placement] - Popup placement relative to the anchor.
   * @param {String} [options.alignment] - Popup alignment along the anchor.
   * @param {Boolean} [options.autoSelectFirstItem=false] - Select the first enabled item when opening.
   * @returns {Object} the popup controller.
   */
  show(target, menuTemplate, options = {}) {
    return this.menuManager.showPopup({
      template: menuTemplate,
      target,
      contextTarget: target,
      focusTarget: Object.hasOwn(options, "focusTarget")
        ? options.focusTarget
        : target?.ownerDocument?.activeElement,
      anchor: options.anchor ?? target,
      placement: options.placement,
      alignment: options.alignment,
      autoSelectFirstItem: options.autoSelectFirstItem,
      className: "context-menu-popup",
    });
  }

  clear() {
    this.itemSets = [];
  }
};

var ContextMenuItemSet = class ContextMenuItemSet {
  constructor(selector, definition) {
    this.selector = selector;
    if (Array.isArray(definition)) {
      this.items = definition;
      this.layoutPolicy = null;
    } else {
      if (
        definition.commandTarget != null &&
        !["focus", "context"].includes(definition.commandTarget)
      ) {
        throw new TypeError("Context menu commandTarget must be 'focus' or 'context'");
      }
      this.items = definition.items;
      this.commandTarget = definition.commandTarget;
      this.layoutPolicy =
        definition.groupOrder !== undefined || definition.sortBy !== undefined
          ? { groupOrder: definition.groupOrder, sortBy: definition.sortBy }
          : null;
    }
    this.specificity = calculateSpecificity(this.selector);
  }
};
