// Keep one stable preparation target and one completed viewport. New input
// replaces only the desired destination, so a busy worker can finish useful
// work instead of chasing a moving range indefinitely. Text and colors commit
// together; neither the buffer nor the native thumb waits for the worker.
class ScrollPresentation {
  constructor(component) {
    this.component = component;
    this.pendingOwner = {};
    this.readyOwner = {};
    this.requestedTop = this.pendingTop = this.readyTop = null;
    this.frame = null;
    this.version = 0;
  }

  request(top, { defer = false, inlineReady = false } = {}) {
    const c = this.component;
    if (
      top == null ||
      Number.isNaN(top) ||
      !c.attached ||
      !c.visible ||
      !c.hasInitialMeasurements ||
      !c.props.model.getBuffer().getLanguageMode().asynchronousSyntax
    )
      return false;
    top = Math.max(0, Math.min(c.getMaxScrollTop(), top));
    if (top === c.getScrollTop()) {
      this.cancel();
      return true;
    }
    const wasPending = this.requestedTop != null;
    this.requestedTop = top;
    this.update();
    if (inlineReady && this.readyTop === top && this.pendingTop == null) {
      this.cancel();
      return false;
    }
    // Preserve the immediate cached path. A completed asynchronous request is
    // coalesced into the next frame, and animator input already owns a frame.
    if (!defer && !wasPending && this.readyTop === top) this.flush();
    return true;
  }

  release(owner) {
    this.mode?.requestHighlighting?.(owner, [], false, { prefetch: false });
  }

  prepare(top, owner, priority) {
    const c = this.component;
    const first = c.tileStartRowForRow(c.rowForPixelPosition(top));
    const last = first + c.getVisibleTileCount() * c.getRowsPerTile();
    return (
      c.props.model.displayLayer.prepareHighlightingForScreenRows(first, last, owner, {
        priority,
        prefetch: false,
        background: false,
      }) !== false
    );
  }

  update(schedule = true) {
    if (this.requestedTop == null || this.checking || this.committing) return;
    const c = this.component,
      buffer = c.props.model.getBuffer();
    if (!c.attached || !c.visible || c.props.model.isDestroyed()) {
      this.cancel();
      return;
    }
    this.checking = true;
    const version = this.version;
    try {
      const mode = buffer.getLanguageMode(),
        revision = buffer.getTextRevision();
      if (mode !== this.mode || revision !== this.revision) {
        this.release(this.pendingOwner);
        this.release(this.readyOwner);
        this.mode = mode;
        this.revision = revision;
        this.pendingTop = this.readyTop = null;
      }
      this.requestedTop = Math.min(c.getMaxScrollTop(), this.requestedTop);
      if (this.requestedTop === c.getScrollTop()) {
        this.cancel();
        return;
      }
      if (this.pendingTop != null && this.prepare(this.pendingTop, this.pendingOwner, 0)) {
        if (version !== this.version) return;
        this.readyTop = this.pendingTop;
        this.pendingTop = null;
        this.prepare(this.readyTop, this.readyOwner, 1);
      }
      if (version !== this.version) return;
      if (
        this.pendingTop == null &&
        this.requestedTop !== this.readyTop &&
        this.requestedTop !== c.getScrollTop()
      ) {
        this.pendingTop = this.requestedTop;
        if (this.prepare(this.pendingTop, this.pendingOwner, 0)) {
          if (version !== this.version) return;
          this.readyTop = this.pendingTop;
          this.pendingTop = null;
          this.prepare(this.readyTop, this.readyOwner, 1);
        }
      }
      if (version !== this.version) return;
      if (schedule && this.readyTop != null && !this.frame) {
        const window = c.window;
        const frame = { window, handle: null };
        frame.handle = window.requestAnimationFrame(() => {
          if (this.frame !== frame) return;
          this.frame = null;
          this.flush();
        });
        this.frame = frame;
      }
    } finally {
      this.checking = false;
    }
  }

  flush() {
    if (this.frame) this.frame.window.cancelAnimationFrame(this.frame.handle);
    this.frame = null;
    this.update(false);
    if (this.readyTop == null) return false;
    const top = Math.min(this.component.getMaxScrollTop(), this.readyTop);
    if (!this.prepare(top, this.readyOwner, 1)) {
      this.pendingTop = top;
      this.readyTop = null;
      this.prepare(top, this.pendingOwner, 0);
      return false;
    }
    this.readyTop = null;
    this.committing = true;
    let committed;
    try {
      committed = this.component.commitScrollPresentation(top);
    } finally {
      this.committing = false;
    }
    if (!committed) this.pendingTop = top;
    else {
      this.release(this.readyOwner);
      if (this.requestedTop === top) {
        this.cancel();
        return true;
      }
    }
    this.update();
    return committed;
  }

  cancel() {
    this.version++;
    if (this.frame) this.frame.window.cancelAnimationFrame(this.frame.handle);
    this.frame = null;
    this.release(this.pendingOwner);
    this.release(this.readyOwner);
    this.requestedTop = this.pendingTop = this.readyTop = null;
    this.mode = null;
    this.resolveSettled?.();
    this.resolveSettled = this.settledPromise = null;
  }

  whenSettled() {
    if (this.requestedTop == null) return Promise.resolve();
    return (this.settledPromise ??= new Promise((resolve) => {
      this.resolveSettled = resolve;
    }));
  }
}

module.exports = ScrollPresentation;
