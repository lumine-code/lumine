const COMPLETION_THRESHOLD = 0.01; // px
const FRAME_DURATION = 1000 / 60;
const VELOCITY_THRESHOLD = COMPLETION_THRESHOLD / FRAME_DURATION; // px/ms

// Exact solution of a critically damped spring. A new target changes the
// acceleration while preserving velocity, unlike a first-order approach whose
// speed jumps with every wheel impulse. Calibrate the response to retain the
// old animator's mean delay at a given smoothness (two spring time constants).
function advanceAxis(position, velocity, target, smoothness, elapsed) {
  if (smoothness <= 2 || (position === target && velocity === 0)) {
    return { position: target, velocity: 0 };
  }
  if (elapsed <= 0) return { position, velocity };

  const rate = (-2 * Math.log1p(-2 / smoothness)) / FRAME_DURATION;
  const offset = position - target;
  const coefficient = velocity + rate * offset;
  const decay = Math.exp(-rate * elapsed);
  const nextPosition = target + (offset + coefficient * elapsed) * decay;
  const nextVelocity = (velocity - rate * coefficient * elapsed) * decay;

  // Retargeting or shrinking the viewport must never carry motion beyond the
  // requested endpoint. Settle exactly, including fractional-pixel targets.
  if (
    (target - position) * (target - nextPosition) <= 0 ||
    (Math.abs(target - nextPosition) < COMPLETION_THRESHOLD &&
      Math.abs(nextVelocity) < VELOCITY_THRESHOLD)
  ) {
    return { position: target, velocity: 0 };
  }
  return { position: nextPosition, velocity: nextVelocity };
}

// Wheel input advances the virtual trajectory to its own timestamp. Only
// animation frames publish that trajectory to the component, so several events
// between frames do not cause several synchronous editor renders.
class ScrollAnimator {
  constructor(component, { requestAnimationFrame, cancelAnimationFrame, now } = {}) {
    this.component = component;
    this.raf = requestAnimationFrame || ((callback) => window.requestAnimationFrame(callback));
    this.caf = cancelAnimationFrame || ((handle) => window.cancelAnimationFrame(handle));
    this.now = now || (() => performance.now());
    this.animating = false;
    this.frameHandle = null;
    this.lastUpdateTime = null;
    this.smoothness = 1;
    this.targetScrollTop = 0;
    this.targetScrollLeft = 0;
    this.virtualScrollTop = 0;
    this.virtualScrollLeft = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    // Component setters outside our frame are deliberate viewport takeovers.
    this.applyingFrame = false;
    this.step = this.step.bind(this);
  }

  isAnimating() {
    return this.animating;
  }

  // Same-direction requests extend the target without restarting the glide.
  // Reset discards pending motion and starts from the visible position.
  scrollBy({ x = 0, y = 0, smoothness, reset = false, timestamp } = {}) {
    const time = this.prepareRequest(timestamp, reset);
    return this.requestScroll(x, y, smoothness, time);
  }

  scrollTo({ top, left, smoothness, reset = false, timestamp } = {}) {
    const time = this.prepareRequest(timestamp, reset);
    const x = left != null ? left - this.targetScrollLeft : 0;
    const y = top != null ? top - this.targetScrollTop : 0;
    // Absolute requests retain their requested endpoint even on reversal.
    return this.requestScroll(x, y, smoothness, time, true);
  }

  prepareRequest(timestamp, reset) {
    const time = Number.isFinite(timestamp) ? timestamp : this.now();
    if (reset || !this.animating) {
      this.syncToComponent();
      this.lastUpdateTime = this.animating ? Math.max(this.lastUpdateTime, time) : time;
    } else {
      const elapsed = Math.max(0, time - this.lastUpdateTime);
      this.advanceMotion(elapsed);
      this.lastUpdateTime += elapsed;
    }
    return this.lastUpdateTime;
  }

  cancel() {
    if (this.frameHandle != null) {
      this.caf(this.frameHandle);
      this.frameHandle = null;
    }
    this.lastUpdateTime = null;
    const wasAnimating = this.animating;
    this.animating = false;
    this.syncToComponent();
    if (wasAnimating) this.component.element.emitter.emit("did-end-scroll-animation");
  }

