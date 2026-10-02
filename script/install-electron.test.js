"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { installElectron } = require("./install-electron");

async function install(results) {
  let attempts = 0;
  const waits = [];
  const messages = [];
  const status = await installElectron({
    runInstaller: () => {
      const result = results[attempts++];
      assert.ok(result, "the installer must not run more times than expected");
      return result;
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    report: (message) => messages.push(message),
  });
  return { status, attempts, waits, messages };
}

test("an installed Electron needs only one attempt", async () => {
  const result = await install([{ status: 0 }]);
  assert.equal(result.status, 0);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.waits, []);
});

for (const failure of [
  "HTTPError: Response code 500 (Internal Server Error) for https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-linux-x64.zip\n",
  "HTTPError: Response code 429 (Too Many Requests)\n",
  "HTTPError: Response code 408 (Request Timeout)\n",
  "TypeError: fetch failed\n  cause: Error: read ECONNRESET\n",
  "TypeError: fetch failed\n  code: 'EAI_AGAIN'\n",
]) {
  test(`a temporary download failure is retried: ${failure.split("\n")[0]}`, async () => {
    const result = await install([{ status: 1, stderr: failure }, { status: 0 }]);
    assert.equal(result.status, 0);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.waits, [2000]);
    assert.equal(result.messages[0], failure);
  });
}

test("persistent download errors remain failures after three attempts", async () => {
  const failure = { status: 7, stderr: "HTTPError: Response code 503 (Service Unavailable)\n" };
  const result = await install([failure, failure, failure]);
  assert.equal(result.status, 7);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.waits, [2000, 4000]);
  assert.equal(result.messages.filter((message) => message === failure.stderr).length, 3);
});

for (const stderr of [
  "HTTPError: Response code 404 (Not Found)\n",
  "HTTPError: Response code 403 (Forbidden)\n",
  "Error: checksum mismatch\n",
  "Error: Cannot find module '@electron/get'\n",
  "Error: EACCES: permission denied\n",
]) {
  test(`a permanent installer failure is not retried: ${stderr.trim()}`, async () => {
    const result = await install([{ status: 1, stderr }]);
    assert.equal(result.status, 1);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.waits, []);
    assert.deepEqual(result.messages, [stderr]);
  });
}

test("a failed process launch is reported without retrying", async () => {
  const error = new Error("spawn failed");
  const result = await install([{ status: null, error }]);
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.waits, []);
  assert.match(result.messages[0], /spawn failed/);
});

test("a terminated installer is not retried even after a network error", async () => {
  const result = await install([
    { status: null, signal: "SIGTERM", stderr: "HTTPError: Response code 500\n" },
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.waits, []);
  assert.match(result.messages[1], /SIGTERM/);
});
