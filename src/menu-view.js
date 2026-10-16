const { Emitter } = require("@lumine-code/event-kit");
const changeAffectsTarget = require("./command-availability-change");
const {
  keyBindingLabelForMenuItem,
  isMenuItemEnabled,
  normalizeCommandTarget,
} = require("./menu-helpers");

const itemViewsByElement = new WeakMap();
const POINTER_SELECTION_DELAY = 250;

function parseMnemonic(label) {
  label = String(label ?? "");
  let text = "";
  let mnemonic = null;
  let mnemonicIndex = -1;
  for (let index = 0; index < label.length; index++) {
    const character = label[index];
    if (character !== "&") {
      text += character;
      continue;
    }
    if (label[index + 1] === "&") {
      text += "&";
      index++;
      continue;
    }
    if (mnemonic == null && label[index + 1]) {
      mnemonic = label[index + 1].toLocaleLowerCase();
      mnemonicIndex = text.length;
      continue;
    }
    text += character;
  }
  return { text, mnemonic, mnemonicIndex };
}

function renderMnemonic(element, label, enabled = true) {
  const parsed = parseMnemonic(label);
  element.replaceChildren();
  if (!enabled || parsed.mnemonicIndex < 0) {
    element.textContent = parsed.text;
    return parsed;
  }
  element.append(parsed.text.slice(0, parsed.mnemonicIndex));
  const underline = element.ownerDocument.createElement("u");
  underline.textContent = parsed.text[parsed.mnemonicIndex];
  element.appendChild(underline);
  element.append(parsed.text.slice(parsed.mnemonicIndex + 1));
  return parsed;
}

function usesFocusTarget(items) {
  return items.some(
    (item) => item.commandTarget === "focus" || (item.submenu && usesFocusTarget(item.submenu)),
  );
}

class MenuItemView {
  constructor(list, template) {
    this.list = list;
    this.popup = list.popup;
    this.template = template;
    this.commandTarget = this.popup.targetForItem(template);
    this.selected = false;
    this.open = false;
    this.visible = template.visible !== false;
    this.enabled = this.popup.isItemEnabled(template);
    this.separator = template.type === "separator";
    this.submenu = Array.isArray(template.submenu) ? template.submenu : null;
    this.element = this.popup.document.createElement(this.separator ? "hr" : "div");
    itemViewsByElement.set(this.element, this);

    if (this.separator) {
      this.element.classList.add("menu-separator");
      this.element.setAttribute("role", "separator");
      return;
    }

    this.element.classList.add("menu-item");
    const role =
      template.checked == null
        ? "menuitem"
        : template.type === "radio"
          ? "menuitemradio"
          : "menuitemcheckbox";
    this.element.setAttribute("role", role);
    this.element.tabIndex = -1;
    if (!this.enabled) {
      this.element.classList.add("disabled");
      this.element.setAttribute("aria-disabled", "true");
    }
    if (!this.visible) this.element.classList.add("invisible");
    if (template.checked != null) {
      this.element.classList.toggle("checked", Boolean(template.checked));
      this.element.setAttribute("aria-checked", template.checked ? "true" : "false");
    }

    this.nameElement = this.popup.document.createElement("span");
    this.nameElement.classList.add("menu-item-name");
    const label =
      template.label === "VERSION" ? `Version ${lumine.application.getVersion()}` : template.label;
    if (template.command === "application:reopen-project") {
      this.nameElement.textContent = label;
      this.mnemonic = null;
    } else {
      this.mnemonic = renderMnemonic(
        this.nameElement,
        label,
        this.popup.options.enableMnemonics !== false,
      ).mnemonic;
    }
    this.element.appendChild(this.nameElement);

    this.keystrokeElement = this.popup.document.createElement("span");
    this.keystrokeElement.classList.add("menu-item-keystroke");
    if (this.submenu) {
      this.element.classList.add("has-submenu");
      this.element.setAttribute("aria-haspopup", "menu");
      this.element.setAttribute("aria-expanded", "false");
    } else {
      this.keystrokeElement.textContent =
        template.keyBindingLabel ??
        keyBindingLabelForMenuItem(
          template,
          this.commandTarget,
          globalThis.lumine?.keymaps,
          this.popup.contextTarget,
          this.popup.bindingsByTarget,
        ) ??
        "";
    }
    this.element.appendChild(this.keystrokeElement);

    this.element.addEventListener("mouseenter", (event) =>
      this.list.onItemPointerEnter(this, event),
    );
    this.element.addEventListener("mouseleave", () => this.list.onItemPointerLeave(this));
    this.element.addEventListener("mousemove", (event) => event.stopPropagation());
    this.element.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !this.isNavigable()) return;
      this.popup.beginMouseSelection(this, event);
      event.preventDefault();
    });
    this.element.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (this.popup.consumeIgnoredClick()) return;
      this.activate();
    });
    if (template.command === "application:reopen-project" && template.commandDetail?.paths) {
      this.element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.removing) return;
        this.removing = true;
        this.removalPromise = Promise.resolve()
          .then(() => lumine.history.removeProject(template.commandDetail.paths))
          .then(
            () => {
              if (!this.popup.closed) this.list.removeItem(this);
            },
            (error) => {
              this.removing = false;
              console.error("Unable to remove recent project", error);
            },
          );
        void this.removalPromise;
      });
    }
  }

  isNavigable() {
    return this.visible && this.enabled && !this.separator;
  }

  setSelected(selected, { focus = false } = {}) {
    this.selected = selected;
    this.element.classList.toggle("selected", selected);
    if (selected && focus) this.element.focus({ preventScroll: true });
  }

  setOpen(open) {
    this.open = open;
    if (open && this.list.selectedItem === this) {
      this.setSelected(false);
      this.list.selectedItem = null;
      this.list.selectionSource = null;
    }
    this.element.classList.toggle("open", open);
    if (this.submenu) this.element.setAttribute("aria-expanded", open ? "true" : "false");
  }

  activate() {
    if (!this.isNavigable()) return;
    this.list.clearPointerSelectionTimer();
    if (this.submenu) {
      this.popup.openSubmenu(this, { selectFirst: true });
      return;
    }
    this.popup.execute(this);
  }
}

