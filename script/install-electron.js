"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const installerPath = path.resolve(__dirname, "../node_modules/electron/install.js");

// GitHub's release download front end can fail while its documented release
// asset API still serves the same bytes. Only the installer child uses this
// transport fallback; Electron still owns extraction, caching and checksums.
function releaseAssetFetch(fetch, report = (message) => process.stderr.write(message)) {
  return async function download(input, options) {
    const url = typeof input === "string" ? input : input?.href;
    const match =
      /^https:\/\/github\.com\/electron\/(electron|nightlies)\/releases\/download\/([^/?#]+)\/([^/?#]+)$/.exec(
        url || "",
      );
    if (!match || (options?.method && options.method.toUpperCase() !== "GET")) {
      return fetch(input, options);
    }

    let response;
    try {
      response = await fetch(input, options);
      if (![408, 429].includes(response.status) && response.status < 500) return response;
    } catch (error) {
      if (
        options?.signal?.aborted ||
        !(error instanceof TypeError && error.message === "fetch failed")
      ) {
        throw error;
      }
    }

    options?.signal?.throwIfAborted();
    await response?.body?.cancel();
    const [, repository, tag, filename] = match;
    const api = `https://api.github.com/repos/electron/${repository}/releases`;
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);
    const metadata = await fetch(`${api}/tags/${tag}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal,
    });
    // Preserve HTTP failures so the upstream downloader and the outer bounded
    // retry retain their ordinary status handling, including API rate limits.
    if (!metadata.ok) return metadata;
    const release = await metadata.json();
    const assets = release.assets?.filter(
      (asset) => asset.name === filename && asset.browser_download_url === url,
    );
    if (release.tag_name !== decodeURIComponent(tag) || assets?.length !== 1) {
      throw new Error("The official Electron release does not identify the requested asset");
    }
    const asset = assets[0];
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new Error("The official Electron release asset has no valid identifier");
    }
    report(`Downloading ${filename} through the official GitHub release asset API.\n`);
    // Public release assets require no credential. Do not forward any caller
    // headers to the API or its signed asset redirect.
    return fetch(`${api}/assets/${asset.id}`, {
      headers: { Accept: "application/octet-stream" },
      signal,
    });
  };
}

// Electron's fetch downloader does not retry temporary release-server failures.
// Keep retries at the download boundary; build and spec failures still run once.
async function installElectron({
  runInstaller = () =>
    spawnSync(process.execPath, [__filename, "--install"], {
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
      // The upstream installer prints only the stack, hiding fetch's cause.
      // A rejected request still gets the same bounded download retry.
      /TypeError: fetch failed\b/.test(stderr) ||
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

module.exports = { installElectron, releaseAssetFetch };

if (require.main === module && process.argv[2] === "--install") {
  globalThis.fetch = releaseAssetFetch(globalThis.fetch);
  require(installerPath);
} else if (require.main === module) {
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
