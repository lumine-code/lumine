const { Emitter } = require("@lumine-code/event-kit");

let nextSelectBoxId = 0;

function normalizeItem(item) {
  if (item && typeof item === "object" && Object.hasOwn(item, "value")) {
    return {
      ...item,
      label: String(item.label ?? item.value ?? ""),
      disabled: Boolean(item.disabled),
    };
  }
  return { value: item, label: String(item ?? ""), disabled: false };
}

module.exports = class SelectBoxView {
  constructor(menuManager, options = {}) {
    this.menuManager = menuManager;
    this.options = options;
    this.items = (options.items ?? []).map(normalizeItem);
    this.selectedValue = options.value;
    this.enabled = options.disabled !== true;
    this.popup = null;
    this.activeIndex = -1;
    this.destroyed = false;
    this.typeahead = "";
    this.typeaheadTimer = null;
    this.emitter = new Emitter();
    this.id = `lumine-select-box-${++nextSelectBoxId}`;

    this.element = document.createElement("button");
    this.element.type = "button";
    this.element.classList.add("select-box");
    if (options.className) {
      this.element.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
    }
    this.element.id = options.id || this.id;
    this.element.setAttribute("role", "combobox");
    this.element.setAttribute("aria-haspopup", "listbox");
    this.element.setAttribute("aria-expanded", "false");
    this.element.setAttribute("aria-controls", `${this.id}-listbox`);
    if (options.ariaLabel) this.element.setAttribute("aria-label", options.ariaLabel);

    this.labelElement = document.createElement("span");
    this.labelElement.classList.add("select-box-label");
    this.arrowElement = document.createElement("span");
    this.arrowElement.classList.add("select-box-arrow");
    this.arrowElement.setAttribute("aria-hidden", "true");
    this.element.append(this.labelElement, this.arrowElement);
    this.element.addEventListener("click", (event) => {
      event.preventDefault();
      if (this.popup) this.close();
      else this.requestOpen();
    });
    this.element.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.setEnabled(this.enabled);
    if (!this.items.some((item) => Object.is(item.value, this.selectedValue))) {
      this.selectedValue = this.items.find((item) => !item.disabled)?.value;
    }
    this.renderValue();
  }

  get value() {
    return this.selectedValue;
  }

  set value(value) {
    this.setValue(value);
  }

  onDidChange(callback) {
    return this.emitter.on("did-change", callback);
  }

  onDidOpen(callback) {
    return this.emitter.on("did-open", callback);
  }

  onDidClose(callback) {
    return this.emitter.on("did-close", callback);
  }

  setItems(items, { value = this.selectedValue } = {}) {
    this.items = (items ?? []).map(normalizeItem);
    if (this.items.some((item) => Object.is(item.value, value))) {
      this.selectedValue = value;
    } else {
      this.selectedValue = this.items.find((item) => !item.disabled)?.value;
    }
    this.renderValue();
    if (this.popup) this.renderList();
  }

  setValue(value, { emit = false } = {}) {
    const index = this.items.findIndex((item) => Object.is(item.value, value));
    if (index < 0 || this.items[index].disabled) return false;
    const changed = !Object.is(this.selectedValue, value);
    this.selectedValue = value;
    this.renderValue();
    if (this.popup) this.updateActiveDescendant(index);
    if (changed && emit) {
      this.emitter.emit("did-change", { value, index, item: this.items[index] });
    }
    return changed;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.element.disabled = !this.enabled;
    this.element.classList.toggle("disabled", !this.enabled);
    this.element.setAttribute("aria-disabled", this.enabled ? "false" : "true");
    if (!this.enabled) this.close();
  }

  setAriaLabel(label) {
    this.element.setAttribute("aria-label", String(label));
  }

  renderValue() {
    const item = this.items.find((candidate) => Object.is(candidate.value, this.selectedValue));
    this.labelElement.textContent = item?.label ?? this.options.placeholder ?? "";
    this.element.title = item?.title ?? item?.label ?? "";
  }

  async open() {
    if (!this.enabled || this.destroyed || this.popup) return this.popup;
    if (this.openingPromise) return this.openingPromise;
    this.openingPromise = (async () => {
      this.element.setAttribute("aria-busy", "true");
      try {
        await this.options.onWillOpen?.(this);
      } finally {
        this.element.removeAttribute("aria-busy");
      }
      if (!this.enabled || this.destroyed || this.popup || !this.element.isConnected) return null;
      this.popup = this.menuManager.contextViewManager.show({
        anchor: this.options.popupAnchor ?? this.element,
        matchAnchorWidth: true,
        fixedPlacement: true,
        placement: "below",
        alignment: "start",
        className: "select-box-context-view",
        dismissBoundary: this.element,
        render: (surface) => {
          if (this.options.matchTriggerFontSize) {
            surface.style.fontSize = this.element.ownerDocument.defaultView.getComputedStyle(
              this.element,
            ).fontSize;
          }
          this.listElement = surface;
          this.renderList();
          surface.addEventListener("keydown", this.boundListKeyDown);
          return () => {
            surface.removeEventListener("keydown", this.boundListKeyDown);
            this.optionElements = null;
            this.listElement = null;
          };
        },
        focus: () => {
          this.activeIndex = this.indexForValue(this.selectedValue);
          if (this.activeIndex < 0 || this.items[this.activeIndex]?.disabled) {
            this.activeIndex = this.nextEnabledIndex(this.activeIndex, 1);
          }
          this.updateActiveDescendant(this.activeIndex, { focus: true });
        },
        onHide: ({ cancelled }) => {
          this.popup = null;
          this.element.setAttribute("aria-expanded", "false");
          this.element.removeAttribute("aria-activedescendant");
          this.listElement?.removeAttribute("aria-activedescendant");
          this.emitter.emit("did-close", { cancelled });
        },
      });
      this.element.setAttribute("aria-expanded", "true");
      this.emitter.emit("did-open");
      return this.popup;
    })();
    try {
      return await this.openingPromise;
    } finally {
      this.openingPromise = null;
    }
  }

  renderList() {
    if (!this.listElement) return;
    this.listElement.classList.add("select-box-list");
    this.listElement.id = `${this.id}-listbox`;
    this.listElement.setAttribute("role", "listbox");
    this.listElement.tabIndex = -1;
    this.optionElements = this.items.map((item, index) => {
      const option = document.createElement("div");
      option.classList.add("select-box-option");
      option.id = `${this.id}-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        Object.is(item.value, this.selectedValue) ? "true" : "false",
      );
      option.textContent = item.label;
      if (item.title) option.title = item.title;
      if (item.disabled) {
        option.classList.add("disabled");
        option.setAttribute("aria-disabled", "true");
      } else {
        option.addEventListener("mouseenter", () => this.updateActiveDescendant(index));
        option.addEventListener("mousedown", (event) => event.preventDefault());
        option.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.commitIndex(index);
        });
      }
      return option;
    });
    this.listElement.replaceChildren(...this.optionElements);
    this.activeIndex = this.indexForValue(this.selectedValue);
    if (this.activeIndex < 0 || this.items[this.activeIndex]?.disabled) {
      this.activeIndex = this.nextEnabledIndex(this.activeIndex, 1);
    }
    if (this.activeIndex >= 0) this.updateActiveDescendant(this.activeIndex);
    else {
      this.element.removeAttribute("aria-activedescendant");
      this.listElement.removeAttribute("aria-activedescendant");
    }
  }

  indexForValue(value) {
    return this.items.findIndex((item) => Object.is(item.value, value));
  }

  nextEnabledIndex(start, direction) {
    if (!this.items.length) return -1;
    let index = start;
    for (let attempts = 0; attempts < this.items.length; attempts++) {
      index = (index + direction + this.items.length) % this.items.length;
      if (!this.items[index].disabled) return index;
    }
    return -1;
  }

  updateActiveDescendant(index, { focus = false } = {}) {
    if (index < 0 || this.items[index]?.disabled) return;
    this.activeIndex = index;
    this.optionElements?.forEach((option, optionIndex) => {
      option.classList.toggle("active", optionIndex === index);
      option.setAttribute(
        "aria-selected",
        Object.is(this.items[optionIndex].value, this.selectedValue) ? "true" : "false",
      );
    });
    const option = this.optionElements?.[index];
    if (option) {
      this.element.setAttribute("aria-activedescendant", option.id);
      this.listElement?.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView?.({ block: "nearest" });
    }
    if (focus) this.listElement?.focus({ preventScroll: true });
  }

  commitIndex(index) {
    const item = this.items[index];
    if (!item || item.disabled) return false;
    const changed = this.setValue(item.value);
    this.close({ cancelled: false });
    this.element.focus({ preventScroll: true });
    if (changed) this.emitter.emit("did-change", { value: item.value, index, item });
    return changed;
  }

  selectRelative(direction, { emit = true } = {}) {
    const current = this.indexForValue(this.selectedValue);
    const index = this.nextEnabledIndex(
      current < 0 ? (direction > 0 ? -1 : 0) : current,
      direction,
    );
    if (index < 0) return false;
    return this.setValue(this.items[index].value, { emit });
  }

  selectNext(options) {
    return this.selectRelative(1, options);
  }

  selectPrevious(options) {
    return this.selectRelative(-1, options);
  }

  close({ cancelled = true } = {}) {
    return this.popup?.close({ cancelled }) ?? false;
  }

  focus() {
    this.element.focus();
  }

  onKeyDown(event) {
    if (!this.enabled) return;
    if (event.ctrlKey || event.metaKey || (event.altKey && !/^Arrow(?:Down|Up)$/.test(event.key))) {
      return;
    }
    let handled = true;
    if (this.popup) {
      handled = this.handleOpenKey(event);
    } else {
      switch (event.key) {
        case "ArrowDown":
          if (event.altKey) this.requestOpen();
          else this.selectNext();
          break;
        case "ArrowUp":
          if (event.altKey) this.requestOpen();
          else this.selectPrevious();
          break;
        case "Home":
          this.selectBoundary(1);
          break;
        case "End":
          this.selectBoundary(-1);
          break;
        case "Enter":
        case " ":
          this.requestOpen();
          break;
        default:
          handled = this.handleTypeahead(event.key, { commit: true });
      }
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  boundListKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.handleOpenKey(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  handleOpenKey(event) {
    switch (event.key) {
      case "ArrowDown":
        this.updateActiveDescendant(this.nextEnabledIndex(this.activeIndex, 1));
        return true;
      case "ArrowUp":
        this.updateActiveDescendant(this.nextEnabledIndex(this.activeIndex, -1));
        return true;
      case "Home":
      case "PageUp":
        this.updateActiveDescendant(this.firstEnabledIndex());
        return true;
      case "End":
      case "PageDown":
        this.updateActiveDescendant(this.lastEnabledIndex());
        return true;
      case "Enter":
      case " ":
        this.commitIndex(this.activeIndex);
        return true;
      case "Escape":
        this.close({ cancelled: true });
        this.element.focus({ preventScroll: true });
        return true;
      case "Tab":
        this.close({ cancelled: true });
        return false;
      default:
        return this.handleTypeahead(event.key, { commit: false });
    }
  }

  firstEnabledIndex() {
    return this.items.findIndex((item) => !item.disabled);
  }

  lastEnabledIndex() {
    return this.items.findLastIndex((item) => !item.disabled);
  }

  selectBoundary(direction) {
    const index = direction > 0 ? this.firstEnabledIndex() : this.lastEnabledIndex();
    if (index >= 0) this.setValue(this.items[index].value, { emit: true });
  }

  handleTypeahead(key, { commit }) {
    if (typeof key !== "string" || key.length !== 1 || /\s/.test(key)) return false;
    clearTimeout(this.typeaheadTimer);
    this.typeahead += key.toLocaleLowerCase();
    this.typeaheadTimer = setTimeout(() => {
      this.typeahead = "";
      this.typeaheadTimer = null;
    }, 700);
    const index = this.items.findIndex(
      (item) => !item.disabled && item.label.toLocaleLowerCase().startsWith(this.typeahead),
    );
    if (index < 0) return true;
    if (commit) this.setValue(this.items[index].value, { emit: true });
    else this.updateActiveDescendant(index);
    return true;
  }

  requestOpen() {
    void this.open().catch((error) => console.error("Unable to open select box", error));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.typeaheadTimer);
    this.close({ cancelled: true });
    this.element.remove();
    this.emitter.dispose();
  }
};

module.exports.normalizeItem = normalizeItem;
