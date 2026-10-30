const { Emitter } = require("@lumine-code/event-kit");

function disposeValue(value) {
  if (!value) return;
  if (typeof value === "function") value();
  else value.dispose?.();
}

function eventOccurredWithin(event, element) {
  if (element?.nodeType !== 1) return false;
  if (typeof event.composedPath === "function" && event.composedPath().includes(element)) {
    return true;
  }
  return Boolean(event.target?.nodeType && element.contains(event.target));
}

function rectForAnchor(anchor) {
  if (anchor?.nodeType === 1 && typeof anchor.getBoundingClientRect === "function") {
    return anchor.getBoundingClientRect();
  }

  if (anchor && Number.isFinite(anchor.clientX) && Number.isFinite(anchor.clientY)) {
    return {
      left: anchor.clientX,
      right: anchor.clientX + 1,
      top: anchor.clientY,
      bottom: anchor.clientY + 1,
      width: 1,
      height: 1,
    };
  }

  if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
    const width = Number.isFinite(anchor.width) ? Math.max(0, anchor.width) : 1;
    const height = Number.isFinite(anchor.height) ? Math.max(0, anchor.height) : 1;
    return {
      left: anchor.x,
      right: anchor.x + width,
      top: anchor.y,
      bottom: anchor.y + height,
      width,
      height,
    };
  }

  return { left: 0, right: 1, top: 0, bottom: 1, width: 1, height: 1 };
}

class ContextViewHandle {
  constructor(manager, options) {
    this.manager = manager;
    this.options = options;
    this.closed = false;
    this.emitter = new Emitter();
    this.previousFocus = options.restoreFocusTarget ?? manager.document.activeElement;
    this.element = manager.document.createElement("lumine-context-view");
    this.element.classList.add("context-view");
    if (options.className) {
      this.element.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
    }
    this.surface = manager.document.createElement("div");
    this.surface.classList.add("context-view-surface");
    this.element.appendChild(this.surface);
    manager.document.body.appendChild(this.element);

    this.renderDisposable = options.render?.(this.surface, this) ?? null;
    this.boundOutsideMouseDown = (event) => {
      if (
        !eventOccurredWithin(event, this.element) &&
        !eventOccurredWithin(event, options.dismissBoundary)
      ) {
        this.close({ cancelled: true });
      }
    };
    this.boundWindowBlur = () => this.close({ cancelled: true, restoreFocus: false });
    this.boundCaptionMouseDown = () => this.close({ cancelled: true });
    this.boundLayout = () => this.layout();
    manager.window.addEventListener("mousedown", this.boundOutsideMouseDown, true);
    manager.window.addEventListener("blur", this.boundWindowBlur);
    manager.window.addEventListener("lumine:native-caption-mousedown", this.boundCaptionMouseDown);
    manager.window.addEventListener("resize", this.boundLayout);
    manager.window.addEventListener("scroll", this.boundLayout, true);
    const ResizeObserverClass = manager.window.ResizeObserver ?? globalThis.ResizeObserver;
    if (typeof ResizeObserverClass === "function") {
      this.resizeObserver = new ResizeObserverClass(() => this.layout());
      this.resizeObserver.observe(this.surface);
      if (options.anchor?.nodeType === 1) this.resizeObserver.observe(options.anchor);
    }
    this.layout();
    manager.window.requestAnimationFrame?.(() => {
      if (!this.closed) this.layout();
    });
  }

  onDidClose(callback) {
    return this.emitter.on("did-close", callback);
  }

  layout() {
    if (this.closed || !this.surface.isConnected) return;
    const anchor = rectForAnchor(
      typeof this.options.anchor === "function" ? this.options.anchor() : this.options.anchor,
    );
    const viewportWidth = this.manager.window.innerWidth;
    const viewportHeight = this.manager.window.innerHeight;
    const edgePadding = this.options.edgePadding ?? 8;
    const gap = this.options.gap ?? 2;
    const maxWidth = Math.max(1, viewportWidth - edgePadding * 2);
    let placement = this.options.placement ?? "below";
    let maxHeight = Math.max(1, viewportHeight - edgePadding * 2);
    if (this.options.fixedPlacement) {
      maxHeight =
        placement === "above"
          ? Math.max(1, anchor.top - gap - edgePadding)
          : Math.max(1, viewportHeight - anchor.bottom - gap - edgePadding);
    }
    this.surface.style.maxHeight = `${Math.floor(maxHeight)}px`;
    if (this.options.matchAnchorWidth) {
      this.surface.style.width = `${Math.min(anchor.width, maxWidth)}px`;
    }
    const rect = this.surface.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    let alignment = this.options.alignment ?? "start";

    let left = alignment === "end" ? anchor.right - width : anchor.left;
    let top = placement === "above" ? anchor.top - height - gap : anchor.bottom + gap;
    const fitsBelow = anchor.bottom + gap + height <= viewportHeight - edgePadding;
    const fitsAbove = anchor.top - gap - height >= edgePadding;
    if (!this.options.fixedPlacement && placement === "below" && !fitsBelow && fitsAbove) {
      placement = "above";
      top = anchor.top - height - gap;
    } else if (!this.options.fixedPlacement && placement === "above" && !fitsAbove && fitsBelow) {
      placement = "below";
      top = anchor.bottom + gap;
    }

    left = Math.max(edgePadding, Math.min(left, viewportWidth - width - edgePadding));
    if (this.options.fixedPlacement) {
      top =
        placement === "above"
          ? Math.max(edgePadding, anchor.top - gap - height)
          : Math.min(anchor.bottom + gap, viewportHeight - edgePadding);
    } else {
      top = Math.max(edgePadding, Math.min(top, viewportHeight - height - edgePadding));
    }
    this.surface.style.left = `${Math.round(left)}px`;
    this.surface.style.top = `${Math.round(top)}px`;
    this.surface.style.maxWidth = `${Math.floor(maxWidth)}px`;
    this.surface.dataset.placement = placement;
    this.surface.dataset.alignment = alignment;
    this.options.onLayout?.({ left, top, width, height, placement, alignment, anchor });
  }

