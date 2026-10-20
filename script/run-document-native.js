// Native compatibility checks are separate from installation and npm test.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveReference } = require("./native-superstring-reference");

try {
  const reference = resolveReference();
  console.log(JSON.stringify({ nativeReference: reference }, null, 2));
  const directory = path.resolve(__dirname, "../benchmark/native-reference");
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".reference.js"))
    .sort()
    .map((file) => path.join(directory, file));
  if (!files.length) throw new Error("No native reference suites found");
  const env = { ...process.env, LUMINE_NATIVE_SUPERSTRING: reference.root };
  delete env.CI;
  const result = spawnSync(process.execPath, ["--test", ...files], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
