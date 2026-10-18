const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("cursor garbage collection and interleaved copies preserve Wasm memory", () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.CI;
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", path.resolve(__dirname, "../fixtures/tree-sitter-cursor-gc.js")],
    {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cursor collection and copy passed/);
});
