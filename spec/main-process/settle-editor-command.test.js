const { test } = require("node:test");
const assert = require("node:assert/strict");
const settle = require("../../src/settle-editor-command");
test("editor command boundary reports sync, async and committed observer errors", async () => {
  const messages = [],
    notifications = { addError: (...args) => messages.push(args) };
  assert.equal(
    settle(
      () => {
        throw new RangeError("too large");
      },
      notifications,
      "editor:copy",
    ),
    false,
  );
  assert.equal(
    await settle(
      () => Promise.reject(Object.assign(new Error("listener"), { committed: true })),
      notifications,
      "editor:upper-case",
    ),
    false,
  );
  assert.equal(messages.length, 2);
  assert.match(messages[1][0], /edit completed/);
  assert.equal(
    await settle(
      () => [Promise.resolve(), Promise.reject(new Error("child"))],
      notifications,
      "editor:indent",
    ),
    false,
  );
  assert.equal(messages.length, 3);
  assert.equal(
    await settle(
      () => Promise.reject(Object.assign(new Error("stale"), { name: "AbortError" })),
      notifications,
      "editor:join-lines",
    ),
    false,
  );
  assert.equal(messages.length, 3);
});
