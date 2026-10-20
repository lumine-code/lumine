const { test } = require("node:test");
const assert = require("node:assert/strict");
const MarkerIndex = require("../../src/marker-index");
const { MarkerIndex: NativeMarkerIndex } =
  require("../../script/native-superstring-reference").load();
const point = (row, column = 0) => ({ row, column });
const compare = (a, b) => a.row - b.row || a.column - b.column;

test("bounded start queries stay exact through lazy shifts and stop at their limit", () => {
  const index = new MarkerIndex();
  const native = new NativeMarkerIndex();
  for (let id = 0; id < 1000; id++) {
    for (const target of [index, native])
      target.insert(id, point(id % 100, id % 7), point((id % 100) + 2, 9));
  }
  for (let step = 0; step < 40; step++) {
    const start = point((step * 17) % 100, 2);
    for (const target of [index, native])
      target.splice(start, point(step % 2, 1), point(step % 3, 4));
    for (const [a, b] of [
      [point(0), point(Infinity, Infinity)],
      [start, point(start.row, Infinity)],
      [point(25, 1), point(70, 3)],
      [point(1000), point(1001)],
    ]) {
      const expected = [...native.findStartingIn(a, b)].sort((x, y) => x - y);
      for (const limit of [0, 1, 16, expected.length, 1000]) {
        const actual = index.findStartingInLimited(a, b, limit);
        if (expected.length > limit) assert.equal(actual, null);
        else
          assert.deepEqual(
            actual.sort((x, y) => x - y),
            expected,
          );
      }
    }
    assert.deepEqual(index.dump(), native.dump());
  }
  for (const limit of [-1, 1.5, Infinity, NaN])
    assert.throws(() => index.findStartingInLimited(point(0), point(1), limit), RangeError);
});

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

test("partial scalar reads match native through mixed mutations and materializing queries", () => {
  for (const seed of [41, 573, 9281]) {
    let state = seed;
    const random = (limit) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % limit;
    };
    const js = new MarkerIndex(seed);
    const native = new NativeMarkerIndex(seed);
    const ids = [];
    let nextId = 1;
    const normalize = (value) =>
      ArrayBuffer.isView(value) || value instanceof Set ? Array.from(value) : value;
    const apply = (method, ...args) =>
      assert.deepEqual(
        normalize(js[method](...args)),
        normalize(native[method](...args)),
        `${method} seed ${seed}`,
      );

    for (let step = 0; step < 1000; step++) {
      const action = random(6);
      if (action <= 1 || !ids.length) {
        const start = point(random(100), random(20));
        const end = point(start.row + random(4), start.column + random(4));
        apply("insert", nextId, start, end);
        ids.push(nextId++);
      } else if (action === 2) {
        const [id] = ids.splice(random(ids.length), 1);
        apply("remove", id);
      } else if (action === 3) {
        apply("setExclusive", ids[random(ids.length)], Boolean(random(2)));
      } else {
        apply(
          "splicePacked",
          point(random(110), random(20)),
          point(random(3), random(5)),
          point(random(3), random(5)),
        );
      }

      // Read only part of the tree before a query or the next mutation. A
      // full dump after every splice would mask ancestry-cache mistakes.
      for (let read = 0; ids.length && read < 8; read++) {
        const id = ids[random(ids.length)];
        apply("getStart", id);
        apply("getEnd", id);
        apply("getRange", id);
        apply("compare", id, ids[random(ids.length)]);
      }
      const start = point(random(110), random(20));
      const end = point(start.row + 5, start.column + 5);
      apply("findIntersecting", start, end);
      apply("findContaining", start, end);
      apply("findStartingIn", start, end);
      apply("getRanges", Uint32Array.from(ids.filter((_, index) => index % 3 === 0)));
      if (step % 50 === 0) apply("dump");
    }
    apply("dump");
  }
});
