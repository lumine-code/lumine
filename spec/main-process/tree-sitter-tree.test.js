const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

for (const failure of ["input", "progress", "logger"]) {
  test(`a failed ${failure} callback releases its input and parser without another parse`, () => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.CI;
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        path.resolve(__dirname, "../fixtures/tree-sitter-parse-failure-gc.js"),
        failure,
      ],
      { env, encoding: "utf8", windowsHide: true, timeout: 30000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Collected failed .* input and parser without another parse/);
  });
}

test("collected tree owners release Wasm resources without invalidating retained nodes", () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.CI;
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", path.resolve(__dirname, "../fixtures/tree-sitter-tree-gc.js")],
    {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Managed trees preserve retained nodes/);
});
