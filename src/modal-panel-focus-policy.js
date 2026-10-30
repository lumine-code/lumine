"use strict";

const { createFocusTrap } = require("focus-trap");
const { isWindowControlTarget } = require("./window-control-target");

const INTERACTIVE =
  "input, textarea, select, button, a[href], [tabindex], [contenteditable], lumine-text-editor";

// A modal owns its DOM and portals explicitly opened by controls in that DOM.
// Window blur is never a dismissal; only a current, same-document departure is.
module.exports = class ModalPanelFocusPolicy {
  constructor({
    panel,
    initialFocus,
    focusQuery,
    canDismiss = () => false,
    isPending = () => false,
    dismiss,
    trapFocus = true,
    contextViews,
  }) {
    this.panel = panel;
    this.element = panel.getElement();
    this.document = this.element.ownerDocument;
    this.contextViews =
      contextViews ?? globalThis.lumine?.menu?.ensureContextViewManager(this.document);
    this.focusQuery = focusQuery;
    this.canDismiss = canDismiss;
    this.isPending = isPending;
    this.dismiss = dismiss;
    this.generation = 0;
    this.active = false;
    if (!this.element.hasAttribute("tabindex")) this.element.tabIndex = -1;
    this.focusTrap = trapFocus
      ? createFocusTrap(this.element, {
          document: this.document,
          fallbackFocus: this.element,
          ...(initialFocus ? { initialFocus } : {}),
          escapeDeactivates: false,
          // Owned listboxes and menus close/navigate themselves before returning
          // Tab to the trigger. Capture-phase trapping must not run ahead of them.
          isKeyForward: (event) =>
            event.key === "Tab" &&
            !event.shiftKey &&
            !this.contextViews?.containsOwnedElement(this.element, event.target),
          isKeyBackward: (event) =>
            event.key === "Tab" &&
            event.shiftKey &&
            !this.contextViews?.containsOwnedElement(this.element, event.target),
          clickOutsideDeactivates: (event) =>
            this.canDismiss() && this.isPointerOutsidePanelSurface(event),
          allowOutsideClick: (event) => this.isAllowedOutsideTarget(event.target),
          delayInitialFocus: false,
          returnFocusOnDeactivate: false,
        })
      : null;
    this.pointerDown = (event) => this.didPointerDown(event);
    this.focusOut = (event) => this.didLoseFocus(event);
    this.mouseDown = (event) => this.didMouseDownOnElement(event);
    this.portalSubscription = this.contextViews?.onDidChangeActive(() => {
      if (this.active) this.updateContainers();
    });
  }

  owns(target) {
    return Boolean(
      target?.nodeType &&
      (this.element.contains(target) ||
        this.contextViews?.containsOwnedElement(this.element, target)),
    );
  }

  isInteractiveTarget(target) {
    const match = target?.closest?.(INTERACTIVE);
    return Boolean(match && match !== this.element && this.owns(match));
  }

  isAllowedOutsideTarget(target) {
    return (
      isWindowControlTarget(target) ||
      this.panel.flowKeeper?.containsElement(target) ||
      this.contextViews?.containsOwnedElement(this.element, target)
    );
  }

  updateContainers() {
    this.focusTrap?.updateContainerElements([
      this.element,
      ...(this.contextViews?.getOwnedSurfaces(this.element) ?? []),
    ]);
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.document.addEventListener("mousedown", this.pointerDown, true);
    this.document.addEventListener("touchstart", this.pointerDown, true);
    this.document.addEventListener("focusout", this.focusOut, true);
    this.element.addEventListener("mousedown", this.mouseDown);
    this.updateContainers();
    this.focusTrap?.activate();
    if (this.isPending()) this.focusTrap?.pause();
  }

  deactivate() {
    this.active = false;
    this.generation++;
    this.focusTrap?.deactivate();
    this.document.removeEventListener("mousedown", this.pointerDown, true);
    this.document.removeEventListener("touchstart", this.pointerDown, true);
    this.document.removeEventListener("focusout", this.focusOut, true);
    this.element.removeEventListener("mousedown", this.mouseDown);
    this.contextViews?.hideOwnedBy(this.element, { cancelled: true, restoreFocus: false });
  }

  dispose() {
    this.deactivate();
    this.portalSubscription?.dispose();
  }

  isCurrent(generation) {
    return (
      this.active &&
      !this.panel.destroyed &&
      this.panel.isVisible() &&
      this.generation === generation
    );
  }

  didLoseFocus(event) {
    if (!this.owns(event.target) || this.isAllowedOutsideTarget(event.relatedTarget)) return;
    if (this.owns(event.relatedTarget)) {
      if (this.focusQuery && !this.isInteractiveTarget(event.relatedTarget)) this.focusQuery();
      return;
    }
    if (this.isPending()) return;
    const generation = this.generation;
    this.document.defaultView.requestAnimationFrame(() => {
      if (!this.document.hasFocus() || !this.isCurrent(generation) || this.isPending()) return;
      if (!this.owns(this.document.activeElement) && this.canDismiss()) this.dismiss("focus-lost");
    });
  }

  didMouseDownOnElement(event) {
    if (!this.focusQuery || this.isPointerOutsidePanelSurface(event)) return;
    if (this.isInteractiveTarget(event.target)) return;
    event.preventDefault();
    this.focusQuery();
  }

  didPointerDown(event) {
    if (!this.active || !this.panel.isVisible() || !this.isPointerOutsidePanelSurface(event))
      return;
    const generation = this.generation;
    this.document.defaultView.requestAnimationFrame(() => {
      if (this.isCurrent(generation) && this.canDismiss()) this.dismiss("click-outside");
    });
  }

  isPointerOutsidePanelSurface(event) {
    if (this.isAllowedOutsideTarget(event.target)) return false;
    if (!this.element.contains(event.target)) return true;
    if (event.target !== this.element) return false;
    const point = event.touches?.[0] ?? event.changedTouches?.[0] ?? event;
    const rect = this.element.getBoundingClientRect();
    if (
      !Number.isFinite(point.clientX) ||
      !Number.isFinite(point.clientY) ||
      rect.width <= 0 ||
      rect.height <= 0
    )
      return false;
    return (
      point.clientX < rect.left ||
      point.clientX > rect.right ||
      point.clientY < rect.top ||
      point.clientY > rect.bottom
    );
  }
};
