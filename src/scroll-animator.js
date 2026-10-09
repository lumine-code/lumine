const CURVE_X1 = 0.42;
const CURVE_X2 = 0.58;
const RAMP_START = 120; // px
const RAMP_END = 480; // px
const MIN_DURATION = 60; // ms at smoothness 8
const MAX_DURATION = 120;
const DEFAULT_SMOOTHNESS = 8;
const X_A = 1 - 3 * CURVE_X2 + 3 * CURVE_X1;
const X_B = 3 * (CURVE_X2 - 2 * CURVE_X1);
const X_C = 3 * CURVE_X1;

// Chromium-style cubic retargeting and inverse-distance duration selection.
// The upstream notices and reference revision are retained in LICENSE. Each
// axis has its own segment and a stricter duration bound to prevent overshoot.
function createCurve(position, velocity, target, smoothness) {
  const distance = target - position;
  if (distance === 0) return null;
  if (distance * velocity < 0) velocity = 0;
  const ramp = clamp((Math.abs(distance) - RAMP_START) / (RAMP_END - RAMP_START), 0, 1);
  let duration =
    smoothness <= 2
      ? 0
      : (MAX_DURATION - (MAX_DURATION - MIN_DURATION) * ramp) * (smoothness / DEFAULT_SMOOTHNESS);
  if (distance * velocity > 0) {
    // Keeping the first Y control point at/below the endpoint makes the curve
    // monotone while retaining the incoming velocity, even for a nearby target.
    duration = Math.min(duration, Math.abs(distance / (CURVE_X1 * velocity)));
  }
  return {
    position,
    target,
    distance,
    initialVelocity: velocity,
    duration,
    elapsed: 0,
    y1: duration === 0 ? 0 : clamp((CURVE_X1 * velocity * duration) / distance, 0, 1),
  };
}

function cubicX(parameter) {
  return ((X_A * parameter + X_B) * parameter + X_C) * parameter;
}

function cubicXDerivative(parameter) {
  return (3 * X_A * parameter + 2 * X_B) * parameter + X_C;
}

// X is strictly increasing. Newton converges quickly for these control points;
// a bracketed fallback also handles progress extremely close to an endpoint.
function curveParameter(progress) {
  let parameter = progress;
  for (let iteration = 0; iteration < 8; iteration++) {
    const error = cubicX(parameter) - progress;
    if (Math.abs(error) < 1e-12) return parameter;
    const next = parameter - error / cubicXDerivative(parameter);
    if (next < 0 || next > 1) break;
    parameter = next;
  }
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 40; iteration++) {
    parameter = (lower + upper) / 2;
    const value = cubicX(parameter);
    if (Math.abs(value - progress) < 1e-12) break;
    if (value < progress) lower = parameter;
    else upper = parameter;
  }
  return parameter;
}

function advanceCurve(curve, elapsed, position, target) {
  if (!curve) return { position: target, velocity: 0 };
  curve.elapsed += elapsed;
  if (curve.duration === 0 || curve.elapsed >= curve.duration) {
    return { position: curve.target, velocity: 0 };
  }
  if (curve.elapsed <= 0) return { position, velocity: curve.initialVelocity };
  const parameter = curveParameter(curve.elapsed / curve.duration);
  const remaining = 1 - parameter;
  const progress =
    3 * remaining * remaining * parameter * curve.y1 +
    3 * remaining * parameter * parameter +
    parameter * parameter * parameter;
  const derivative =
    3 * remaining * remaining * curve.y1 + 6 * remaining * parameter * (1 - curve.y1);
  return {
    position: clamp(
      curve.position + curve.distance * progress,
      Math.min(curve.position, curve.target),
      Math.max(curve.position, curve.target),
    ),
    velocity: (curve.distance / curve.duration) * (derivative / cubicXDerivative(parameter)),
  };
}

