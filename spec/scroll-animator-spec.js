const { Emitter } = require("@lumine-code/event-kit");
const ScrollAnimator = require("../src/scroll-animator");

const FRAME = 1000 / 60;

describe("ScrollAnimator", () => {
  describe("animation against a component", () => {
    let component, animator, rafCallbacks, canceledHandles, now;

    function buildMockComponent() {
      return {
        scrollTop: 0,
        scrollLeft: 0,
        maxScrollTop: 1000,
        maxScrollLeft: 500,
        scrollFrameUpdateCount: 0,
        element: { emitter: new Emitter() },
        getScrollTop() {
          return this.scrollTop;
        },
        getScrollLeft() {
          return this.scrollLeft;
        },
        getMaxScrollTop() {
          return this.maxScrollTop;
        },
        getMaxScrollLeft() {
          return this.maxScrollLeft;
        },
        // The component stores exact positions; rendered outputs quantize.
        setScrollTop(value) {
          value = Math.max(0, Math.min(this.maxScrollTop, value));
          if (value === this.scrollTop) return false;
          this.scrollTop = value;
          return true;
        },
        setScrollLeft(value) {
          value = Math.max(0, Math.min(this.maxScrollLeft, value));
          if (value === this.scrollLeft) return false;
          this.scrollLeft = value;
          return true;
        },
        updateScrollAnimationFrame() {
          this.scrollFrameUpdateCount++;
        },
      };
    }

    function tick(elapsed = FRAME) {
      now += elapsed;
      animator.step(now);
    }

    function runUntilDone(maxFrames = 1000) {
      let frames = 0;
      while (animator.isAnimating() && frames < maxFrames) {
        tick();
        frames++;
      }
      expect(animator.isAnimating()).toBe(false);
      return frames;
    }

    beforeEach(() => {
      now = 0;
      component = buildMockComponent();
      rafCallbacks = [];
      canceledHandles = [];
      animator = new ScrollAnimator(component, {
        requestAnimationFrame: (callback) => rafCallbacks.push(callback),
        cancelAnimationFrame: (handle) => canceledHandles.push(handle),
        now: () => now,
      });
    });

    it("glides to the requested position and lands exactly on target", () => {
      expect(animator.scrollBy({ y: 100, smoothness: 8 })).toBe(true);
      expect(animator.isAnimating()).toBe(true);
      expect(component.scrollTop).toBe(0);

      const frames = runUntilDone();
      expect(frames).toBeGreaterThan(1);
      expect(component.scrollTop).toBe(100);
      expect(animator.targetScrollTop).toBe(100);
      expect(component.scrollFrameUpdateCount).toBeGreaterThan(0);
    });

    it("approaches the target monotonically", () => {
      animator.scrollBy({ y: 200, smoothness: 8 });
      let previous = component.scrollTop;
      while (animator.isAnimating()) {
        tick();
        expect(component.scrollTop).toBeGreaterThanOrEqual(previous);
        expect(component.scrollTop).toBeLessThanOrEqual(200);
        previous = component.scrollTop;
      }
      expect(component.scrollTop).toBe(200);
    });

    it("animates both axes simultaneously", () => {
      animator.scrollBy({ x: 60, y: 90, smoothness: 8 });
      runUntilDone();
      expect(component.scrollLeft).toBe(60);
      expect(component.scrollTop).toBe(90);
    });

    it("rejects requests that cannot scroll in the requested direction", () => {
      expect(animator.scrollBy({ y: -10, smoothness: 8 })).toBe(false);
      expect(animator.isAnimating()).toBe(false);

      component.scrollTop = component.maxScrollTop;
      expect(animator.scrollBy({ y: 10, smoothness: 8 })).toBe(false);

      // Room on the other axis is enough to accept the request.
      expect(animator.scrollBy({ x: 10, y: 10, smoothness: 8 })).toBe(true);
    });

    it("accumulates targets across requests while animating", () => {
      animator.scrollBy({ y: 100, smoothness: 8 });
      tick();
      expect(animator.scrollBy({ y: 100, smoothness: 8 })).toBe(true);
      expect(animator.targetScrollTop).toBe(200);
      runUntilDone();
      expect(component.scrollTop).toBe(200);
    });

    it("keeps accepting requests at the edge while a glide is active", () => {
      animator.scrollBy({ y: component.maxScrollTop, smoothness: 8 });
      tick();
      expect(animator.scrollBy({ y: 50, smoothness: 8 })).toBe(true);
      expect(animator.targetScrollTop).toBe(component.maxScrollTop);
    });

    it("restarts from the current position when reset is true", () => {
      animator.scrollBy({ y: 400, smoothness: 8 });
      tick();
      const positionAtReset = component.scrollTop;
      animator.scrollBy({ y: 100, smoothness: 8, reset: true });
      expect(animator.targetScrollTop).toBeCloseTo(positionAtReset + 100, 6);
      runUntilDone();
      expect(component.scrollTop).toBe(positionAtReset + 100);
    });

    it("re-clamps the target when the scrollable area shrinks mid-glide", () => {
      animator.scrollBy({ y: 800, smoothness: 8 });
      tick();
      component.maxScrollTop = 100;
      runUntilDone();
      expect(component.scrollTop).toBeLessThanOrEqual(100);
      expect(animator.targetScrollTop).toBeLessThanOrEqual(100);
    });

    it("supports absolute targets via scrollTo", () => {
      component.scrollTop = 300;
      expect(animator.scrollTo({ top: 100, smoothness: 8 })).toBe(true);
      runUntilDone();
      expect(component.scrollTop).toBe(100);
    });

    it("stops without moving when cancelled and ignores further frames", () => {
      animator.scrollBy({ y: 300, smoothness: 8 });
      tick();
      const positionAtCancel = component.scrollTop;

      animator.cancel();
      expect(animator.isAnimating()).toBe(false);
      expect(component.scrollTop).toBe(positionAtCancel);
      expect(animator.targetScrollTop).toBe(positionAtCancel);

      tick();
      expect(component.scrollTop).toBe(positionAtCancel);
    });

    it("cancels the scheduled animation frame on cancel", () => {
      animator.scrollBy({ y: 300, smoothness: 8 });
      expect(rafCallbacks.length).toBe(1);
      animator.cancel();
      expect(canceledHandles.length).toBe(1);
    });

    it("finishes accepted motion before ending the lifecycle and cancels the queued frame", () => {
      const destinations = [];
      component.element.emitter.on("did-end-scroll-animation", () => {
        destinations.push([component.scrollTop, component.scrollLeft]);
      });
      animator.scrollBy({ x: 60.125, y: 300.25, smoothness: 8 });
      tick();
      const updates = component.scrollFrameUpdateCount;
      const requests = rafCallbacks.length;

      animator.finish();

      expect(component.scrollTop).toBe(300.25);
      expect(component.scrollLeft).toBe(60.125);
      expect(component.scrollFrameUpdateCount).toBe(updates + 1);
      expect(animator.isAnimating()).toBe(false);
      expect(animator.frameHandle).toBeNull();
      expect(canceledHandles.length).toBe(1);
      expect(rafCallbacks.length).toBe(requests);
      expect(destinations).toEqual([[300.25, 60.125]]);
      animator.finish();
      tick();
      expect(destinations.length).toBe(1);
      expect(component.scrollFrameUpdateCount).toBe(updates + 1);
    });

    it("bounds the final destination when the scroll range shrinks before finishing", () => {
      animator.scrollBy({ x: 400, y: 900, smoothness: 8 });
      tick();
      component.maxScrollTop = 100;
      component.maxScrollLeft = 30;

      animator.finish();

      expect(component.scrollTop).toBe(100);
      expect(component.scrollLeft).toBe(30);
      expect(animator.isAnimating()).toBe(false);
      expect(animator.velocityX).toBe(0);
      expect(animator.velocityY).toBe(0);
    });

    it("conserves fractional distance across same-direction requests", () => {
      const deltas = [0.125, 4.75, 9.0625, 0.03125, 32.5];
      for (const delta of deltas) {
        animator.scrollBy({ x: delta / 2, y: delta, smoothness: 8 });
        tick(FRAME / 2);
      }
      const total = deltas.reduce((sum, delta) => sum + delta, 0);
      runUntilDone();
      expect(component.scrollTop).toBe(total);
      expect(component.scrollLeft).toBe(total / 2);
    });

    it("preserves position and velocity when a same-direction pulse arrives", () => {
      animator.scrollBy({ x: 40, y: 100, smoothness: 8 });
      tick();
      const top = animator.virtualScrollTop;
      const left = animator.virtualScrollLeft;
      const velocityY = animator.velocityY;
      const velocityX = animator.velocityX;
      expect(velocityY).toBeGreaterThan(0);
      expect(velocityX).toBeGreaterThan(0);

      animator.scrollBy({ x: 20, y: 50, smoothness: 8 });
      expect(animator.virtualScrollTop).toBe(top);
      expect(animator.virtualScrollLeft).toBe(left);
      expect(animator.velocityY).toBe(velocityY);
      expect(animator.velocityX).toBe(velocityX);
      expect(animator.targetScrollTop).toBe(150);
      expect(animator.targetScrollLeft).toBe(60);
    });

    it("reverses promptly instead of completing the old direction first", () => {
      animator.scrollBy({ y: 400, smoothness: 8 });
      tick(50);
      const top = animator.virtualScrollTop;
      expect(top).toBeGreaterThan(10);
      animator.scrollBy({ y: -10, smoothness: 8 });
      expect(animator.targetScrollTop).toBe(top - 10);
      expect(animator.velocityY).toBe(0);
      tick();
      expect(component.scrollTop).toBeLessThan(top);
      runUntilDone();
      expect(component.scrollTop).toBe(top - 10);
    });

    it("reverses only the affected axis", () => {
      animator.scrollBy({ x: 100, y: 200, smoothness: 8 });
      tick(50);
      const left = animator.virtualScrollLeft;
      const velocityY = animator.velocityY;
      animator.scrollBy({ x: -5, y: 20, smoothness: 8 });
      expect(animator.targetScrollLeft).toBe(left - 5);
      expect(animator.velocityX).toBe(0);
      expect(animator.targetScrollTop).toBe(220);
      expect(animator.velocityY).toBe(velocityY);
      runUntilDone();
      expect(component.scrollLeft).toBe(left - 5);
      expect(component.scrollTop).toBe(220);
    });

    it("clears old velocity when restarting from the current position", () => {
      animator.scrollBy({ x: 100, y: 400, smoothness: 8 });
      tick();
      animator.scrollBy({ y: 100, smoothness: 8, reset: true });
      expect(animator.velocityX).toBe(0);
      expect(animator.velocityY).toBe(0);
    });

    it("clamps position and velocity when a reflow puts them past the end", () => {
      animator.scrollBy({ y: 800, smoothness: 8 });
      tick(50);
      expect(component.scrollTop).toBeGreaterThan(100);
      component.maxScrollTop = 100;
      tick();
      expect(component.scrollTop).toBe(100);
      expect(animator.targetScrollTop).toBe(100);
      expect(animator.velocityY).toBe(0);
      expect(animator.isAnimating()).toBe(false);
    });

    it("preserves the absolute endpoint when scrollTo reverses a running glide", () => {
      component.scrollTop = 300;
      animator.scrollTo({ top: 450, smoothness: 8 });
      tick();
      animator.scrollTo({ top: 100, smoothness: 8 });
      expect(animator.targetScrollTop).toBe(100);
      expect(animator.velocityY).toBe(0);
      runUntilDone();
      expect(component.scrollTop).toBe(100);
    });

    it("does not overshoot a nearby absolute target while moving quickly", () => {
      animator.scrollBy({ y: 800, smoothness: 8 });
      tick(50);
      const target = component.scrollTop + 1;
      const velocityY = animator.velocityY;
      expect(velocityY).toBeGreaterThan(0);
      animator.scrollTo({ top: target, smoothness: 8 });
      expect(animator.velocityY).toBe(velocityY);
      for (let frames = 0; animator.isAnimating() && frames < 1000; frames++) {
        tick();
        expect(component.scrollTop).toBeLessThanOrEqual(target);
      }
      expect(animator.isAnimating()).toBe(false);
      expect(component.scrollTop).toBe(target);
      expect(animator.velocityY).toBe(0);
    });

    it("stops old velocity when the absolute destination is the current position", () => {
      animator.scrollBy({ y: 800, smoothness: 8 });
      tick(50);
      const top = component.scrollTop;
      expect(animator.velocityY).toBeGreaterThan(0);
      animator.scrollTo({ top, smoothness: 8 });
      expect(animator.targetScrollTop).toBe(top);
      expect(animator.velocityY).toBe(0);
      tick();
      expect(component.scrollTop).toBe(top);
      expect(animator.isAnimating()).toBe(false);
    });

    it("clears both velocities on cancellation", () => {
      animator.scrollBy({ x: 60, y: 300, smoothness: 8 });
      tick();
      animator.cancel();
      expect(animator.velocityY).toBe(0);
      expect(animator.velocityX).toBe(0);
    });

    it("lands exactly on small fractional endpoints after a long frame", () => {
      animator.scrollBy({ x: 0.0125, y: 0.02, smoothness: 8 });
      tick(1000);
      runUntilDone();
      expect(component.scrollTop).toBe(0.02);
      expect(component.scrollLeft).toBe(0.0125);
    });

    it("does not move when no time has elapsed", () => {
      animator.scrollBy({ y: 100, smoothness: 8 });
      tick(0);
      expect(component.scrollTop).toBe(0);
      expect(animator.velocityY).toBe(0);
      expect(animator.isAnimating()).toBe(true);
    });

    it("preserves immediate scrolling at the lowest smoothness settings", () => {
      for (const smoothness of [1, 2]) {
        component.scrollTop = 50;
        animator.scrollBy({ y: 25, smoothness });
        tick();
        expect(component.scrollTop).toBe(75);
        expect(animator.velocityY).toBe(0);
        expect(animator.isAnimating()).toBe(false);
      }
    });

    it("ignores negative elapsed time without reversing the trajectory", () => {
      animator.scrollBy({ y: 100, smoothness: 8 });
      tick();
      const top = component.scrollTop;
      const velocityY = animator.velocityY;
      animator.advance(-50);
      expect(component.scrollTop).toBe(top);
      expect(animator.velocityY).toBe(velocityY);
      runUntilDone();
      expect(component.scrollTop).toBe(100);
    });

    it("settles safely after a long pause", () => {
      animator.scrollBy({ x: 80, y: 300, smoothness: 8 });
      tick(5000);
      expect(component.scrollTop).toBe(300);
      expect(component.scrollLeft).toBe(80);
      expect(animator.velocityY).toBe(0);
      expect(animator.velocityX).toBe(0);
      expect(animator.isAnimating()).toBe(false);
    });

    it("ends a small glide at a finite deadline with zero velocity", () => {
      animator.scrollBy({ x: 60, y: 90, smoothness: 8 });
      tick(119);
      expect(component.scrollTop).toBeGreaterThan(0);
      expect(component.scrollTop).toBeLessThan(90);
      expect(animator.isAnimating()).toBe(true);
      tick(1);
      expect(component.scrollTop).toBe(90);
      expect(component.scrollLeft).toBe(60);
      expect(animator.velocityY).toBe(0);
      expect(animator.velocityX).toBe(0);
      expect(animator.isAnimating()).toBe(false);
    });

    it("completes a large movement faster than a small movement", () => {
      const largeComponent = buildMockComponent();
      const large = new ScrollAnimator(largeComponent, {
        now: () => now,
        requestAnimationFrame: () => 0,
      });
      animator.scrollBy({ y: 120, smoothness: 8 });
      large.scrollBy({ y: 480, smoothness: 8 });
      tick(60);
      large.step(now);
      expect(largeComponent.scrollTop).toBe(480);
      expect(large.velocityY).toBe(0);
      expect(large.isAnimating()).toBe(false);
      expect(component.scrollTop).toBeGreaterThan(0);
      expect(component.scrollTop).toBeLessThan(120);
      expect(animator.isAnimating()).toBe(true);
      tick(60);
      expect(component.scrollTop).toBe(120);
      expect(animator.isAnimating()).toBe(false);
    });

    it("does not postpone the endpoint for repeated requests clamped to the same edge", () => {
      animator.scrollBy({ y: component.maxScrollTop, smoothness: 8 });
      for (let i = 0; i < 9; i++) {
        tick(6);
        animator.scrollBy({ y: 100, smoothness: 8 });
      }
      tick(6);
      expect(component.scrollTop).toBe(component.maxScrollTop);
      expect(animator.velocityY).toBe(0);
      expect(animator.isAnimating()).toBe(false);
    });

    it("does not restart the curve when its absolute target stays the same", () => {
      animator.scrollTo({ top: 480, smoothness: 8 });
      tick(30);
      animator.scrollTo({ top: 480, smoothness: 8 });
      tick(30);
      expect(component.scrollTop).toBe(480);
      expect(animator.velocityY).toBe(0);
      expect(animator.isAnimating()).toBe(false);
    });

    it("does not extend one axis when the other axis receives new input", () => {
      animator.scrollBy({ x: 480, smoothness: 8 });
      tick(30);
      animator.scrollBy({ y: 120, smoothness: 8 });
      tick(30);
      expect(component.scrollLeft).toBe(480);
      expect(animator.velocityX).toBe(0);
      expect(component.scrollTop).toBeLessThan(120);
      runUntilDone();
      expect(component.scrollTop).toBe(120);
    });

    it("retains the exact accumulated endpoint for very small fractional pulses", () => {
      const deltas = Array.from({ length: 40 }, (_, i) => [0.001, 0.0001, 0.0000001][i % 3]);
      for (const delta of deltas) {
        animator.scrollBy({ x: delta / 2, y: delta, smoothness: 8 });
        tick(2);
      }
      runUntilDone();
      const total = deltas.reduce((sum, delta) => sum + delta, 0);
      expect(component.scrollTop).toBe(total);
      expect(component.scrollLeft).toBe(total / 2);
    });

    it("uses actual elapsed time for the first frame at a high refresh rate", () => {
      now = 1000;
      animator.scrollBy({ y: 100, smoothness: 8 });
      tick(FRAME / 2);
      const top = component.scrollTop;
      const velocityY = animator.velocityY;
      const referenceComponent = buildMockComponent();
      const reference = new ScrollAnimator(referenceComponent, {
        now: () => 1000,
        requestAnimationFrame: () => 0,
      });
      reference.scrollBy({ y: 100, smoothness: 8 });
      reference.advance(FRAME / 2);
      expect(top).toBeGreaterThan(0);
      expect(top).toBeCloseTo(referenceComponent.scrollTop, 10);
      expect(velocityY).toBeCloseTo(reference.velocityY, 10);
    });

    it("gives a fresh pulse only its own elapsed time after a delayed frame", () => {
      const referenceComponent = buildMockComponent();
      const reference = new ScrollAnimator(referenceComponent, {
        now: () => now,
        requestAnimationFrame: () => 0,
      });
      animator.scrollBy({ y: 100, smoothness: 8 });
      reference.scrollBy({ y: 100, smoothness: 8 });
      tick();
      reference.advance(FRAME);
      now = 119;
      reference.advance(119 - FRAME);
      const positionBeforeRetarget = referenceComponent.scrollTop;
      animator.scrollBy({ y: 100, smoothness: 8, timestamp: 119 });
      reference.scrollBy({ y: 100, smoothness: 8, timestamp: 119 });
      expect(animator.virtualScrollTop).toBeCloseTo(positionBeforeRetarget, 8);
      expect(animator.virtualScrollTop).toBeGreaterThan(component.scrollTop);
      animator.step(120);
      reference.advance(1);
      expect(component.scrollTop).toBeCloseTo(referenceComponent.scrollTop, 8);
      expect(animator.velocityY).toBeCloseTo(reference.velocityY, 8);
      expect(component.scrollTop).toBeLessThan(200);
      expect(animator.isAnimating()).toBe(true);
      expect(animator.targetScrollTop).toBe(200);
    });

    it("batches input-time movement into the next frame even at the same timestamp", () => {
      animator.scrollBy({ y: 100, smoothness: 8 });
      tick();
      const top = component.scrollTop;
      const updates = component.scrollFrameUpdateCount;
      now = 50;
      animator.scrollBy({ y: 50, smoothness: 8, timestamp: now });
      expect(component.scrollTop).toBe(top);
      expect(component.scrollFrameUpdateCount).toBe(updates);
      expect(animator.virtualScrollTop).toBeGreaterThan(top);
      animator.step(now);
      expect(component.scrollTop).toBe(animator.virtualScrollTop);
      expect(component.scrollFrameUpdateCount).toBe(updates + 1);
    });

    it("uses the injected clock when a request omits its timestamp", () => {
      const explicitComponent = buildMockComponent();
      const explicit = new ScrollAnimator(explicitComponent, {
        now: () => now,
        requestAnimationFrame: () => 0,
      });
      animator.scrollBy({ y: 100, smoothness: 8 });
      explicit.scrollBy({ y: 100, smoothness: 8 });
      tick();
      explicit.step(now);
      now = 90;
      animator.scrollBy({ y: 50, smoothness: 8 });
      explicit.scrollBy({ y: 50, smoothness: 8, timestamp: 90 });
      animator.step(100);
      explicit.step(100);
      expect(component.scrollTop).toBeCloseTo(explicitComponent.scrollTop, 10);
      expect(animator.velocityY).toBeCloseTo(explicit.velocityY, 10);
    });

    it("does not rewind its clock for stale request or frame timestamps", () => {
      const referenceComponent = buildMockComponent();
      const reference = new ScrollAnimator(referenceComponent, {
        now: () => now,
        requestAnimationFrame: () => 0,
      });
      animator.scrollBy({ y: 100, smoothness: 8, timestamp: 0 });
      reference.scrollBy({ y: 100, smoothness: 8, timestamp: 0 });
      tick(50);
      reference.step(50);
      const top = component.scrollTop;
      animator.step(30);
      expect(component.scrollTop).toBe(top);
      animator.scrollBy({ y: 20, smoothness: 8, timestamp: 30 });
      reference.scrollBy({ y: 20, smoothness: 8, timestamp: 50 });
      animator.step(60);
      reference.step(60);
      expect(component.scrollTop).toBeCloseTo(referenceComponent.scrollTop, 10);
      expect(animator.velocityY).toBeCloseTo(reference.velocityY, 10);
      runUntilDone();
      expect(component.scrollTop).toBe(120);
    });

    describe("distance scaling", () => {
      function referenceAnimator(referenceComponent) {
        return new ScrollAnimator(referenceComponent, {
          now: () => now,
          requestAnimationFrame: () => 0,
        });
      }

      it("scales diagonal distance without changing the normal animation phase", () => {
        const reference = buildMockComponent();
        const normal = referenceAnimator(reference);
        animator.scrollBy({ x: 180, y: 450, distanceScale: 7.5, smoothness: 8 });
        normal.scrollBy({ x: 24, y: 60, smoothness: 8 });
        for (let frames = 0; animator.isAnimating() && frames < 1000; frames++) {
          tick();
          normal.step(now);
          expect(component.scrollTop / 7.5).toBeCloseTo(reference.scrollTop, 9);
          expect(component.scrollLeft / 7.5).toBeCloseTo(reference.scrollLeft, 9);
          expect(animator.velocityY / 7.5).toBeCloseTo(normal.velocityY, 9);
          expect(animator.velocityX / 7.5).toBeCloseTo(normal.velocityX, 9);
          expect(animator.isAnimating()).toBe(normal.isAnimating());
        }
        expect(component.scrollTop).toBe(450);
        expect(component.scrollLeft).toBe(180);
        expect(animator.isAnimating()).toBe(false);
      });

      it("retains the original timing debt when normal and Alt inputs are mixed", () => {
        const reference = buildMockComponent();
        const combined = referenceAnimator(reference);
        animator.scrollBy({ y: 60, smoothness: 8 });
        combined.scrollBy({ y: 60, smoothness: 8 });
        tick(30);
        combined.step(now);
        const velocityY = animator.velocityY;
        const remainingNormalDistance = animator.pendingY();
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        expect(animator.curveY.timingDistance).toBeCloseTo(remainingNormalDistance + 60, 9);
        expect(animator.velocityY).toBe(velocityY);
        animator.scrollBy({ y: 60, smoothness: 8 });
        expect(animator.velocityY).toBe(velocityY);

        // The simultaneous 450px Alt and 60px normal inputs carry 120px of
        // timing distance. Combining them must keep the earlier normal debt.
        combined.scrollBy({ y: 510, distanceScale: 4.25, smoothness: 8 });
        for (let frames = 0; animator.isAnimating() && frames < 1000; frames++) {
          tick();
          combined.step(now);
          expect(component.scrollTop).toBeCloseTo(reference.scrollTop, 8);
          expect(animator.velocityY).toBeCloseTo(combined.velocityY, 8);
        }
        expect(component.scrollTop).toBe(570);
        expect(animator.isAnimating()).toBe(false);
      });

      it("drops the reversed axis's old timing debt", () => {
        component.scrollTop = 1000;
        component.maxScrollTop = 10000;
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const top = component.scrollTop;
        animator.scrollBy({ y: -30, distanceScale: 7.5, smoothness: 8 });
        expect(animator.curveY.timingDistance).toBe(-4);
        expect(animator.velocityY).toBe(0);
        runUntilDone();
        expect(component.scrollTop).toBe(top - 30);
      });

      it("keeps normal timing when a scaled destination is clamped by a reflow", () => {
        const reference = buildMockComponent();
        const normal = referenceAnimator(reference);
        component.maxScrollTop = 10000;
        animator.scrollBy({ y: 3600, distanceScale: 7.5, smoothness: 8 });
        normal.scrollBy({ y: 480, smoothness: 8 });
        tick(20);
        normal.step(now);
        component.maxScrollTop = 1800;
        reference.maxScrollTop = 240;
        for (let frames = 0; animator.isAnimating() && frames < 1000; frames++) {
          tick();
          normal.step(now);
          expect(component.scrollTop / 7.5).toBeCloseTo(reference.scrollTop, 8);
          expect(animator.velocityY / 7.5).toBeCloseTo(normal.velocityY, 8);
          expect(animator.isAnimating()).toBe(normal.isAnimating());
        }
        expect(component.scrollTop).toBe(1800);
        expect(animator.isAnimating()).toBe(false);
      });

      it("retains timing metadata and the deadline when momentum translates a scaled glide", () => {
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const curve = animator.curveY;
        const timingDistance = curve.timingDistance;
        const velocityY = animator.velocityY;
        const deadline = now + curve.duration - curve.elapsed;
        animator.scrollBy({ y: 75, distanceScale: 7.5, momentum: true });
        expect(animator.curveY).toBe(curve);
        expect(curve.timingDistance).toBe(timingDistance);
        expect(animator.velocityY).toBe(velocityY);
        expect(now + curve.duration - curve.elapsed).toBe(deadline);
        runUntilDone();
        expect(component.scrollTop).toBe(525);
      });

      it("uses the new input's scale when resetting an existing glide", () => {
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const top = component.scrollTop;
        animator.scrollBy({ y: 60, smoothness: 8, reset: true });
        expect(animator.curveY.timingDistance).toBeCloseTo(60, 9);
        expect(animator.velocityY).toBe(0);
        runUntilDone();
        expect(component.scrollTop).toBe(top + 60);
      });

      it("uses the actual distance for a changed absolute destination", () => {
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const top = component.scrollTop;
        animator.scrollTo({ top: 480, smoothness: 8 });
        expect(animator.curveY.timingDistance).toBe(480 - top);
        runUntilDone();
        expect(component.scrollTop).toBe(480);
      });

      it("does not reinterpret an unchanged absolute destination", () => {
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const curve = animator.curveY;
        const timingDistance = curve.timingDistance;
        animator.scrollTo({ top: 450, smoothness: 8 });
        expect(animator.curveY).toBe(curve);
        expect(curve.timingDistance).toBe(timingDistance);
        tick(90);
        expect(component.scrollTop).toBe(450);
        expect(animator.isAnimating()).toBe(false);
      });

      it("preserves scaled timing debt when only absolute smoothness changes on an axis", () => {
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const velocityY = animator.velocityY;
        animator.scrollTo({ left: 100, smoothness: 20 });
        expect(animator.targetScrollTop).toBe(450);
        expect(animator.curveY.timingDistance).toBeCloseTo(animator.pendingY() / 7.5, 9);
        expect(animator.velocityY).toBe(velocityY);
        tick(10);
        const nextVelocityY = animator.velocityY;
        animator.scrollTo({ top: 450, smoothness: 8 });
        expect(animator.curveY.timingDistance).toBeCloseTo(animator.pendingY() / 7.5, 9);
        expect(animator.velocityY).toBe(nextVelocityY);
        runUntilDone();
        expect(component.scrollTop).toBe(450);
        expect(component.scrollLeft).toBe(100);
      });

      it("does not extend the other axis when input changes distance scale", () => {
        animator.scrollBy({ x: 480, smoothness: 8 });
        tick(30);
        const curveX = animator.curveX;
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        expect(animator.curveX).toBe(curveX);
        tick(30);
        expect(component.scrollLeft).toBe(480);
        expect(animator.velocityX).toBe(0);
        expect(component.scrollTop).toBeLessThan(450);
        runUntilDone();
        expect(component.scrollTop).toBe(450);
      });

      it("keeps a clamped request from replacing a scaled curve or postponing its endpoint", () => {
        component.maxScrollTop = 450;
        animator.scrollBy({ y: 450, distanceScale: 7.5, smoothness: 8 });
        tick(30);
        const curve = animator.curveY;
        const timingDistance = curve.timingDistance;
        animator.scrollBy({ y: 60, smoothness: 8 });
        expect(animator.curveY).toBe(curve);
        expect(curve.timingDistance).toBe(timingDistance);
        tick(90);
        expect(component.scrollTop).toBe(450);
        expect(animator.isAnimating()).toBe(false);
      });

      it("retains exact fractional totals for scaled input", () => {
        const deltas = [0.125, 4.75, 9.0625, 0.03125, 32.5];
        for (const delta of deltas) {
          animator.scrollBy({
            x: (delta * 7.5) / 2,
            y: delta * 7.5,
            distanceScale: 7.5,
            smoothness: 8,
          });
          tick(FRAME / 2);
        }
        runUntilDone();
        const total = deltas.reduce((sum, delta) => sum + delta * 7.5, 0);
        expect(component.scrollTop).toBe(total);
        expect(component.scrollLeft).toBe(total / 2);
      });

      it("treats invalid distance scales as normal input", () => {
        for (const distanceScale of [0, -1, NaN, Infinity]) {
          component.scrollTop = 0;
          animator.scrollBy({ y: 60, distanceScale, smoothness: 8 });
          expect(animator.curveY.timingDistance).toBe(60);
          tick(119);
          expect(component.scrollTop).toBeLessThan(60);
          tick(1);
          expect(component.scrollTop).toBe(60);
          expect(animator.isAnimating()).toBe(false);
        }
      });
    });

    describe("system momentum", () => {
      it("batches fractional idle momentum into one frame without an easing curve", () => {
        expect(animator.scrollBy({ x: 5.125, y: 10.25, smoothness: 8, momentum: true })).toBe(true);
        expect(animator.scrollBy({ x: 0.375, y: 3.75, smoothness: 8, momentum: true })).toBe(true);
        expect(component.scrollLeft).toBe(0);
        expect(component.scrollTop).toBe(0);
        expect(animator.pendingX()).toBe(0);
        expect(animator.pendingY()).toBe(0);
        expect(animator.curveX).toBeNull();
        expect(animator.curveY).toBeNull();
        expect(rafCallbacks.length).toBe(1);

        tick(1000 / 120);

        expect(component.scrollLeft).toBe(5.5);
        expect(component.scrollTop).toBe(14);
        expect(component.scrollFrameUpdateCount).toBe(1);
        expect(animator.isAnimating()).toBe(false);
        expect(rafCallbacks.length).toBe(1);
      });

      it("retains the wheel deadline and endpoint without a transition jump", () => {
        const frame = 1000 / 120;
        let previousStep = 0;
        for (let input = 0; input < 12; input++) {
          animator.scrollBy({ y: 9.6, smoothness: 8, timestamp: now });
          const previousPosition = component.scrollTop;
          tick(frame);
          previousStep = component.scrollTop - previousPosition;
        }
        const position = component.scrollTop;
        const pending = animator.pendingY();
        const curve = animator.curveY;
        const deadline = now + curve.duration - curve.elapsed;
        const endpoint = animator.targetScrollTop + 9.6;
        const velocity = animator.velocityY;

        animator.scrollBy({ y: 9.6, smoothness: 8, momentum: true, timestamp: now });

        expect(component.scrollTop).toBe(position);
        expect(animator.pendingY()).toBeCloseTo(pending, 10);
        expect(animator.velocityY).toBe(velocity);
        expect(animator.curveY).toBe(curve);
        expect(now + curve.duration - curve.elapsed).toBe(deadline);
        tick(frame);
        expect(component.scrollTop - position).toBeLessThan(previousStep * 3);
        expect(component.scrollTop).toBeLessThan(endpoint);
        runUntilDone();
        expect(component.scrollTop).toBe(endpoint);
        expect(now).toBeLessThan(deadline + FRAME);
      });

      it("does not flush or retarget the other axis for horizontal-only momentum", () => {
        const reference = buildMockComponent();
        const referenceAnimator = new ScrollAnimator(reference, {
          now: () => now,
          requestAnimationFrame: () => 0,
        });
        animator.scrollBy({ x: 40, y: 100, smoothness: 8 });
        referenceAnimator.scrollBy({ x: 40, y: 100, smoothness: 8 });
        tick();
        referenceAnimator.step(now);
        const curveY = animator.curveY;
        const deadline = now + curveY.duration - curveY.elapsed;

        animator.scrollBy({ x: 4, smoothness: 20, momentum: true, timestamp: now });

        expect(animator.smoothness).toBe(8);
        expect(animator.curveY).toBe(curveY);
        expect(now + curveY.duration - curveY.elapsed).toBe(deadline);
        tick();
        referenceAnimator.step(now);
        expect(component.scrollTop).toBe(reference.scrollTop);
        expect(component.scrollLeft).toBeCloseTo(reference.scrollLeft + 4, 10);
        runUntilDone();
        expect(component.scrollTop).toBe(100);
        expect(component.scrollLeft).toBe(44);
      });

      it("accepts edge momentum until the existing glide reaches its original deadline", () => {
        animator.scrollBy({ y: component.maxScrollTop, smoothness: 8 });
        tick();
        const curve = animator.curveY;
        const deadline = now + curve.duration - curve.elapsed;
        const virtualPosition = animator.virtualScrollTop;

        expect(animator.scrollBy({ y: 50, momentum: true, timestamp: now })).toBe(true);
        expect(animator.curveY).toBe(curve);
        expect(animator.virtualScrollTop).toBe(virtualPosition);
        expect(now + curve.duration - curve.elapsed).toBe(deadline);
        tick();
        expect(component.scrollTop).toBeLessThan(component.maxScrollTop);
        runUntilDone();
        expect(component.scrollTop).toBe(component.maxScrollTop);
        expect(animator.scrollBy({ y: 50, momentum: true })).toBe(false);
        expect(animator.isAnimating()).toBe(false);
      });

      it("translates a glide by only the accepted part of a bounded momentum delta", () => {
        component.scrollTop = 800;
        animator.scrollBy({ y: 100, smoothness: 8 });
        tick();
        const position = animator.virtualScrollTop;
        const curve = animator.curveY;
        const origin = curve.position;
        const deadline = now + curve.duration - curve.elapsed;

        animator.scrollBy({ y: 200, momentum: true, timestamp: now });

        expect(animator.targetScrollTop).toBe(1000);
        expect(animator.virtualScrollTop).toBe(position + 100);
        expect(curve.position).toBe(origin + 100);
        expect(curve.distance).toBe(100);
        expect(now + curve.duration - curve.elapsed).toBe(deadline);
        runUntilDone();
        expect(component.scrollTop).toBe(1000);
      });

      it("cancels only the reversed axis's old glide before applying its momentum delta", () => {
        animator.scrollBy({ x: 100, y: 200, smoothness: 8 });
        tick();
        const positionX = component.scrollLeft;
        const curveY = animator.curveY;
        const deadlineY = now + curveY.duration - curveY.elapsed;

        animator.scrollBy({ x: -2, momentum: true, timestamp: now });

        expect(animator.curveX).toBeNull();
        expect(animator.velocityX).toBe(0);
        expect(animator.targetScrollLeft).toBe(positionX - 2);
        expect(animator.curveY).toBe(curveY);
        expect(now + curveY.duration - curveY.elapsed).toBe(deadlineY);
        tick();
        expect(component.scrollLeft).toBe(positionX - 2);
        expect(component.scrollTop).toBeGreaterThan(0);
        runUntilDone();
        expect(component.scrollLeft).toBe(positionX - 2);
        expect(component.scrollTop).toBe(200);
      });

      it("bounds reversal and an extent shrink before publishing momentum", () => {
        animator.scrollBy({ x: 400, y: 800, smoothness: 8 });
        tick();
        component.maxScrollTop = 70;
        component.maxScrollLeft = 20;

        animator.scrollBy({ x: -100, y: 20, momentum: true, timestamp: now });
        tick();
        expect(component.scrollLeft).toBe(0);
        expect(component.scrollTop).toBeLessThanOrEqual(70);
        expect(animator.targetScrollTop).toBe(70);
        runUntilDone();
        expect(component.scrollTop).toBe(70);
        expect(component.scrollLeft).toBe(0);
      });

      it("can cancel unpublished momentum or finish it together with a remaining wheel glide", () => {
        animator.scrollBy({ x: 4, y: 10, momentum: true });
        animator.cancel();
        tick();
        expect(component.scrollLeft).toBe(0);
        expect(component.scrollTop).toBe(0);
        expect(animator.isAnimating()).toBe(false);
        expect(canceledHandles.length).toBe(1);

        animator.scrollBy({ y: 100, smoothness: 8 });
        tick();
        animator.scrollBy({ x: 4, y: 25, momentum: true, timestamp: now });
        const end = jasmine.createSpy("end");
        component.element.emitter.on("did-end-scroll-animation", end);
        animator.finish();
        expect(component.scrollLeft).toBe(4);
        expect(component.scrollTop).toBe(125);
        expect(animator.isAnimating()).toBe(false);
        expect(end).toHaveBeenCalledTimes(1);
        tick();
        expect(end).toHaveBeenCalledTimes(1);
      });
    });

    describe("continuous wheel input", () => {
      function runTrain(events, fps = 60, distanceScale = 1) {
        let time = 0;
        const trainComponent = buildMockComponent();
        trainComponent.maxScrollTop = 100000;
        const trainAnimator = new ScrollAnimator(trainComponent, {
          now: () => time,
          requestAnimationFrame: () => 0,
        });
        const positions = [0];
        const velocities = [0];
        const lifecycle = { started: 0, ended: 0 };
        trainComponent.element.emitter.on("did-start-scroll-animation", () => lifecycle.started++);
        trainComponent.element.emitter.on("did-end-scroll-animation", () => lifecycle.ended++);
        let eventIndex = 0;
        const duration = events[events.length - 1].time + 1000;
        for (let frame = 1; (frame * 1000) / fps <= duration; frame++) {
          const timestamp = (frame * 1000) / fps;
          while (eventIndex < events.length && events[eventIndex].time <= timestamp) {
            const event = events[eventIndex++];
            time = event.time;
            trainAnimator.scrollBy({
              y: event.delta * distanceScale,
              distanceScale,
              smoothness: 8,
              momentum: event.momentum,
              timestamp: time,
            });
          }
          time = timestamp;
          trainAnimator.step(timestamp);
          positions.push(trainComponent.scrollTop);
          velocities.push(trainAnimator.velocityY);
        }
        for (let frames = 0; trainAnimator.isAnimating() && frames < 1000; frames++) {
          time += FRAME;
          trainAnimator.step(time);
        }
        expect(trainAnimator.isAnimating()).toBe(false);
        return { component: trainComponent, positions, velocities, lifecycle };
      }

      it("keeps Alt timing and lifecycles equal to normal input across wheel sequences", () => {
        const sequences = [
          [{ time: 0, delta: 60 }],
          Array.from({ length: 8 }, (_, i) => ({ time: i * 17, delta: 60 })),
          [0, 16, 33, 52, 74, 100, 132, 171, 218, 276, 345, 428, 528, 648, 790, 955].map(
            (time) => ({ time, delta: 60 }),
          ),
          Array.from({ length: 40 }, (_, i) => ({ time: i * 17, delta: 60 * Math.pow(0.92, i) })),
          [
            { time: 0, delta: 60 },
            { time: 30, delta: 10, momentum: true },
            { time: 40, delta: 60 },
          ],
        ];
        for (const events of sequences) {
          const normal = runTrain(events);
          const scaled = runTrain(events, 60, 7.5);
          expect(scaled.positions.length).toBe(normal.positions.length);
          for (let frame = 0; frame < normal.positions.length; frame++) {
            expect(scaled.positions[frame] / 7.5).toBeCloseTo(normal.positions[frame], 7);
            expect(scaled.velocities[frame] / 7.5).toBeCloseTo(normal.velocities[frame], 7);
          }
          expect(scaled.lifecycle).toEqual(normal.lifecycle);
          expect(scaled.component.scrollTop / 7.5).toBeCloseTo(normal.component.scrollTop, 8);
        }
      });

      it("preserves distance and forward motion as fixed pulses become farther apart", () => {
        const times = [0, 16, 33, 52, 74, 100, 132, 171, 218, 276, 345, 428, 528, 648, 790, 955];
        const events = times.map((time) => ({ time, delta: 48 }));
        const result = runTrain(events);
        for (let i = 1; i < result.positions.length; i++) {
          expect(result.positions[i]).toBeGreaterThanOrEqual(result.positions[i - 1]);
        }
        expect(result.component.scrollTop).toBe(events.length * 48);
      });

      it("preserves distance and forward motion as pulse amplitudes decline", () => {
        const events = Array.from({ length: 80 }, (_, i) => ({
          time: i * 12.5,
          delta: 48 * Math.pow(0.96, i),
        }));
        const result = runTrain(events);
        for (let i = 1; i < result.positions.length; i++) {
          expect(result.positions[i]).toBeGreaterThanOrEqual(result.positions[i - 1]);
        }
        expect(result.component.scrollTop).toBeCloseTo(
          events.reduce((sum, event) => sum + event.delta, 0),
          8,
        );
      });

      it("keeps a timestamped pulse train consistent at 60, 120 and 144 Hz", () => {
        const events = [0, 11, 35, 73, 124, 189, 270, 366, 478].map((time, i) => ({
          time,
          delta: 50 - i * 4.5,
        }));
        const rates = [60, 120, 144];
        const results = rates.map((fps) => runTrain(events, fps));
        const at500ms = results.map((result, index) => result.positions[rates[index] / 2]);
        expect(at500ms[0]).toBeCloseTo(at500ms[1], 7);
        expect(at500ms[0]).toBeCloseTo(at500ms[2], 7);
        const total = events.reduce((sum, event) => sum + event.delta, 0);
        for (const result of results) expect(result.component.scrollTop).toBe(total);
      });
    });

    describe("events", () => {
      let started, ended;

      beforeEach(() => {
        started = 0;
        ended = 0;
        component.element.emitter.on("did-start-scroll-animation", () => started++);
        component.element.emitter.on("did-end-scroll-animation", () => ended++);
      });

      it("emits start and end exactly once per glide", () => {
        animator.scrollBy({ y: 100, smoothness: 8 });
        expect(started).toBe(1);
        expect(ended).toBe(0);

        // Additional requests during the glide don't re-emit start.
        animator.scrollBy({ y: 50, smoothness: 8 });
        expect(started).toBe(1);

        runUntilDone();
        expect(ended).toBe(1);
      });

      it("keeps one animation lifecycle throughout an extended wheel train", () => {
        for (let i = 0; i < 20; i++) {
          animator.scrollBy({ y: 20, smoothness: 8 });
          tick(25);
        }
        expect(started).toBe(1);
        expect(ended).toBe(0);
        runUntilDone();
        expect(ended).toBe(1);
      });

      it("keeps the same animation lifecycle when changing direction", () => {
        animator.scrollBy({ y: 100, smoothness: 8 });
        tick();
        animator.scrollBy({ y: -5, smoothness: 8 });
        expect(started).toBe(1);
        expect(ended).toBe(0);
        runUntilDone();
        expect(ended).toBe(1);
      });

      it("emits end when cancelled mid-glide, and not when already idle", () => {
        animator.scrollBy({ y: 100, smoothness: 8 });
        animator.cancel();
        expect(ended).toBe(1);
        animator.cancel();
        expect(ended).toBe(1);
      });
    });
  });
});
