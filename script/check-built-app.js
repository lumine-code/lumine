"use strict";

// Validate the runtime contents produced by electron-builder, before release
// artifacts are uploaded. Accept an output directory, an unpacked application
// directory, a macOS .app bundle, or an app.asar archive.
//
//   node script/check-built-app.js dist

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const asar = require("@electron/asar");
const CSON = require("@lumine-code/season");
const { scanBundledPackageNames, clearCache } = require("../src/bundled-packages");

const ROOT = path.resolve(__dirname, "..");
const PLATFORMS = ["darwin", "linux", "win32"];
const RUNTIME_ASSETS = [
  "exports/lumine.js",
  "static/index.html",
  "static/index.js",
  "resources/app-icons/lumine.png",
  "resources/app-icons/lumine-safe.png",
  "resources/app-icons/lumine-dev.png",
  "resources/app-icons/lumine-raw.svg",
];

function archivePath(value) {
  return value.replace(/\\/g, "/").replace(/^\//, "");
}

function findArchives(input) {
  const result = [];
  function visit(candidate, depth) {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      if (path.basename(candidate) === "app.asar") result.push(candidate);
      return;
    }
    if (depth > 6) return;
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (entry.name.endsWith(".asar.unpacked") || entry.name === "node_modules") continue;
      if (entry.isDirectory() || entry.name === "app.asar") {
        visit(path.join(candidate, entry.name), depth + 1);
      }
    }
  }
  visit(path.resolve(input), 0);
  assert.ok(result.length > 0, `No packaged app.asar found in ${input}`);
  return result.sort();
}

function platformForArchive(file) {
  const normalized = archivePath(file);
  if (/\.app\/Contents\/Resources\/app\.asar$/.test(normalized)) return "darwin";
  if (/(?:^|\/)win(?:-[^/]*)?-unpacked\//.test(normalized)) return "win32";
  if (/(?:^|\/)linux(?:-[^/]*)?-unpacked\//.test(normalized)) return "linux";
  const appDir = path.dirname(path.dirname(file));
  if (fs.existsSync(path.join(appDir, "Lumine.exe"))) return "win32";
  if (fs.existsSync(path.join(appDir, "lumine"))) return "linux";
  return process.platform;
}

function readObject(file) {
  return CSON.readFileSync(file);
}

function coreKeymaps(repoRoot, platform) {
  const result = {};
  const directory = path.join(repoRoot, "keymaps");
  for (const file of fs.readdirSync(directory).sort()) {
    const extension = path.extname(file);
    if (![".json", ".jsonc"].includes(extension)) continue;
    const name = path.basename(file, extension);
    if (["darwin", "freebsd", "linux", "sunos", "win32"].includes(name) && name !== platform) {
      continue;
    }
    result[file] = readObject(path.join(directory, file));
  }
  return result;
}

function runtimeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...runtimeFiles(file));
    else if (/\.(?:json|jsonc|cson|scm|wasm|css|less)$/.test(entry.name)) result.push(file);
  }
  return result;
}

