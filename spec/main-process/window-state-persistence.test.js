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

test("test and capture windows neither name themselves nor clear saved desktop state", () => {
  const windowClass = {
    clearPersistedState() {
      assert.fail("A hidden window touched persisted desktop state");
    },
  };
  assert.deepEqual(windowStateOptions("desktop", { enabled: false, clear: true }, windowClass), {});
});
