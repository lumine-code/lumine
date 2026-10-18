const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.dirname(require.resolve("@lumine-code/node-tree-sitter/package.json"));
const source = spawnSync(process.execPath, [path.join(root, "script", "setup-tree-sitter.js")], {
  stdio: "inherit",
});
if (source.status !== 0) process.exit(source.status ?? 1);
const saved = path.join(root, ".deps", "wasmtime-root.txt");
const installed =
  process.env.WASMTIME_ROOT ||
  (fs.existsSync(saved) ? fs.readFileSync(saved, "utf8").trim() : null);
if (!installed || !fs.existsSync(path.join(installed, "include", "wasmtime.h"))) {
  if (process.env.WASMTIME_ROOT)
    throw new Error("WASMTIME_ROOT does not contain a Wasmtime C API distribution");
  const result = spawnSync(process.execPath, [path.join(root, "script", "setup-wasmtime.js")], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