class MenuListView {
  constructor(popup, templates, { parentItem = null } = {}) {
    this.popup = popup;
    this.parentItem = parentItem;
    this.element = this.popup.document.createElement("div");
    this.element.classList.add("menu-box", "menu-popup-panel");
    this.element.setAttribute("role", "menu");
    this.element.tabIndex = -1;
    this.items = (templates || []).map((template) => new MenuItemView(this, template));
    for (const item of this.items) this.element.appendChild(item.element);
    this.selectedItem = null;
    this.selectionSource = null;
    this.pointerSelectionTimer = null;
    this.pointerSelectionItem = null;
    this.element.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.element.addEventListener("mouseleave", () => {
      this.clearPointerSelectionTimer();
      if (
        !this.popup.mouseSelecting &&
        !this.selectedItem?.open &&
        this.selectionSource === "pointer"
      ) {
        this.selectItem(null);
      }
    });
  }

  clearPointerSelectionTimer() {
    if (this.pointerSelectionTimer != null) {
      this.popup.window.clearTimeout(this.pointerSelectionTimer);
    }
    this.pointerSelectionTimer = null;
    this.pointerSelectionItem = null;
  }

  schedulePointerSelection(item) {
    if (!item.isNavigable()) return;
    this.clearPointerSelectionTimer();
    this.pointerSelectionItem = item;
    this.pointerSelectionTimer = this.popup.window.setTimeout(() => {
      this.pointerSelectionTimer = null;
      this.pointerSelectionItem = null;
      if (item.submenu) {
        this.popup.openSubmenu(item, { selectFirst: false });
      } else {
        this.selectItem(null);
        this.popup.closeSubmenusAfter(this);
      }
    }, POINTER_SELECTION_DELAY);
  }

  onItemPointerEnter(item, _event) {
    this.clearPointerSelectionTimer();
    if (!item.isNavigable()) return;
    this.schedulePointerSelection(item);
  }

  cancelPointerSelection(item) {
    if (this.pointerSelectionItem === item) this.clearPointerSelectionTimer();
  }

  onItemPointerLeave(item) {
    this.cancelPointerSelection(item);
    if (this.selectedItem === item && !item.open && this.selectionSource === "pointer") {
      this.selectItem(null);
    }
  }

  removeItem(item) {
    const index = this.items.indexOf(item);
    if (index < 0) return false;
    this.cancelPointerSelection(item);
    if (item.open) this.popup.closeSubmenusAfter(this);
    const focusWasInside = item.element.contains(this.popup.document.activeElement);
    if (this.selectedItem === item) {
      item.setSelected(false);
      this.selectedItem = null;
      this.selectionSource = null;
    }
    this.items.splice(index, 1);
    itemViewsByElement.delete(item.element);
    item.element.remove();
    if (focusWasInside) this.element.focus({ preventScroll: true });
    this.popup.positionOpenSubmenus();
    return true;
  }

