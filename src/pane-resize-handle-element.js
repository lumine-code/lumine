const { beginLayoutDrag } = require("./layout-drag");

class PaneResizeHandleElement extends HTMLElement {
  constructor() {
    super();
    this.resizePane = this.resizePane.bind(this);
    this.resizeStopped = this.resizeStopped.bind(this);
    this.flushPendingResize = this.flushPendingResize.bind(this);
    this.resizeFrame = null;
    this.pendingResizePosition = null;
    this.subscribeToDOMEvents();
  }

  subscribeToDOMEvents() {
    this.addEventListener("dblclick", this.resizeToFitContent.bind(this));
    this.addEventListener("mousedown", this.resizeStarted.bind(this));
  }

  connectedCallback() {
    // For some reason Chromium 58 is firing the attached callback after the
    // element has been detached, so we ignore the callback when a parent element
    // can't be found.
    if (this.parentElement) {
      this.isHorizontal = this.parentElement.classList.contains("horizontal");
      this.classList.add(this.isHorizontal ? "horizontal" : "vertical");
    }
  }

  disconnectedCallback() {
    this.resizeStopped(false);
  }

  resizeToFitContent() {
    // clear flex-grow css style of both pane
    if (this.previousSibling != null) {
      this.previousSibling.model.setFlexScale(1);
    }
    return this.nextSibling != null ? this.nextSibling.model.setFlexScale(1) : undefined;
  }

  resizeStarted(e) {
    e.stopPropagation();
    if (this.layoutDrag) return;
    if (!this.previousSibling?.model || !this.nextSibling?.model) return;
    this.resizePreviousSibling = this.previousSibling;
    this.resizeNextSibling = this.nextSibling;
    this.resizeDocument = this.ownerDocument;
    this.resizeWindow = this.resizeDocument.defaultView;
    if (!this.overlay) {
      this.overlay = document.createElement("div");
      this.overlay.classList.add("lumine-pane-cursor-overlay");
      this.overlay.classList.add(this.isHorizontal ? "horizontal" : "vertical");
      this.appendChild(this.overlay);
    }
    this.resizeDocument.addEventListener("mousemove", this.resizePane);
    this.resizeDocument.addEventListener("mouseup", this.resizeStopped);
    this.resizeWindow.addEventListener("blur", this.resizeStopped);
    this.layoutDrag = beginLayoutDrag();
  }

  resizeStopped(flush = true) {
    if (flush) this.flushPendingResize();
    this.cancelPendingResize();
    this.resizeDocument?.removeEventListener("mousemove", this.resizePane);
    this.resizeDocument?.removeEventListener("mouseup", this.resizeStopped);
    this.resizeWindow?.removeEventListener("blur", this.resizeStopped);
    const layoutDrag = this.layoutDrag;
    this.layoutDrag = null;
    if (this.overlay) {
      this.removeChild(this.overlay);
      this.overlay = undefined;
    }
    this.resizePreviousSibling = this.resizeNextSibling = null;
    this.resizeDocument = this.resizeWindow = null;
    layoutDrag?.dispose();
  }

  calcRatio(ratio1, ratio2, total) {
    const allRatio = ratio1 + ratio2;
    return [(total * ratio1) / allRatio, (total * ratio2) / allRatio];
  }

  setFlexGrow(prevSize, nextSize) {
    this.prevModel = this.previousSibling.model;
    this.nextModel = this.nextSibling.model;
    const totalScale = this.prevModel.getFlexScale() + this.nextModel.getFlexScale();
    const flexGrows = this.calcRatio(prevSize, nextSize, totalScale);
    this.prevModel.setFlexScale(flexGrows[0]);
    this.nextModel.setFlexScale(flexGrows[1]);
  }

  fixInRange(val, minValue, maxValue) {
    return Math.min(Math.max(val, minValue), maxValue);
  }

  resizePane({ clientX, clientY, which, buttons }) {
    if (which !== 1 || buttons === 0) {
      return this.resizeStopped();
    }
    if (!this.layoutDrag) return;
    this.pendingResizePosition = { x: clientX, y: clientY };
    if (this.resizeFrame == null) {
      this.resizeFrame = this.resizeWindow.requestAnimationFrame(this.flushPendingResize);
    }
  }

  cancelPendingResize() {
    if (this.resizeFrame != null) this.resizeWindow.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.pendingResizePosition = null;
  }

  flushPendingResize() {
    const position = this.pendingResizePosition;
    this.cancelPendingResize();
    if (!position || !this.layoutDrag) return;
    if (
      !this.isConnected ||
      this.previousSibling !== this.resizePreviousSibling ||
      this.nextSibling !== this.resizeNextSibling ||
      this.previousSibling.model.isDestroyed?.() ||
      this.nextSibling.model.isDestroyed?.()
    ) {
      return this.resizeStopped(false);
    }

    if (this.isHorizontal) {
      const totalWidth = this.previousSibling.clientWidth + this.nextSibling.clientWidth;
      if (totalWidth <= 0) return this.resizeStopped(false);
      // get the left and right width after move the resize view
      let leftWidth = position.x - this.previousSibling.getBoundingClientRect().left;
      leftWidth = this.fixInRange(leftWidth, 0, totalWidth);
      const rightWidth = totalWidth - leftWidth;
      // set the flex grow by the ratio of left width and right width
      // to change pane width
      this.setFlexGrow(leftWidth, rightWidth);
    } else {
      const totalHeight = this.previousSibling.clientHeight + this.nextSibling.clientHeight;
      if (totalHeight <= 0) return this.resizeStopped(false);
      let topHeight = position.y - this.previousSibling.getBoundingClientRect().top;
      topHeight = this.fixInRange(topHeight, 0, totalHeight);
      const bottomHeight = totalHeight - topHeight;
      this.setFlexGrow(topHeight, bottomHeight);
    }
  }
}

window.customElements.define("lumine-pane-resize-handle", PaneResizeHandleElement);

function createPaneResizeHandleElement() {
  return document.createElement("lumine-pane-resize-handle");
}

module.exports = {
  createPaneResizeHandleElement,
};
