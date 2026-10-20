const { test } = require("node:test");
const assert = require("node:assert/strict");
const { IdleDisposalQueue } = require("../../src/idle-disposal-queue");

function setup(options = {}) {
  let time = 0;
  const tasks = [];
  const queue = new IdleDisposalQueue({
    ...options,
    now: () => time,
    schedule: (fn, wait) => tasks.push({ fn, at: time + wait }),
  });
  return {
    queue,
    advance: (ms) => {
      time += ms;
    },
    run: () => {
      const task = tasks.shift();
      time = Math.max(time, task.at);
      task.fn();
    },
    tasks,
  };
}

test("disposal waits for an edit pause and yields after an uninterruptible job", () => {
  const state = setup(),
    disposed = [];
  const release = (value) => {
    disposed.push(value);
    state.advance(130);
  };
  state.queue.didEdit();
  state.queue.add(1, release);
  state.queue.add(2, release);
  state.run();
  assert.deepEqual(disposed, []);
  state.advance(50);
  state.queue.didEdit();
  state.run();
  assert.deepEqual(disposed, []);
  state.run();
  assert.deepEqual(disposed, [1]);
  assert.equal(state.tasks.length, 1);
  state.run();
  assert.deepEqual(disposed, [1, 2]);
  assert.equal(state.queue.pending.length, 0);
});

test("disposal pressure permits progress even during continuous edits", () => {
  const state = setup({ pressureLimit: 2 }),
    disposed = [];
  state.queue.didEdit();
  for (let i = 0; i < 5; i++) state.queue.add(i, (value) => disposed.push(value));
  state.run();
  assert.deepEqual(disposed, [0, 1, 2]);
  state.run();
  assert.equal(disposed.length, 3);
  state.run();
  assert.deepEqual(disposed, [0, 1, 2, 3, 4]);
});

test("a failed disposer does not strand other collected resources", () => {
  const state = setup(),
    disposed = [];
  state.queue.add(1, () => {
    throw new Error("dispose");
  });
  state.queue.add(2, (value) => disposed.push(value));
  assert.throws(() => state.run(), /dispose/);
  state.run();
  assert.deepEqual(disposed, [2]);
});

test("scroll activity extends the edit pause until the gesture has settled", () => {
  const state = setup(),
    disposed = [];
  state.queue.didEdit();
  state.queue.add(1, (value) => disposed.push(value));
  state.run();
  for (let i = 0; i < 10; i++) {
    state.advance(200);
    state.queue.didInteract();
    state.run();
    assert.deepEqual(disposed, []);
    assert.equal(state.tasks.length, 1);
  }
  state.run();
  assert.deepEqual(disposed, [1]);
});

test("continuous pressure does not retain an ever-growing prefix of consumed slots", () => {
  const state = setup({ pressureLimit: 2 });
  const dispose = () => {};
  state.queue.didEdit();
  state.queue.add(0, dispose);
  state.queue.add(1, dispose);
  for (let i = 0; i < 2000; i++) {
    for (let j = 0; j < 3; j++) state.queue.add(i, dispose);
    state.run();
    assert.equal(state.queue.pending.length - state.queue.offset, 2);
    assert.ok(state.queue.pending.length < 1027);
  }
});