  navigableItems() {
    return this.items.filter((item) => item.isNavigable());
  }

  selectItem(item, { focus = false } = {}) {
    if (item === this.selectedItem) {
      if (item && focus) {
        this.selectionSource = "keyboard";
        item.setSelected(true, { focus: true });
      }
      return;
    }
    this.selectedItem?.setSelected(false);
    this.selectedItem = item;
    this.selectionSource = item ? (focus ? "keyboard" : "pointer") : null;
    item?.setSelected(true, { focus });
  }

  selectAtOffset(offset) {
    const items = this.navigableItems();
    if (!items.length) return;
    const current = items.indexOf(this.selectedItem);
    const index =
      current < 0
        ? offset > 0
          ? 0
          : items.length - 1
        : (current + offset + items.length) % items.length;
    this.selectItem(items[index], { focus: true });
  }

  selectFirst() {
    const item = this.navigableItems()[0];
    if (item) this.selectItem(item, { focus: true });
    else this.element.focus({ preventScroll: true });
  }

  selectLast() {
    const items = this.navigableItems();
    const item = items[items.length - 1];
    if (item) this.selectItem(item, { focus: true });
    else this.element.focus({ preventScroll: true });
  }

  onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    this.clearPointerSelectionTimer();
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        this.selectAtOffset(1);
        break;
      case "ArrowUp":
        if (
          !this.parentItem &&
          this.selectedItem === this.navigableItems()[0] &&
          this.popup.options.onNavigateUpFromFirstItem
        ) {
          this.selectItem(null);
          this.popup.closeSubmenusAfter(this);
          this.popup.options.onNavigateUpFromFirstItem();
        } else {
          this.selectAtOffset(-1);
        }
        break;
      case "Home":
      case "PageUp":
        this.selectFirst();
        break;
      case "End":
      case "PageDown":
        this.selectLast();
        break;
      case "ArrowRight":
        if (this.selectedItem?.submenu) {
          this.popup.openSubmenu(this.selectedItem, { selectFirst: true });
        } else if (this.popup.options.onNavigateRight) {
          this.popup.options.onNavigateRight();
        } else {
          handled = false;
        }
        break;
      case "ArrowLeft":
        if (this.parentItem) this.popup.closeList(this);
        else if (this.popup.options.onNavigateLeft) this.popup.options.onNavigateLeft();
        else handled = false;
        break;
      case "Enter":
      case " ":
        this.selectedItem?.activate();
        break;
      case "Escape":
        this.popup.close({ cancelled: true });
        break;
      default: {
        if (event.key.length !== 1) {
          handled = false;
          break;
        }
        const mnemonic = event.key.toLocaleLowerCase();
        const matches = this.navigableItems().filter((item) => item.mnemonic === mnemonic);
        if (!matches.length) {
          handled = false;
          break;
        }
        const current = matches.indexOf(this.selectedItem);
        const item = matches[(current + 1) % matches.length];
        this.selectItem(item, { focus: true });
        if (matches.length === 1) item.activate();
        break;
      }
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  destroy() {
    this.clearPointerSelectionTimer();
    this.element.remove();
    this.items = [];
    this.selectedItem = null;
    this.selectionSource = null;
  }
}