  close({ cancelled = false, restoreFocus = true } = {}) {
    if (this.closed) return false;
    this.closed = true;
    if (this.manager.activeHandle === this) {
      this.manager.activeHandle = null;
      this.manager.didChangeActive();
    }
    this.resizeObserver?.disconnect();
    this.manager.window.removeEventListener("mousedown", this.boundOutsideMouseDown, true);
    this.manager.window.removeEventListener("blur", this.boundWindowBlur);
    this.manager.window.removeEventListener(
      "lumine:native-caption-mousedown",
      this.boundCaptionMouseDown,
    );
    this.manager.window.removeEventListener("resize", this.boundLayout);
    this.manager.window.removeEventListener("scroll", this.boundLayout, true);
    const activeElement = this.manager.document.activeElement;
    const focusWasInside = activeElement && this.element.contains(activeElement);
    disposeValue(this.renderDisposable);
    this.element.remove();
    if (
      restoreFocus &&
      focusWasInside &&
      this.previousFocus?.isConnected &&
      typeof this.previousFocus.focus === "function"
    ) {
      try {
        this.previousFocus.focus({ preventScroll: true });
      } catch {
        this.previousFocus.focus();
      }
    }
    const closeEvent = { cancelled, restoreFocus };
    this.options.onHide?.(closeEvent);
    this.emitter.emit("did-close", closeEvent);
    this.emitter.dispose();
    return true;
  }

  destroy() {
    this.close({ cancelled: true });
  }
}

module.exports = class ContextViewManager {
  constructor({ document, window } = {}) {
    this.document = document ?? globalThis.document;
    this.window = window ?? this.document?.defaultView ?? globalThis.window;
    this.activeHandle = null;
    this.emitter = new Emitter();
    this.contextGesture = null;
    this.captureContextGesture = (event) => {
      const contextual = event.button === 2 || (event.button === 0 && event.ctrlKey);
      if (!contextual) {
        this.contextGesture = null;
        return;
      }
      if (event.type === "mousedown" && this.contextGesture?.pointerTarget === event.target) return;
      const activeElement = this.document.activeElement;
      this.contextGesture = {
        pointerTarget: event.type === "pointerdown" ? event.target : null,
        target: event.target,
        focusTarget: this.activeHandle?.element.contains(activeElement)
          ? this.activeHandle.previousFocus
          : activeElement,
      };
    };
    this.clearContextGesture = () => (this.contextGesture = null);
    this.document.addEventListener("pointerdown", this.captureContextGesture, true);
    this.document.addEventListener("mousedown", this.captureContextGesture, true);
    this.document.addEventListener("keydown", this.clearContextGesture, true);
  }

  // Capture at the start of the opening gesture: a focusable status control
  // can receive focus before the later contextmenu event is delivered.
  getFocusTarget(event) {
    const gesture = this.contextGesture;
    this.contextGesture = null;
    return gesture?.target === event?.target ? gesture.focusTarget : this.document.activeElement;
  }

  show(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("ContextViewManager::show requires an options object");
    }
    if (typeof options.render !== "function") {
      throw new TypeError("ContextViewManager::show requires a render callback");
    }
    const parent = this.activeHandle;
    if (options.ownerElement?.nodeType === 1 && parent?.element.contains(options.ownerElement)) {
      options = { ...options, ownerElement: parent.options.ownerElement };
    }
    this.hide({ cancelled: true });
    const handle = new ContextViewHandle(this, options);
    this.activeHandle = handle;
    this.didChangeActive();
    if (!handle.closed) options.focus?.(handle.surface, handle);
    return handle;
  }

  /** @private Observe portal ownership before a popup takes focus. */
  onDidChangeActive(callback) {
    return this.emitter.on("did-change-active", callback);
  }

  /** @private */
  didChangeActive() {
    this.emitter.emit("did-change-active", this.activeHandle);
  }

  /** @private Only an explicit trigger owns a body-mounted popup. */
  getOwnedSurfaces(owner) {
    const handle = this.activeHandle;
    const trigger = handle?.options.ownerElement;
    return owner?.nodeType === 1 &&
      trigger?.nodeType === 1 &&
      (owner === trigger || owner.contains(trigger)) &&
      !handle.closed
      ? [handle.element]
      : [];
  }

  /** @private */
  containsOwnedElement(owner, target) {
    return Boolean(
      target?.nodeType &&
      this.getOwnedSurfaces(owner).some(
        (surface) => surface === target || surface.contains(target),
      ),
    );
  }

  /** @private Retire child portals without touching an unrelated popup. */
  hideOwnedBy(owner, options = { restoreFocus: false }) {
    return this.getOwnedSurfaces(owner).length ? this.hide(options) : false;
  }

  hide(options) {
    return this.activeHandle?.close(options) ?? false;
  }

  destroy() {
    if (!this.document) return;
    this.hide({ cancelled: true });
    this.document.removeEventListener("pointerdown", this.captureContextGesture, true);
    this.document.removeEventListener("mousedown", this.captureContextGesture, true);
    this.document.removeEventListener("keydown", this.clearContextGesture, true);
    this.contextGesture = null;
    this.emitter.dispose();
    this.document = null;
    this.window = null;
  }
};

module.exports.rectForAnchor = rectForAnchor;
