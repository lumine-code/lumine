const { test } = require("node:test");
const assert = require("node:assert/strict");
const Queue = require("../../src/scroll-presentation");

function fixture() {
  let revision = 0,
    position = 0,
    maximum = 1000,
    nextFrame = 0;
  const ready = new Set(),
    frames = new Map(),
    commits = [],
    requests = [],
    leases = new Map();
  const mode = {
    asynchronousSyntax: true,
    requestHighlighting(owner, ranges) {
      if (!ranges.length) leases.delete(owner);
    },
  };
  const component = {
    attached: true,
    visible: true,
    hasInitialMeasurements: true,
    props: {
      model: {
        isDestroyed: () => false,
        getBuffer: () => ({ getLanguageMode: () => mode, getTextRevision: () => revision }),
        displayLayer: {
          prepareHighlightingForScreenRows(first, last, owner, options) {
            requests.push(first);
            leases.set(owner, { first, last, ...options });
            return ready.has(revision + ":" + first);
          },
        },
      },
    },
    window: {
      requestAnimationFrame(callback) {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
    },
    getScrollTop: () => position,
    getMaxScrollTop: () => maximum,
    rowForPixelPosition: (value) => value,
    tileStartRowForRow: (value) => value,
    getVisibleTileCount: () => 1,
    getRowsPerTile: () => 1,
    commitScrollPresentation(top) {
      assert.ok(ready.has(revision + ":" + top), "never publish an uncolored viewport");
      position = top;
      commits.push(top);
      return true;
    },
  };
  const queue = new Queue(component);
  return {
    queue,
    component,
    requests,
    commits,
    frames,
    leases,
    ready(top) {
      ready.add(revision + ":" + top);
      queue.update();
    },
    evict(top) {
      ready.delete(revision + ":" + top);
    },
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const fn of callbacks) fn();
    },
    revise() {
      revision++;
    },
    resize(value) {
      maximum = value;
    },
  };
}

test("cached scroll input commits immediately", () => {
  const f = fixture();
  f.ready(100);
  f.queue.request(100);
  assert.deepEqual(f.commits, [100]);
  assert.equal(f.frames.size, 0);
  assert.equal(f.leases.size, 0);
});

test("an existing layout pass can consume a ready destination without a nested commit", () => {
  const f = fixture();
  f.ready(100);
  assert.equal(f.queue.request(100, { defer: true, inlineReady: true }), false);
  assert.deepEqual(f.commits, []);
  assert.equal(f.frames.size, 0);
  assert.equal(f.leases.size, 0);
});

test("cold scrolling makes progress while coalescing newer destinations", async () => {
  const f = fixture();
  f.queue.request(100);
  f.queue.request(200);
  f.queue.request(300);
  let settled = false;
  const done = f.queue.whenSettled().then(() => (settled = true));
  assert.deepEqual(f.commits, []);
  assert.ok(!f.requests.includes(200));
  assert.ok(!f.requests.includes(300));
  f.ready(100);
  assert.equal(f.queue.pendingTop, 300);
  assert.equal(f.leases.get(f.queue.readyOwner).priority, 1);
  f.frame();
  assert.deepEqual(f.commits, [100]);
  await Promise.resolve();
  assert.equal(settled, false);
  f.ready(300);
  f.frame();
  await done;
  assert.deepEqual(f.commits, [100, 300]);
  assert.equal(f.queue.requestedTop, null);
  assert.equal(f.leases.size, 0);
});

test("revision changes cannot publish a previously completed viewport", () => {
  const f = fixture();
  f.queue.request(100);
  f.ready(100);
  f.revise();
  f.frame();
  assert.deepEqual(f.commits, []);
  f.ready(100);
  f.frame();
  assert.deepEqual(f.commits, [100]);
});

test("eviction between preparation and animation frame cannot publish an uncolored viewport", () => {
  const f = fixture();
  f.queue.request(100);
  f.ready(100);
  f.evict(100);
  f.frame();
  assert.deepEqual(f.commits, []);
  f.ready(100);
  f.frame();
  assert.deepEqual(f.commits, [100]);
});

test("rapid reverse scrolling with edits never commits stale prepared coverage", () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    const first = i % 2 ? 100 : 900;
    const last = first === 100 ? 900 : 100;
    f.queue.request(first, { defer: true });
    f.queue.request(last, { defer: true });
    f.ready(first);
    f.revise();
    const count = f.commits.length;
    f.frame();
    assert.equal(f.commits.length, count);
    f.ready(last);
    f.frame();
    assert.equal(f.commits.at(-1), last);
    assert.equal(f.leases.size, 0);
  }
});

test("geometry is checked again before committing a completed viewport", () => {
  const f = fixture();
  f.queue.request(100);
  f.ready(100);
  f.resize(80);
  f.frame();
  assert.deepEqual(f.commits, []);
  f.ready(80);
  f.frame();
  assert.deepEqual(f.commits, [80]);
});

test("cancellation releases coverage, resolves waiters and disables copied frame callbacks", async () => {
  const f = fixture();
  f.queue.request(100);
  f.ready(100);
  const callback = [...f.frames.values()][0],
    done = f.queue.whenSettled();
  f.queue.cancel();
  callback();
  await done;
  assert.deepEqual(f.commits, []);
  assert.equal(f.leases.size, 0);
  assert.equal(f.frames.size, 0);
});

test("returning to the displayed viewport cancels obsolete scroll work", () => {
  const f = fixture();
  f.queue.request(100);
  f.queue.request(0);
  f.ready(100);
  f.frame();
  assert.deepEqual(f.commits, []);
  assert.equal(f.queue.requestedTop, null);
});

test("clamping a pending destination to the displayed viewport completes its waiter", async () => {
  const f = fixture();
  f.queue.request(100);
  const done = f.queue.whenSettled();
  f.resize(0);
  f.queue.update();
  await done;
  assert.equal(f.queue.requestedTop, null);
  assert.deepEqual(f.commits, []);
});

test("a preparation callback cannot resurrect a cancelled viewport", () => {
  const f = fixture();
  f.component.props.model.displayLayer.prepareHighlightingForScreenRows = () => {
    f.queue.cancel();
    return true;
  };
  f.queue.request(100);
  f.frame();
  assert.equal(f.queue.requestedTop, null);
  assert.equal(f.queue.readyTop, null);
  assert.deepEqual(f.commits, []);
});