class MenuPopup {
  constructor(contextViewManager, options) {
    this.contextViewManager = contextViewManager;
    this.document = contextViewManager.document;
    this.window = contextViewManager.window;
    this.options = options;
    const target = Object.hasOwn(options, "target") ? options.target : this.document.activeElement;
    this.commandTarget = normalizeCommandTarget(target, this.document);
    this.focusTarget = normalizeCommandTarget(
      Object.hasOwn(options, "focusTarget") ? options.focusTarget : this.document.activeElement,
      this.document,
    );
    this.contextTarget = normalizeCommandTarget(
      options.contextTarget ?? this.commandTarget,
      this.document,
    );
    this.bindingsByTarget = new Map();
    this.lists = [];
    this.emitter = new Emitter();
    this.closed = false;
    this.mouseSelecting = false;
    this.ignoreNextClick = false;
    this.boundMouseUp = (event) => this.endMouseSelection(event);
    this.tooltipSuspension = globalThis.lumine?.tooltips?.suspend(this.document);
    let popup = this;
    try {
      this.handle = contextViewManager.show({
        anchor: options.anchor ?? options.target,
        placement: options.placement,
        fixedPlacement: options.fixedPlacement,
        alignment: options.alignment,
        edgePadding: options.edgePadding,
        restoreFocusTarget:
          options.restoreFocusTarget ??
          (usesFocusTarget(options.template) ? this.focusTarget : undefined),
        dismissBoundary: options.dismissBoundary,
        className: ["menu-context-view", options.className].filter(Boolean).join(" "),
        onLayout: () => this.positionOpenSubmenus(),
        render(surface) {
          const rootList = new MenuListView(popup, options.template);
          popup.rootList = rootList;
          popup.lists.push(rootList);
          surface.classList.add("menu-box", "menu-popup-panel");
          surface.replaceChildren(...rootList.items.map((item) => item.element));
          rootList.element = surface;
          surface.setAttribute("role", "menu");
          surface.tabIndex = -1;
          surface.addEventListener("keydown", (event) => rootList.onKeyDown(event));
          surface.addEventListener("mouseleave", () => {
            if (!popup.mouseSelecting) rootList.selectItem(null);
          });
          return () => popup.disposeLists();
        },
        focus() {
          if (options.autoSelectFirstItem) popup.rootList.selectFirst();
          else popup.rootList.element.focus({ preventScroll: true });
        },
        onHide(closeEvent) {
          popup.finishClose(closeEvent);
        },
      });
    } catch (error) {
      this.tooltipSuspension?.dispose();
      throw error;
    }
    this.element = this.handle.element;
    this.availabilitySubscription = globalThis.lumine?.commands?.onDidChange?.((change) => {
      if (
        ![this.commandTarget, this.contextTarget, this.focusTarget].some((target) =>
          changeAffectsTarget(change, target),
        )
      )
        return;
      if (this.availabilityRefreshPending) return;
      this.availabilityRefreshPending = true;
      queueMicrotask(() => {
        this.availabilityRefreshPending = false;
        if (!this.closed) this.refreshAvailability();
      });
    });
  }

  onDidClose(callback) {
    return this.emitter.on("did-close", callback);
  }

  consumeIgnoredClick() {
    if (!this.ignoreNextClick) return false;
    this.ignoreNextClick = false;
    return true;
  }

  beginMouseSelection(item, event) {
    this.mouseSelecting = true;
    this.mouseOrigin = item;
    this.mouseStart = { x: event.clientX, y: event.clientY };
    this.window.addEventListener("mouseup", this.boundMouseUp, true);
  }

  endMouseSelection(event) {
    if (!this.mouseSelecting || event.button !== 0) return;
    this.window.removeEventListener("mouseup", this.boundMouseUp, true);
    const origin = this.mouseOrigin;
    const targetElement = this.document
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest?.(".menu-item");
    const target = targetElement ? itemViewsByElement.get(targetElement) : null;
    const moved =
      Math.abs(event.clientX - this.mouseStart.x) > 3 ||
      Math.abs(event.clientY - this.mouseStart.y) > 3;
    this.mouseSelecting = false;
    this.mouseOrigin = null;
    if (moved && target?.isNavigable()) {
      this.ignoreNextClick = true;
      target.activate();
    } else if (!target && moved) {
      this.close({ cancelled: true });
    } else if (origin) {
      origin.list.selectItem(origin, { focus: false });
    }
  }

  execute(item) {
    if (!item.isNavigable()) return;
    const { command, commandDetail } = item.template;
    const target = item.commandTarget;
    this.close({ cancelled: false, restoreFocus: true });
    if (!command) return;
    queueMicrotask(() => {
      if (!this.canExecuteItem(item)) return;
      try {
        lumine.commands.dispatch(target, command, commandDetail);
      } catch (error) {
        console.error(`Unable to dispatch menu command '${command}'`, error);
      }
    });
  }

  targetForItem(item) {
    if (item.commandTarget === "focus") return this.focusTarget;
    if (item.commandTarget === "context") return this.contextTarget;
    if (item.commandTarget != null) {
      throw new TypeError("Menu commandTarget must be 'focus' or 'context'");
    }
    return this.commandTarget;
  }

  isItemEnabled(template) {
    const target = this.targetForItem(template);
    if (template.command && !this.isTargetAvailable(target)) return false;
    if (!isMenuItemEnabled(template, target)) return false;
    return (
      !Array.isArray(template.submenu) ||
      template.submenu.some(
        (child) =>
          child.type !== "separator" && child.visible !== false && this.isItemEnabled(child),
      )
    );
  }

  canExecuteItem(item) {
    const enabled =
      this.isTargetAvailable(item.commandTarget) &&
      isMenuItemEnabled(item.template, item.commandTarget);
    if (!enabled) {
      item.enabled = false;
      item.element.classList.add("disabled");
      item.element.setAttribute("aria-disabled", "true");
    }
    return enabled;
  }

