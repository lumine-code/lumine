const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isWindowStatePersistenceEnabled,
  windowStateOptions,
} = require("../../src/window-state-persistence");

test("only ordinary desktop windows persist native state", () => {
  assert.equal(isWindowStatePersistenceEnabled({}, {}), true);
  for (const key of ["isSpec", "headless", "offscreen"])
    assert.equal(isWindowStatePersistenceEnabled({ [key]: true }, {}), false);
  assert.equal(
    isWindowStatePersistenceEnabled({}, { LUMINE_DISABLE_WINDOW_STATE_PERSISTENCE: "1" }),
    false,
  );
});

test("reset clears the same native identity before enabling restoration", () => {
  const cleared = [];
  const windowClass = { clearPersistedState: (name) => cleared.push(name) };
  const name = "lumine-workspace-740492e4-e8a1-4dea-965c-fd542a685589";
  assert.deepEqual(windowStateOptions(name, { enabled: true, clear: true }, windowClass), {
    name,
    windowStatePersistence: true,
  });
  assert.deepEqual(cleared, [name]);
  assert.deepEqual(windowStateOptions(name, { enabled: true }, windowClass), {
    name,
    windowStatePersistence: true,
  });
  assert.deepEqual(cleared, [name]);
});

test("a core snapshot supplies authoritative bounds and disables stale native restoration", () => {
  const name = "lumine-workspace-740492e4-e8a1-4dea-965c-fd542a685589";
  const bounds = { x: 120, y: 80, width: 900, height: 700 };
  const store = {
    getWindowOptions(identity) {
      assert.equal(identity, name);
      return bounds;
    },
  };
  assert.deepEqual(windowStateOptions(name, { enabled: true, store }, {}), {
    name,
    ...bounds,
    windowStatePersistence: false,
  });
});

test("identities without a core snapshot retain native restoration for migration", () => {
  const names = [];
  const store = {
    getWindowOptions(name) {
      names.push(name);
    },
  };
  assert.deepEqual(windowStateOptions("desktop", { enabled: true, store }, {}), {
    name: "desktop",
    windowStatePersistence: true,
  });
  assert.deepEqual(names, ["desktop"]);
});

test("reset removes core and native snapshots before looking up restored geometry", () => {
  const cleared = new Set();
  const name = "lumine-workspace-740492e4-e8a1-4dea-965c-fd542a685589";
  const windowClass = { clearPersistedState: () => cleared.add("native") };
  const store = {
    clear(identity) {
      assert.equal(identity, name);
      cleared.add("core");
    },
    getWindowOptions(identity) {
      assert.equal(identity, name);
      assert.deepEqual(cleared, new Set(["native", "core"]));
    },
  };
  assert.deepEqual(windowStateOptions(name, { enabled: true, clear: true, store }, windowClass), {
    name,
    windowStatePersistence: true,
  });
});

test("test and capture windows neither name themselves nor clear saved desktop state", () => {
  const windowClass = {
    clearPersistedState() {
      assert.fail("A hidden window touched persisted desktop state");
    },
  };
  const store = {
    getWindowOptions() {
      assert.fail("A hidden window read persisted desktop state");
    },
    clear() {
      assert.fail("A hidden window cleared persisted desktop state");
    },
  };
  assert.deepEqual(
    windowStateOptions("desktop", { enabled: false, clear: true, store }, windowClass),
    {},
  );
});