// Inputs advance the virtual trajectory to their own timestamps. Only rAF
// publishes it to the component, so a burst of wheel events still renders once
// per frame. Retargeting samples the current position and analytic velocity.
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
    this.curveX = null;
    this.curveY = null;
    this.applyingFrame = false;
    this.step = this.step.bind(this);
  }

  isAnimating() {
    return this.animating;
  }

  scrollBy({ x = 0, y = 0, smoothness, momentum = false, reset = false, timestamp } = {}) {
    const time = this.prepareRequest(timestamp, reset);
    if (momentum) return this.requestMomentumScroll(x, y, time);
    return this.requestScroll(x, y, smoothness, time);
  }

  scrollTo({ top, left, smoothness, reset = false, timestamp } = {}) {
    const time = this.prepareRequest(timestamp, reset);
    const x = left != null ? left - this.targetScrollLeft : 0;
    const y = top != null ? top - this.targetScrollTop : 0;
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

  // A hidden surface needs no more frames, but retains all accepted motion
  // for its next reveal. Publish the bounded destination before ending the
  // lifecycle so scroll observers see the final position too.
  finish() {
    if (!this.animating) return;
    if (this.frameHandle != null) this.caf(this.frameHandle);
    this.targetScrollTop = this.virtualScrollTop = clamp(
      this.targetScrollTop,
      0,
      this.component.getMaxScrollTop(),
    );
    this.targetScrollLeft = this.virtualScrollLeft = clamp(
      this.targetScrollLeft,
      0,
      this.component.getMaxScrollLeft(),
    );
    this.velocityX = this.velocityY = 0;
    this.curveX = this.curveY = null;
    this.advance(0);
  }

  requestScroll(x, y, smoothness, timestamp, absolute = false) {
    if (!this.animating && !this.canScrollBy(x, y)) return false;
    const previousTargetX = this.targetScrollLeft;
    const previousTargetY = this.targetScrollTop;
    const previousVelocityX = this.velocityX;
    const previousVelocityY = this.velocityY;
    const previousSmoothness = this.smoothness;
    if (smoothness != null) this.smoothness = smoothness;

    // Relative reversal cancels unfinished motion on that axis. An absolute
    // destination can move closer while still remaining ahead of the viewport.
    const directionX = absolute ? x + this.pendingX() : x;
    const directionY = absolute ? y + this.pendingY() : y;
    if (
      directionX * this.pendingX() < 0 ||
      directionX * this.velocityX < 0 ||
      (absolute && directionX === 0)
    ) {
      if (!absolute) this.targetScrollLeft = this.virtualScrollLeft;
      this.velocityX = 0;
    }
    if (
      directionY * this.pendingY() < 0 ||
      directionY * this.velocityY < 0 ||
      (absolute && directionY === 0)
    ) {
      if (!absolute) this.targetScrollTop = this.virtualScrollTop;
      this.velocityY = 0;
    }
    this.targetScrollLeft = clamp(this.targetScrollLeft + x, 0, this.component.getMaxScrollLeft());
    this.targetScrollTop = clamp(this.targetScrollTop + y, 0, this.component.getMaxScrollTop());

    // A clamped or unchanged target keeps its segment and original deadline.
    // Neither repeated events at an edge nor input on the other axis prolongs it.
    if (
      this.targetScrollLeft !== previousTargetX ||
      this.velocityX !== previousVelocityX ||
      this.smoothness !== previousSmoothness
    ) {
      this.retargetX();
    }
    if (
      this.targetScrollTop !== previousTargetY ||
      this.velocityY !== previousVelocityY ||
      this.smoothness !== previousSmoothness
    ) {
      this.retargetY();
    }
    if (this.pendingX() === 0 && this.pendingY() === 0) return false;
    this.start(timestamp);
    return true;
  }

  requestMomentumScroll(x, y, timestamp) {
    this.translateMomentumAxis(x, true);
    this.translateMomentumAxis(y, false);

    // Momentum can have no unfinished distance but still need a frame: its
    // accepted deltas update the virtual viewport without publishing to DOM.
    if (
      this.pendingX() === 0 &&
      this.pendingY() === 0 &&
      this.virtualScrollLeft === this.component.getScrollLeft() &&
      this.virtualScrollTop === this.component.getScrollTop()
    ) {
      return false;
    }
    this.start(timestamp);
    return true;
  }

  translateMomentumAxis(delta, horizontal) {
    if (delta === 0) return;
    const targetKey = horizontal ? "targetScrollLeft" : "targetScrollTop";
    const positionKey = horizontal ? "virtualScrollLeft" : "virtualScrollTop";
    const velocityKey = horizontal ? "velocityX" : "velocityY";
    const curveKey = horizontal ? "curveX" : "curveY";
    const maximum = horizontal
      ? this.component.getMaxScrollLeft()
      : this.component.getMaxScrollTop();

    // A reversal takes over this axis instead of completing its old glide.
    // The other axis keeps its own curve, velocity and deadline.
    const pending = this[targetKey] - this[positionKey];
    if (delta * pending < 0 || delta * this[velocityKey] < 0) {
      this[targetKey] = this[positionKey];
      this[velocityKey] = 0;
      this[curveKey] = null;
    }

    const target = clamp(this[targetKey] + delta, 0, maximum);
    const accepted = target - this[targetKey];
    if (accepted === 0) return;
    this[targetKey] = target;
    this[positionKey] += accepted;

    // The system supplies this motion's deceleration. Translate the existing
    // unfinished glide rather than replacing it with a new easing curve or
    // paying its whole remaining distance in the first momentum frame.
    const curve = this[curveKey];
    if (curve) {
      curve.position += accepted;
      curve.target = target;
    }
  }

  retargetX() {
    this.curveX = createCurve(
      this.virtualScrollLeft,
      this.velocityX,
      this.targetScrollLeft,
      this.smoothness,
    );
    this.velocityX = this.curveX?.initialVelocity ?? 0;
  }

  retargetY() {
    this.curveY = createCurve(
      this.virtualScrollTop,
      this.velocityY,
      this.targetScrollTop,
      this.smoothness,
    );
    this.velocityY = this.curveY?.initialVelocity ?? 0;
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
    this.curveX = this.curveY = null;
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

  advance(elapsed) {
    if (!this.animating) return;
    this.frameHandle = null;
    elapsed = Math.max(0, elapsed);
    this.lastUpdateTime += elapsed;
    this.advanceMotion(elapsed);

    this.applyingFrame = true;
    let changedX, changedY;
    try {
      // Inputs may already have advanced virtual motion. A zero-time frame
      // still needs to publish that motion to the visible editor.
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
    const maxTop = this.component.getMaxScrollTop();
    const maxLeft = this.component.getMaxScrollLeft();
    const targetTop = clamp(this.targetScrollTop, 0, maxTop);
    const targetLeft = clamp(this.targetScrollLeft, 0, maxLeft);
    const top = clamp(this.virtualScrollTop, 0, maxTop);
    const left = clamp(this.virtualScrollLeft, 0, maxLeft);
    if (targetTop !== this.targetScrollTop || top !== this.virtualScrollTop) {
      if (top !== this.virtualScrollTop) this.velocityY = 0;
      this.targetScrollTop = targetTop;
      this.virtualScrollTop = top;
      this.retargetY();
    }
    if (targetLeft !== this.targetScrollLeft || left !== this.virtualScrollLeft) {
      if (left !== this.virtualScrollLeft) this.velocityX = 0;
      this.targetScrollLeft = targetLeft;
      this.virtualScrollLeft = left;
      this.retargetX();
    }
    const vertical = advanceCurve(this.curveY, elapsed, top, targetTop);
    const horizontal = advanceCurve(this.curveX, elapsed, left, targetLeft);
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