  isTargetAvailable(target) {
    return Boolean(target && (!target.nodeType || target.isConnected));
  }

  refreshAvailability() {
    for (const list of [...this.lists]) {
      if (!this.lists.includes(list)) continue;
      for (const item of list.items) {
        if (item.separator) continue;
        item.enabled = this.isItemEnabled(item.template);
        item.element.classList.toggle("disabled", !item.enabled);
        if (item.enabled) item.element.removeAttribute("aria-disabled");
        else {
          item.element.setAttribute("aria-disabled", "true");
          if (list.selectedItem === item) list.selectItem(null);
          if (item.open) {
            const hadFocus = this.element.contains(this.document.activeElement);
            this.closeSubmenusAfter(list);
            if (hadFocus) list.element.focus({ preventScroll: true });
          }
        }
      }
    }
  }

  openSubmenu(item, { selectFirst = false } = {}) {
    if (!item.submenu || !item.isNavigable()) return null;
    this.closeSubmenusAfter(item.list);
    if (item.open) {
      const current = this.lists[this.lists.indexOf(item.list) + 1];
      if (selectFirst) current?.selectFirst();
      return current;
    }
    item.setOpen(true);
    const list = new MenuListView(this, item.submenu, { parentItem: item });
    this.lists.push(list);
    this.element.appendChild(list.element);
    this.positionSubmenu(list, item);
    if (selectFirst) list.selectFirst();
    return list;
  }

  positionSubmenu(list, item) {
    const edgePadding = 8;
    const borderOverlap = 1;
    const itemRect = item.element.getBoundingClientRect();
    const parentMenuRect = item.list.element.getBoundingClientRect();
    const menuRect = list.element.getBoundingClientRect();
    let left = parentMenuRect.right - borderOverlap;
    if (left + menuRect.width > this.window.innerWidth - edgePadding) {
      left = parentMenuRect.left - menuRect.width + borderOverlap;
    }
    left = Math.max(edgePadding, left);
    let top = itemRect.top - 6;
    top = Math.max(
      edgePadding,
      Math.min(top, this.window.innerHeight - menuRect.height - edgePadding),
    );
    list.element.style.left = `${Math.round(left)}px`;
    list.element.style.top = `${Math.round(top)}px`;
    list.element.style.maxHeight = `${Math.max(1, this.window.innerHeight - edgePadding * 2)}px`;
    list.element.style.maxWidth = `${Math.max(1, this.window.innerWidth - edgePadding * 2)}px`;
  }

  positionOpenSubmenus() {
    for (let index = 1; index < this.lists.length; index++) {
      const list = this.lists[index];
      if (list.parentItem?.element.isConnected) this.positionSubmenu(list, list.parentItem);
    }
  }

  closeList(list) {
    const index = this.lists.indexOf(list);
    if (index <= 0) return;
    const parentItem = list.parentItem;
    this.removeListsFrom(index);
    parentItem?.setOpen(false);
    parentItem?.list.selectItem(parentItem, { focus: true });
  }

  closeSubmenusAfter(list) {
    const index = this.lists.indexOf(list);
    if (index < 0) return;
    this.removeListsFrom(index + 1);
    for (const item of list.items) {
      if (item.open) item.setOpen(false);
    }
  }

  removeListsFrom(index) {
    const removed = this.lists.splice(index);
    for (const list of removed.reverse()) {
      list.parentItem?.setOpen(false);
      list.destroy();
    }
  }

  close({ cancelled = false, restoreFocus = true } = {}) {
    return this.handle.close({ cancelled, restoreFocus });
  }

  finishClose({ cancelled, restoreFocus }) {
    if (this.closed) return;
    this.closed = true;
    this.availabilitySubscription?.dispose();
    this.bindingsByTarget.clear();
    this.window.removeEventListener("mouseup", this.boundMouseUp, true);
    this.tooltipSuspension?.dispose();
    this.emitter.emit("did-close", { cancelled, restoreFocus });
    this.emitter.dispose();
  }

  disposeLists() {
    this.removeListsFrom(0);
  }

  destroy() {
    this.close({ cancelled: true });
  }
}

function showMenuPopup(contextViewManager, options) {
  if (!Array.isArray(options?.template)) {
    throw new TypeError("Menu popup template must be an array");
  }
  return new MenuPopup(contextViewManager, options);
}

module.exports = {
  MenuPopup,
  MenuListView,
  MenuItemView,
  parseMnemonic,
  renderMnemonic,
  showMenuPopup,
};
