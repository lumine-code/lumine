const { test } = require("node:test");
const assert = require("node:assert/strict");
const MarkerIndex = require("../../src/marker-index");
const { MarkerIndex: NativeMarkerIndex } = require("@lumine-code/superstring");
const point = (row, column = 0) => ({ row, column });
const compare = (a, b) => a.row - b.row || a.column - b.column;

test("JavaScript interval index matches native coordinates, queries and invalidation", () => {
  for (let seed = 1; seed <= 20; seed++) {
    let state = seed;
    const random = (limit) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % limit;
    };
    const js = new MarkerIndex(seed),
      native = new NativeMarkerIndex(seed);
    const ids = [];
    let nextId = 0;
    for (let iteration = 0; iteration < 500; iteration++) {
      const action = random(5);
      if (action <= 1 || !ids.length) {
        let a = point(random(100), random(50)),
          b = point(random(100), random(50));
        if (compare(a, b) > 0) [a, b] = [b, a];
        if (random(4) === 0) b = a;
        const id = nextId++,
          exclusive = random(2) === 1;
        for (const index of [js, native]) {
          index.insert(id, a, b);
          index.setExclusive(id, exclusive);
        }
        ids.push(id);
      } else if (action === 2) {
        const [id] = ids.splice(random(ids.length), 1);
        js.remove(id);
        native.remove(id);
      } else {
        const start = point(random(110), random(50));
        const oldExtent = point(random(4), random(10));
        const newExtent = point(random(4), random(10));
        assert.deepEqual(
          js.splice(start, oldExtent, newExtent),
          native.splice(start, oldExtent, newExtent),
          `splice seed ${seed} step ${iteration}`,
        );
      }
      assert.deepEqual(js.dump(), native.dump(), `coordinates seed ${seed} step ${iteration}`);
      if (ids.length) {
        assert.deepEqual(
          Array.from(js.getRanges(ids)),
          Array.from(native.getRanges(new Uint32Array(ids))),
        );
        const a = ids[random(ids.length)],
          b = ids[random(ids.length)];
        assert.equal(js.compare(a, b), native.compare(a, b));
      }
      let a = point(random(120), random(50)),
        b = point(random(120), random(50));
      if (compare(a, b) > 0) [a, b] = [b, a];
      for (const name of [
        "findIntersecting",
        "findContaining",
        "findContainedIn",
        "findStartingIn",
        "findEndingIn",
      ])
        assert.deepEqual(
          [...js[name](a, b)],
          [...native[name](a, b)],
          `${name} seed ${seed} step ${iteration}`,
        );
      for (const name of ["findStartingAt", "findEndingAt"])
        assert.deepEqual([...js[name](a)], [...native[name](a)]);
    }
  }
});

test("endpoint affinity and lazy suffixes survive changes at the same row", () => {
  const js = new MarkerIndex(),
    native = new NativeMarkerIndex();
  for (let id = 0; id < 2000; id++) {
    const start = point(Math.floor(id / 100), id % 100);
    for (const index of [js, native]) {
      index.insert(id, start, point(start.row + (id % 3), start.column + 10));
      index.setExclusive(id, id % 2 === 0);
    }
  }
  for (const [start, oldExtent, newExtent] of [
    [point(0), point(0), point(2, 3)],
    [point(1), point(0), point(0, 5)],
    [point(2, 4), point(1, 7), point(0, 2)],
    [point(0), point(1, 3), point(2, 5)],
    [point(2, 5), point(0), point(0, 1)],
  ]) {
    assert.deepEqual(
      js.splice(start, oldExtent, newExtent),
      native.splice(start, oldExtent, newExtent),
    );
    for (const id of [1999, 0, 890, 3, 1024])
      assert.deepEqual(js.getRange(id), native.getRange(id));
  }
  assert.deepEqual(js.dump(), native.dump());
  assert.deepEqual(
    [...js.findIntersecting(point(0), point(Infinity, Infinity))],
    [...native.findIntersecting(point(0), point(Infinity, Infinity))],
  );
});

test("returned ranges are detached and duplicate identities reject", () => {
  const index = new MarkerIndex();
  index.insert(1, point(1), point(3));
  assert.throws(() => index.insert(1, point(9), point(10)), /Duplicate/);
  index.getRange(1).start.row = 99;
  index.getRanges([1]).fill(999);
  assert.deepEqual(index.getStart(1), point(1));
  index.remove(1);
  index.remove(1);
  assert.equal(index.has(1), false);
});

test("queries clip negative and fractional probes without mutating caller positions", () => {
  const index = new MarkerIndex();
  index.insert(1, point(2, 0), point(3, 4));
  const probe = Object.freeze(point(2, -1));
  assert.deepEqual([...index.findContaining(probe)], [1]);
  assert.deepEqual([...index.findStartingAt(point(2.5, -0.5))], [1]);
  assert.equal(probe.column, -1);
  assert.throws(() => index.insert(2, point(2, -1), point(3)), RangeError);
});