  requestScroll(x, y, smoothness, timestamp, absolute = false) {
    if (!this.animating && !this.canScrollBy(x, y)) return false;
    if (smoothness != null) this.smoothness = smoothness;

    // Opposite input is an explicit change of intent. Clear unfinished motion
    // on that axis instead of requiring the user to cancel the old backlog.
    if (x * this.pendingX() < 0 || x * this.velocityX < 0) {
      if (!absolute) this.targetScrollLeft = this.virtualScrollLeft;
      this.velocityX = 0;
    }
    if (y * this.pendingY() < 0 || y * this.velocityY < 0) {
      if (!absolute) this.targetScrollTop = this.virtualScrollTop;
      this.velocityY = 0;
    }
    this.targetScrollLeft = clamp(this.targetScrollLeft + x, 0, this.component.getMaxScrollLeft());
    this.targetScrollTop = clamp(this.targetScrollTop + y, 0, this.component.getMaxScrollTop());
    if (this.pendingX() === 0 && this.pendingY() === 0) return false;
    this.start(timestamp);
    return true;
  }

  canScrollBy(x, y) {
    return (
      (x < 0 && this.component.getScrollLeft() > 0) ||
      (x > 0 && this.component.getScrollLeft() < this.component.getMaxScrollLeft()) ||
      (y < 0 && this.component.getScrollTop() > 0) ||
      (y > 0 && this.component.getScrollTop() < this.component.getMaxScrollTop())
    );
  }

  syncToComponent() {
    this.targetScrollTop = this.virtualScrollTop = this.component.getScrollTop();
    this.targetScrollLeft = this.virtualScrollLeft = this.component.getScrollLeft();
    this.velocityX = this.velocityY = 0;
  }

  start(timestamp) {
    if (this.animating) return;
    this.animating = true;
    this.lastUpdateTime = timestamp;
    this.component.element.emitter.emit("did-start-scroll-animation");
    this.frameHandle = this.raf(this.step);
  }

  step(timestamp) {
    this.advance(Math.max(0, timestamp - this.lastUpdateTime));
  }

  // Deterministic relative-time entry point for specs and benchmarks. The
  // production rAF path computes elapsed from the most recent input or frame.
  advance(elapsed) {
    if (!this.animating) return;
    this.frameHandle = null;
    elapsed = Math.max(0, elapsed);
    this.lastUpdateTime += elapsed;
    this.advanceMotion(elapsed);

    this.applyingFrame = true;
    let changedX, changedY;
    try {
      // Input may already have advanced virtual motion, including all the way
      // to its target. Flush against the component even on a zero-time frame.
      changedY = this.component.setScrollTop(this.virtualScrollTop);
      changedX = this.component.setScrollLeft(this.virtualScrollLeft);
    } finally {
      this.applyingFrame = false;
    }
    if (changedX || changedY) {
      this.component.updateScrollAnimationFrame({ horizontal: changedX, vertical: changedY });
    }
    if (!this.animating) return;

    if (this.pendingX() !== 0 || this.pendingY() !== 0) {
      this.frameHandle = this.raf(this.step);
    } else {
      this.animating = false;
      this.lastUpdateTime = null;
      this.syncToComponent();
      this.component.element.emitter.emit("did-end-scroll-animation");
    }
  }

  advanceMotion(elapsed) {
    const maxScrollTop = this.component.getMaxScrollTop();
    const maxScrollLeft = this.component.getMaxScrollLeft();
    this.targetScrollTop = clamp(this.targetScrollTop, 0, maxScrollTop);
    this.targetScrollLeft = clamp(this.targetScrollLeft, 0, maxScrollLeft);
    const top = clamp(this.virtualScrollTop, 0, maxScrollTop);
    const left = clamp(this.virtualScrollLeft, 0, maxScrollLeft);
    if (top !== this.virtualScrollTop) this.velocityY = 0;
    if (left !== this.virtualScrollLeft) this.velocityX = 0;

    const vertical = advanceAxis(
      top,
      this.velocityY,
      this.targetScrollTop,
      this.smoothness,
      elapsed,
    );
    const horizontal = advanceAxis(
      left,
      this.velocityX,
      this.targetScrollLeft,
      this.smoothness,
      elapsed,
    );
    this.virtualScrollTop = vertical.position;
    this.virtualScrollLeft = horizontal.position;
    this.velocityY = vertical.velocity;
    this.velocityX = horizontal.velocity;
  }

  pendingY() {
    return this.targetScrollTop - this.virtualScrollTop;
  }

  pendingX() {
    return this.targetScrollLeft - this.virtualScrollLeft;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = ScrollAnimator;