function checkBuiltApp(file, { repoRoot = ROOT, platform = platformForArchive(file) } = {}) {
  assert.ok(PLATFORMS.includes(platform), `Unsupported packaged platform: ${platform}`);
  // ASAR caches headers by filename; revalidation after a rebuild must read the
  // archive currently on disk, rather than a previous generation.
  asar.uncache(file);
  const errors = [];
  const entries = asar.listPackage(file).map(archivePath);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const readManifest = (entry) =>
    JSON.parse(asar.extractFile(file, path.normalize(entry)).toString("utf8"));
  const manifest = readManifest("package.json");
  function expect(condition, message) {
    if (!condition) errors.push(message);
  }
  function requireFile(entry) {
    const normalized = archivePath(entry);
    try {
      const stat = asar.statFile(file, path.normalize(normalized));
      expect(!stat.files, `Expected a file in app.asar: ${normalized}`);
    } catch {
      errors.push(`Missing runtime file in app.asar: ${normalized}`);
    }
  }
  for (const field of [
    "name",
    "version",
    "main",
    "productName",
    "description",
    "engines",
    "dependencies",
    "devDependencies",
    "license",
    "repository",
  ]) {
    expect(
      isDeepStrictEqual(manifest[field], sourceManifest[field]),
      `Packaged package.json changed ${field}`,
    );
  }
  requireFile(path.posix.normalize(manifest.main || "src/main.js"));
  for (const asset of RUNTIME_ASSETS) requireFile(asset);
  for (const name of Object.keys(sourceManifest.dependencies || {})) {
    requireFile(`node_modules/${name}/package.json`);
  }

  const metadata = {
    packages: manifest._luminePackages,
    menu: manifest._lumineMenu,
    keymaps: manifest._lumineKeymaps,
  };
  for (const field of ["_luminePackages", "_lumineMenu", "_lumineKeymaps"]) {
    expect(
      manifest[field] && typeof manifest[field] === "object",
      `Packaged package.json lacks ${field}`,
    );
  }
  const menuFile = ["json", "jsonc"]
    .map((extension) => path.join(repoRoot, "menus", `${platform}.${extension}`))
    .find((candidate) => fs.existsSync(candidate));
  expect(menuFile != null, `No source core menu found for ${platform}`);
  if (menuFile) {
    expect(
      isDeepStrictEqual(metadata.menu, readObject(menuFile)),
      `Baked core menu differs for ${platform}`,
    );
  }
  expect(
    isDeepStrictEqual(metadata.keymaps, coreKeymaps(repoRoot, platform)),
    `Baked core keymaps differ for ${platform}`,
  );
  clearCache();
  const names = scanBundledPackageNames(repoRoot);
  expect(names.length > 0, "No source bundled packages found; install pinned dependencies first");
  expect(
    isDeepStrictEqual(Object.keys(metadata.packages || {}).sort(), names),
    "Baked bundled package names differ from the installed pinned dependencies",
  );
  for (const name of names) {
    const packageRoot = `node_modules/${name}`;
    const baked = metadata.packages?.[name];
    expect(baked?.metadata?.name === name, `${name}: missing or mismatched baked package manifest`);
    if (!baked) continue;
    const sourcePackageDir = path.join(repoRoot, "node_modules", name);
    const sourcePackage = JSON.parse(
      fs.readFileSync(path.join(sourcePackageDir, "package.json"), "utf8"),
    );
    let shippedPackage;
    try {
      shippedPackage = readManifest(`${packageRoot}/package.json`);
    } catch (error) {
      errors.push(`${name}: cannot read shipped package.json (${error.message})`);
    }
    for (const field of [
      "name",
      "version",
      "main",
      "engines",
      "dependencies",
      "providedServices",
    ]) {
      expect(
        isDeepStrictEqual(baked.metadata?.[field], sourcePackage[field]),
        `${name}: baked manifest changed ${field}`,
      );
      if (shippedPackage) {
        expect(
          isDeepStrictEqual(shippedPackage[field], sourcePackage[field]),
          `${name}: shipped manifest changed ${field}`,
        );
      }
    }
    if (sourcePackage.main) {
      expect(typeof baked.main === "string", `${name}: missing baked main module path`);
      if (typeof baked.main === "string") {
        const entry = path.posix.normalize(path.posix.join("static", archivePath(baked.main)));
        expect(
          entry.startsWith(`${packageRoot}/`),
          `${name}: baked main module points outside its package`,
        );
        requireFile(entry);
      }
    }
    for (const key of ["grammarPaths", "settingsPaths", "styleSheetPaths"]) {
      for (const entry of baked[key] || []) requireFile(`${packageRoot}/${archivePath(entry)}`);
    }
    // Include the grammar's WASM and query files, and assets a manifest's
    // cached paths do not enumerate, such as snippets and theme styles.
    for (const directory of ["grammars", "settings", "snippets", "styles"]) {
      for (const entry of runtimeFiles(path.join(sourcePackageDir, directory))) {
        requireFile(`${packageRoot}/${archivePath(path.relative(sourcePackageDir, entry))}`);
      }
    }
  }

  let unpackedCount = 0;
  for (const entry of entries) {
    const stat = asar.statFile(file, path.normalize(entry), false);
    if (stat.files || stat.link) continue;
    if (/\.(?:node|exe|dll|so|dylib)$/.test(entry) || /\/ripgrep[^/]*\/bin\/rg$/.test(entry)) {
      expect(
        stat.unpacked === true,
        `Native or executable runtime file is packed inside app.asar: ${entry}`,
      );
    }
    if (stat.unpacked) {
      unpackedCount++;
      const external = path.join(`${file}.unpacked`, entry);
      expect(fs.existsSync(external), `Missing app.asar.unpacked file: ${entry}`);
      if (fs.existsSync(external)) {
        expect(
          fs.statSync(external).size === stat.size,
          `Incorrect app.asar.unpacked file size: ${entry}`,
        );
      }
    }
  }
  for (const name of ["electron", "electron-builder", "app-builder-lib"]) {
    expect(
      !entries.includes(`node_modules/${name}/package.json`),
      `Build dependency shipped in app.asar: ${name}`,
    );
  }
  if (platform === "win32") {
    const resources = path.dirname(file);
    for (const entry of ["file.ico", "lumine.cmd", "lumine.js", "NSIS_Licenses.txt"]) {
      expect(
        fs.existsSync(path.join(resources, entry)),
        `Missing Windows extra resource: ${entry}`,
      );
    }
    const appDir = path.dirname(resources);
    for (const entry of [
      "Lumine.VisualElementsManifest.xml",
      "visualElements/Square150x150Logo.png",
      "visualElements/Square70x70Logo.png",
    ]) {
      expect(fs.existsSync(path.join(appDir, entry)), `Missing Windows extra file: ${entry}`);
    }
  }
  if (errors.length > 0)
    throw new Error(`${file}:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  return {
    file,
    platform,
    bundledPackages: Object.keys(metadata.packages || {}).length,
    unpackedFiles: unpackedCount,
  };
}

function main() {
  try {
    const input = process.argv[2] || path.join(ROOT, "dist");
    for (const file of findArchives(input)) {
      const result = checkBuiltApp(file);
      console.log(
        `built app: ${result.platform}, ${result.bundledPackages} bundled packages, ` +
          `${result.unpackedFiles} unpacked files verified (${file})`,
      );
    }
  } catch (error) {
    console.error(`Built app validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { checkBuiltApp, findArchives, platformForArchive, RUNTIME_ASSETS };
