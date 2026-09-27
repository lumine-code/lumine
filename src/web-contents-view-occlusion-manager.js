const { Disposable } = require("@lumine-code/event-kit");

const AUTOMATIC_OVERLAY_SELECTOR = [
  "lumine-panel.overlay",
  "lumine-context-view",
  "lumine-notification",
  ".context-view",
  ".context-menu-popup",
  "lumine-tooltip",
  ".tooltip",
  "lumine-overlay",
  "[data-web-contents-view-overlay]",
].join(",");

function intersects(first, second) {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

function isRendered(element) {
  if (!element?.isConnected || typeof element.getBoundingClientRect !== "function") return false;
  if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;

  const view = element.ownerDocument?.defaultView;
  const style = view?.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden" && style?.opacity !== "0";
}

/**
 * Coordinates native surfaces with DOM UI which must be painted above them.
 *
 * WebContentsView is a native child view, so CSS z-index cannot put a modal or
 * popup over it. Registered surfaces ask this manager whether their anchor is
 * occluded and are re-laid out whenever the overlay DOM changes.
 */
module.exports = class WebContentsViewOcclusionManager {
  constructor() {
    this.surfaces = new Set();
    this.explicitOverlays = new Set();
    this.document = null;
    this.observer = null;
    this.updateScheduled = false;
  }

  addSurface(surface) {
    this.surfaces.add(surface);
    this.observeDocument(surface.anchorElement?.ownerDocument);
  }

  removeSurface(surface) {
    this.surfaces.delete(surface);
  }

  surfaceAttached(surface, element) {
    this.surfaces.add(surface);
    this.observeDocument(element?.ownerDocument);
    this.scheduleUpdate();
  }

  registerOverlay(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
      throw new TypeError("A web contents view overlay must be a DOM element");
    }

    this.explicitOverlays.add(element);
    this.observeDocument(element.ownerDocument);
    this.scheduleUpdate();
    return new Disposable(() => {
      this.explicitOverlays.delete(element);
      this.scheduleUpdate();
    });
  }

  observeDocument(document) {
    if (!document || document === this.document) return;

    this.observer?.disconnect();
    this.document = document;
    const MutationObserver = document.defaultView?.MutationObserver;
    if (!MutationObserver || !document.documentElement) return;

    this.observer = new MutationObserver(() => this.scheduleUpdate());
    this.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "hidden", "open", "style", "aria-hidden"],
      childList: true,
      subtree: true,
    });
  }

  isOccluded(anchor, bounds) {
    const document = anchor?.ownerDocument ?? this.document;
    if (!document) return false;

    const overlays = new Set(this.explicitOverlays);
    for (const overlay of document.querySelectorAll?.(AUTOMATIC_OVERLAY_SELECTOR) ?? []) {
      overlays.add(overlay);
    }

    for (const overlay of overlays) {
      if (!isRendered(overlay) || overlay === anchor) continue;
      const overlayBounds = overlay.getBoundingClientRect();
      if (overlayBounds.width <= 0 || overlayBounds.height <= 0) continue;
      if (intersects(bounds, overlayBounds)) return true;
    }
    return false;
  }

  scheduleUpdate() {
    if (this.updateScheduled) return;
    this.updateScheduled = true;

    const view = this.document?.defaultView;
    const schedule = view?.requestAnimationFrame ?? ((callback) => setTimeout(callback, 0));
    schedule(() => {
      this.updateScheduled = false;
      for (const surface of this.surfaces) surface.scheduleLayout();
    });
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.document = null;
    this.explicitOverlays.clear();
    this.surfaces.clear();
  }
};
