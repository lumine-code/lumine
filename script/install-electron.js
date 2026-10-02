"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const installerPath = path.resolve(__dirname, "../node_modules/electron/install.js");

// Electron's fetch downloader does not retry temporary release-server failures.
// Keep retries at the download boundary; build and spec failures still run once.
async function installElectron({
  runInstaller = () =>
    spawnSync(process.execPath, [installerPath], {
      stdio: ["ignore", "inherit", "pipe"],
      encoding: "utf8",
    }),
  wait = delay,
  report = (message) => process.stderr.write(message),
} = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = runInstaller();
    const stderr = result.stderr || "";
    if (stderr) report(stderr);
    if (result.error) report(`${result.error.stack || result.error}\n`);
    if (result.signal) report(`Electron installer terminated by ${result.signal}\n`);
    if (result.status === 0 && !result.error && !result.signal) return 0;

    const temporaryDownloadFailure =
      /HTTPError: Response code (?:408|429|5\d\d)\b/.test(stderr) ||
      /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b/.test(
        stderr,
      );
    if (result.error || result.signal || !temporaryDownloadFailure || attempt === 3) {
      return result.status || 1;
    }

    const backoff = 2000 * attempt;
    report(`Retrying the Electron download in ${backoff / 1000}s (${attempt + 1}/3).\n`);
    await wait(backoff);
  }
}

module.exports = { installElectron };

if (require.main === module) {
  installElectron().then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
