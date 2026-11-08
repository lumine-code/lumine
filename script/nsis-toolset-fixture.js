"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const releases =
  "https://api.github.com/repos/electron-userland/electron-builder-binaries/releases";
const maximumArchiveSize = 256 * 1024 * 1024;

// Keep the builder's ordinary cache, version selection and failures. Only its
// exact official NSIS archive's temporary HTTP failure has another transport.
async function fixtureNsisCompiler({
  selector,
  resourcesDirectory,
  directory,
  signal,
  getMakeNsisPath,
  nsisChecksums,
  fetch = globalThis.fetch,
  env = process.env,
  report = () => {},
}) {
  let originalError;
  try {
    return await getMakeNsisPath(selector, resourcesDirectory);
  } catch (error) {
    originalError = error;
  }
  signal?.throwIfAborted();
  const match =
    /^Response code (408|429|5\d\d) \([^\r\n]*\) for (https:\/\/github\.com\/electron-userland\/electron-builder-binaries\/releases\/download\/nsis@([\d.]+)\/([^/?#\s]+))$/.exec(
      originalError?.message || "",
    );
  if (originalError?.name !== "HTTPError" || !match) throw originalError;
  // The builder may be using an explicitly configured HTTPS proxy. Native
  // fetch does not share that transport, so never bypass it with a direct API.
  if (
    Object.entries(env).some(([key, value]) => key.toUpperCase() === "HTTPS_PROXY" && value?.trim())
  ) {
    throw originalError;
  }
  const [, , originalURL, version, filename] = match;
  const checksum = nsisChecksums[version]?.[filename];
  if (
    (selector != null && selector !== "latest" && selector !== version) ||
    !/^[a-f0-9]{64}$/.test(checksum || "") ||
    !/^nsis-bundle-[\d.]+\.tar\.gz$/.test(filename)
  ) {
    throw originalError;
  }

  const realDirectory = await fs.realpath(directory);
  if (
    !path.isAbsolute(directory) ||
    realDirectory !== directory ||
    (await fs.lstat(directory)).isSymbolicLink()
  ) {
    throw new Error("NSIS recovery requires the owned fixture's real directory");
  }
  const tag = `nsis@${version}`;
  const metadata = await fetch(`${releases}/tags/${encodeURIComponent(tag)}`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!metadata.ok) throw new Error(`Official NSIS release metadata HTTP ${metadata.status}`);
  const release = await metadata.json();
  const assets = release.assets?.filter((asset) => asset.name === filename);
  if (release.tag_name !== tag || assets?.length !== 1) {
    throw new Error("The official NSIS release does not identify the requested archive");
  }
  const asset = assets[0];
  const browserURL = new URL(asset.browser_download_url);
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maximumArchiveSize ||
    browserURL.origin !== "https://github.com" ||
    browserURL.username ||
    browserURL.password ||
    browserURL.search ||
    browserURL.hash ||
    decodeURIComponent(browserURL.pathname) !== new URL(originalURL).pathname
  ) {
    throw new Error("The official NSIS release archive identity or size is invalid");
  }
  signal?.throwIfAborted();
  report(`Downloading ${filename} through the official GitHub release asset API.`);
  const response = await fetch(`${releases}/assets/${asset.id}`, {
    headers: { Accept: "application/octet-stream" },
    signal,
  });
  if (!response.ok) throw new Error(`Official NSIS release archive HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > asset.size) throw new Error("Official NSIS archive exceeds its declared size");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (size !== asset.size || createHash("sha256").update(bytes).digest("hex") !== checksum) {
    throw new Error("Official NSIS archive does not match the pinned builder checksum and size");
  }
  signal?.throwIfAborted();
  const archive = path.join(realDirectory, filename);
  await fs.writeFile(archive, bytes, { flag: "wx", signal });
  signal?.throwIfAborted();
  const fileURL = pathToFileURL(archive);
  // Builder 27's ToolsetCustom file path parser strips `file://` without URL
  // decoding. Round-trip a real file URL, then supply its required native path.
  const custom = { url: `file://${fileURLToPath(fileURL)}`, checksum, version };
  // The builder verifies this same archive checksum again before extraction;
  // its supported custom-toolset API still owns cache/extraction/compiler paths.
  return getMakeNsisPath(custom, resourcesDirectory);
}

module.exports = { fixtureNsisCompiler };
