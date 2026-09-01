const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const { parseMnemonic, renderMnemonic } = require("./menu-view");

module.exports = class MenuBarView {
  constructor(menuManager, { autoHide = false, altGivesFocus = true } = {}) {
    this.menuManager = menuManager;
    this.autoHide = Boolean(autoHide);
    this.altGivesFocus = altGivesFocus !== false;
    this.maxWidth = Infinity;
    this.buttons = [];
    this.overflowTemplates = [];
    this.pendingUpdate = false;
    this.popup = null;
    this.activeButton = null;
    this.previousFocus = null;
    this.temporarilyVisible = false;
    this.destroyed = false;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.element = document.createElement("div");
    this.element.classList.add("app-menu");
    this.element.setAttribute("role", "menubar");
    this.element.tabIndex = -1;
    this.overflowButton = this.createButton({ label: "…", submenu: [] }, { overflow: true });
    this.overflowButton.element.classList.add("overflow-menu-label", "overflowed");
    this.overflowButton.element.setAttribute("aria-label", "More application menus");
    this.element.appendChild(this.overflowButton.element);
    this.boundKeyDown = (event) => this.onKeyDown(event);
    this.boundKeyUp = (event) => this.onKeyUp(event);
    this.boundWheel = (event) => this.onWheel(event);
    this.boundFocusOut = (event) => this.onFocusOut(event);
    this.boundWindowClick = (event) => this.onWindowClick(event);
    document.body.addEventListener("keydown", this.boundKeyDown);
    document.body.addEventListener("keyup", this.boundKeyUp);
    document.body.addEventListener("wheel", this.boundWheel, { passive: true });
    window.addEventListener("click", this.boundWindowClick);
    this.element.addEventListener("focusout", this.boundFocusOut);
    this.subscriptions.add(menuManager.onDidChange(() => this.scheduleUpdate()));
    this.renderTemplate();
    this.syncAutoHide();
  }

  onDidChangeLayout(callback) {
    return this.emitter.on("did-change-layout", callback);
  }

  currentTemplate() {
    return this.menuManager.getTemplate();
  }

  scheduleUpdate() {
    if (this.popup || this.element.contains(document.activeElement)) {
      this.pendingUpdate = true;
      return;
    }
    this.renderTemplate();
  }

  applyPendingUpdate() {
    if (!this.pendingUpdate || this.popup || this.element.contains(document.activeElement)) return;
    this.pendingUpdate = false;
    this.renderTemplate();
  }

  renderTemplate() {
    if (this.destroyed) return;
    for (const button of this.buttons) button.element.remove();
    this.buttons = [];
    const template = this.currentTemplate();
    for (const item of template) {
      if (!item || typeof item.label !== "string" || !Array.isArray(item.submenu)) continue;
      const button = this.createButton(item);
      this.buttons.push(button);
      this.element.insertBefore(button.element, this.overflowButton.element);
    }
    this.layout(this.maxWidth);
    this.emitter.emit("did-change-layout");
  }

  createButton(template, { overflow = false } = {}) {
    const element = document.createElement("div");
    element.classList.add("menu-label");
    element.setAttribute("role", "menuitem");
    element.setAttribute("aria-haspopup", "menu");
    element.setAttribute("aria-expanded", "false");
    element.tabIndex = -1;
    const parsed = renderMnemonic(element, template.label, true);
    const button = { element, template, mnemonic: parsed.mnemonic, overflow };
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
    });
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleButton(button, { selectFirst: false });
    });
    element.addEventListener("mouseenter", () => {
      if (this.popup && button !== this.activeButton)
        this.openButton(button, { selectFirst: false });
    });
    element.addEventListener("keydown", (event) => this.onButtonKeyDown(button, event));
    return button;
  }

  templateForButton(button) {
    if (!button.overflow) return button.template.submenu;
    return this.overflowTemplates.map((item) => ({
      label: parseMnemonic(item.label).text,
      submenu: item.submenu,
    }));
  }

  toggleButton(button, options) {
    if (this.popup && button === this.activeButton) {
      this.blur();
      return;
    }
    this.openButton(button, options);
  }

  openButton(button, { selectFirst = false } = {}) {
    const template = this.templateForButton(button);
    if (!template?.length) return;
    this.beginSession();
    const generation = (this.popupGeneration ?? 0) + 1;
    this.popupGeneration = generation;
    this.popup?.close({ cancelled: true, restoreFocus: false });
    for (const candidate of [...this.buttons, this.overflowButton]) {
      candidate.element.classList.remove("focused");
    }
    this.activeButton?.element.classList.remove("open");
    this.activeButton?.element.setAttribute("aria-expanded", "false");
    this.activeButton = button;
    button.element.classList.add("open");
    button.element.setAttribute("aria-expanded", "true");
    button.element.focus({ preventScroll: true });
    this.setTemporarilyVisible(true);
    const popup = this.menuManager.showPopup({
      template,
      anchor: button.element,
      dismissBoundary: button.element,
      placement: "below",
      fixedPlacement: true,
      alignment: "start",
      autoSelectFirstItem: selectFirst,
      enableMnemonics: true,
      className: "application-menu-popup",
      onNavigateLeft: () => this.openAdjacentButton(-1),
      onNavigateRight: () => this.openAdjacentButton(1),
      onNavigateUpFromFirstItem: () => this.focusActiveButton(),
    });
    this.popup = popup;
    popup.onDidClose(({ restoreFocus }) => {
      if (this.popupGeneration !== generation) return;
      this.popup = null;
      this.activeButton?.element.classList.remove("open");
      this.activeButton?.element.setAttribute("aria-expanded", "false");
      this.activeButton = null;
      for (const candidate of [...this.buttons, this.overflowButton]) {
        candidate.element.classList.remove("focused");
      }
      this.element.classList.remove("focused", "alt-down");
      this.setTemporarilyVisible(false);
      this.applyPendingUpdate();
      this.endSession({
        restoreFocus: restoreFocus !== false && this.element.contains(document.activeElement),
      });
    });
  }

  openAdjacentButton(offset) {
    const buttons = this.visibleButtons();
    const index = buttons.indexOf(this.activeButton);
    if (index < 0 || buttons.length < 2) return;
    this.openButton(buttons[(index + offset + buttons.length) % buttons.length], {
      selectFirst: false,
    });
  }

  visibleButtons() {
    return [
      ...this.buttons.filter((button) => !button.element.classList.contains("overflowed")),
      ...(this.overflowTemplates.length ? [this.overflowButton] : []),
    ];
  }

  focus() {
    const button = this.visibleButtons()[0];
    if (!button) return false;
    this.beginSession();
    this.setTemporarilyVisible(true);
    this.element.classList.add("focused");
    button.element.classList.add("focused");
    button.element.focus({ preventScroll: true });
    return true;
  }

  blur() {
    const focusWasOwned =
      this.element.contains(document.activeElement) ||
      Boolean(this.popup?.element.contains(document.activeElement));
    this.popupGeneration = (this.popupGeneration ?? 0) + 1;
    this.popup?.close({ cancelled: true, restoreFocus: false });
    this.popup = null;
    for (const button of [...this.buttons, this.overflowButton]) {
      button.element.classList.remove("open", "focused");
      button.element.setAttribute("aria-expanded", "false");
    }
    this.activeButton = null;
    this.element.classList.remove("focused", "alt-down");
    this.setTemporarilyVisible(false);
    this.applyPendingUpdate();
    this.endSession({ restoreFocus: focusWasOwned });
  }

  beginSession() {
    if (this.previousFocus?.isConnected) return;
    const activeElement = document.activeElement;
    if (
      activeElement &&
      activeElement !== document.body &&
      !this.element.contains(activeElement) &&
      !this.popup?.element.contains(activeElement)
    ) {
      this.previousFocus = activeElement;
    }
  }

  endSession({ restoreFocus = true } = {}) {
    const previousFocus = this.previousFocus;
    this.previousFocus = null;
    if (!restoreFocus || !previousFocus?.isConnected || typeof previousFocus.focus !== "function") {
      return;
    }
    try {
      previousFocus.focus({ preventScroll: true });
    } catch {
      previousFocus.focus();
    }
  }

  onButtonKeyDown(button, event) {
    const buttons = this.visibleButtons();
    const index = buttons.indexOf(button);
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
        this.focusButton(buttons[(index - 1 + buttons.length) % buttons.length]);
        break;
      case "ArrowRight":
        this.focusButton(buttons[(index + 1) % buttons.length]);
        break;
      case "ArrowDown":
      case "Enter":
      case " ":
        this.openButton(button, { selectFirst: true });
        break;
      case "Escape":
        this.blur();
        break;
      default: {
        const mnemonicButton =
          !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey
            ? this.buttonForMnemonic(event.key)
            : null;
        if (!mnemonicButton) {
          handled = false;
          break;
        }
        this.altPressedAlone = false;
        this.openButton(mnemonicButton, { selectFirst: true });
        break;
      }
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  focusButton(button) {
    if (!button) return;
    for (const candidate of this.visibleButtons())
      candidate.element.classList.toggle("focused", candidate === button);
    button.element.focus({ preventScroll: true });
    if (this.popup) this.openButton(button, { selectFirst: false });
  }

  focusActiveButton() {
    if (!this.activeButton) return false;
    for (const candidate of this.visibleButtons()) {
      candidate.element.classList.toggle("focused", candidate === this.activeButton);
    }
    this.element.classList.add("focused");
    this.activeButton.element.focus({ preventScroll: true });
    return true;
  }

  buttonForMnemonic(key) {
    if (typeof key !== "string" || key.length !== 1) return null;
    const mnemonic = key.toLocaleLowerCase();
    return this.visibleButtons().find((candidate) => candidate.mnemonic === mnemonic) ?? null;
  }

  onKeyDown(event) {
    if (event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      this.altPressedAlone = true;
      this.element.classList.add("alt-down");
      if (this.altGivesFocus || this.autoHide) event.preventDefault();
      return;
    }
    if (event.key !== "Alt") this.altPressedAlone = false;
  }

  onKeyUp(event) {
    if (event.key !== "Alt") return;
    this.element.classList.remove("alt-down");
    if (this.altPressedAlone && this.altGivesFocus) this.focus();
    this.altPressedAlone = false;
  }

  onWheel(event) {
    if (event.altKey) this.altPressedAlone = false;
  }

  onFocusOut(event) {
    if (this.popup || this.element.contains(event.relatedTarget)) return;
    requestAnimationFrame(() => {
      if (!this.popup && !this.element.contains(document.activeElement)) this.blur();
    });
  }

  onWindowClick(event) {
    if (this.element.contains(event.target) || this.popup?.element.contains(event.target)) return;
    this.blur();
  }

  setTemporarilyVisible(visible) {
    this.temporarilyVisible = Boolean(visible);
    this.syncAutoHide();
  }

  reveal() {
    this.setTemporarilyVisible(true);
  }

  syncAutoHide() {
    this.element.classList.toggle("no-menu-bar", this.autoHide && !this.temporarilyVisible);
  }

  setAutoHide(autoHide) {
    this.autoHide = Boolean(autoHide);
    if (this.autoHide) this.temporarilyVisible = false;
    this.syncAutoHide();
  }

  setAltGivesFocus(altGivesFocus) {
    this.altGivesFocus = altGivesFocus !== false;
  }

  layout(availableWidth = Infinity) {
    this.maxWidth = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : Infinity;
    for (const button of this.buttons) button.element.classList.remove("overflowed");
    this.overflowButton.element.classList.add("overflowed");
    this.overflowTemplates = [];
    if (!Number.isFinite(this.maxWidth)) return this.buttons.length;

    const widths = this.buttons.map((button) => button.element.getBoundingClientRect().width);
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total <= this.maxWidth) return this.buttons.length;
    this.overflowButton.element.classList.remove("overflowed");
    const overflowWidth = this.overflowButton.element.getBoundingClientRect().width;
    let used = overflowWidth;
    let visibleCount = 0;
    for (const width of widths) {
      if (used + width > this.maxWidth) break;
      used += width;
      visibleCount++;
    }
    this.buttons.forEach((button, index) =>
      button.element.classList.toggle("overflowed", index >= visibleCount),
    );
    this.overflowTemplates = this.buttons.slice(visibleCount).map((button) => button.template);
    return visibleCount;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.blur();
    this.subscriptions.dispose();
    document.body.removeEventListener("keydown", this.boundKeyDown);
    document.body.removeEventListener("keyup", this.boundKeyUp);
    document.body.removeEventListener("wheel", this.boundWheel);
    window.removeEventListener("click", this.boundWindowClick);
    this.element.removeEventListener("focusout", this.boundFocusOut);
    this.element.remove();
    this.emitter.dispose();
  }
};
