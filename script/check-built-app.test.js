"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  checkBuiltApp,
  findArchives,
  platformForArchive,
  RUNTIME_ASSETS,
} = require("./check-built-app");

function write(root, file, value) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, typeof value === "object" ? JSON.stringify(value) : value);
}

async function fixture(
  t,
  { platform = "linux", changeManifest, omit = [], packNative = false, add = {} } = {},
) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-built-app-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    asar.uncacheAll();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const repoRoot = path.join(temp, "repo");
  const source = path.join(temp, "source");
  const buildDir = path.join(temp, "dist");
  const relativeResources = {
    linux: "linux-unpacked/resources",
    win32: "win-unpacked/resources",
    darwin: "mac/Lumine.app/Contents/Resources",
  }[platform];
  const resources = path.join(buildDir, relativeResources);
  const archive = path.join(resources, "app.asar");
  const manifest = {
    name: "lumine",
    version: "1.0.0",
    main: "./src/main.js",
    productName: "Lumine",
    description: "A text editor.",
    engines: { node: ">=24.18.0" },
    dependencies: {
      sample: "github:lumine-code/sample#0123456789012345678901234567890123456789",
      "@lumine-code/native": "github:lumine-code/native#0123456789012345678901234567890123456789",
    },
    devDependencies: { "electron-builder": "26.17.0" },
    license: "MIT",
    repository: "https://github.com/lumine-code/lumine",
  };
  const packageManifest = {
    name: "sample",
    version: "1.0.0",
    engines: { lumine: "^1.0.0" },
    main: "lib/main.js",
    providedServices: {
      "background-tips.provider": { versions: { "1.0.0": "provideBackgroundTips" } },
    },
  };
  write(repoRoot, "package.json", manifest);
  write(repoRoot, "node_modules/sample/package.json", packageManifest);
  write(repoRoot, "node_modules/sample/grammars/sample.wasm", "parser");
  write(repoRoot, "node_modules/sample/grammars/sample.scm", "(identifier) @name");
  write(repoRoot, "node_modules/sample/grammars/sample.json", { type: "tree-sitter" });
  write(repoRoot, "node_modules/sample/styles/main.css", "body {}");
  write(repoRoot, "node_modules/sample/snippets/main.json", {});
  write(repoRoot, "node_modules/sample/lib/main.js", "module.exports = {};");
  const nativeManifest = { name: "@lumine-code/native", version: "1.0.0", main: "lib/main.js" };
  write(repoRoot, "node_modules/@lumine-code/native/package.json", nativeManifest);
  for (const targetPlatform of ["linux", "win32", "darwin"]) {
    write(repoRoot, `menus/${targetPlatform}.json`, {
      menu: [{ label: `File ${targetPlatform}` }],
    });
    write(repoRoot, `keymaps/${targetPlatform}.json`, {
      "lumine-workspace": { "cmdorctrl-p": `sample:${targetPlatform}` },
    });
  }
  write(repoRoot, "keymaps/base.json", { "lumine-workspace": { escape: "core:cancel" } });
  const packedManifest = structuredClone(manifest);
  packedManifest._luminePackages = {
    sample: {
      metadata: packageManifest,
      main: "../node_modules/sample/lib/main.js",
      grammarPaths: ["grammars/sample.json"],
      styleSheetPaths: ["styles/main.css"],
    },
  };
  packedManifest._lumineMenu = { menu: [{ label: `File ${platform}` }] };
  packedManifest._lumineKeymaps = {
    "base.json": { "lumine-workspace": { escape: "core:cancel" } },
    [`${platform}.json`]: { "lumine-workspace": { "cmdorctrl-p": `sample:${platform}` } },
  };
  if (changeManifest) changeManifest(packedManifest);
  write(source, "package.json", packedManifest);
  write(source, "src/main.js", "module.exports = {};");
  for (const asset of RUNTIME_ASSETS) write(source, asset, "asset");
  fs.cpSync(path.join(repoRoot, "node_modules"), path.join(source, "node_modules"), {
    recursive: true,
  });
  const nativeFile = "node_modules/@lumine-code/native/build/Release/native.node";
  write(source, nativeFile, "native binding");
  for (const [entry, value] of Object.entries(add)) write(source, entry, value);
  for (const entry of omit) fs.unlinkSync(path.join(source, entry));
  fs.mkdirSync(resources, { recursive: true });
  await asar.createPackageWithOptions(source, archive, packNative ? {} : { unpack: "**/*.node" });
  // A sibling manifest must never stand in for the one the app actually reads.
  write(resources, "package.json", { lumineMetadata: {} });
  if (platform === "win32") {
    for (const entry of ["file.ico", "lumine.cmd", "lumine.js", "NSIS_Licenses.txt"]) {
      write(resources, entry, "resource");
    }
    for (const entry of [
      "Lumine.VisualElementsManifest.xml",
      "visualElements/Square150x150Logo.png",
      "visualElements/Square70x70Logo.png",
    ]) {
      write(path.dirname(resources), entry, "resource");
    }
  }
  return { archive, repoRoot, buildDir, nativeFile };
}

for (const platform of ["linux", "win32", "darwin"]) {
  test(`validates a real ${platform} ASAR and detects its output layout`, async (t) => {
    const app = await fixture(t, { platform });
    assert.deepEqual(findArchives(app.buildDir), [app.archive]);
    assert.equal(platformForArchive(app.archive), platform);
    const result = checkBuiltApp(app.archive, { repoRoot: app.repoRoot });
    assert.equal(result.bundledPackages, 1);
    assert.equal(result.unpackedFiles, 1);
  });
}

test("rejects metadata and declared source fields removed by manifest cleanup", async (t) => {
  const app = await fixture(t, {
    changeManifest(manifest) {
      delete manifest._luminePackages;
      delete manifest.devDependencies;
    },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      /lacks _luminePackages/.test(error.message) && /changed devDependencies/.test(error.message),
  );
});

test("rejects wrong platform menus, incomplete bundled metadata, and changed pins", async (t) => {
  const app = await fixture(t, {
    changeManifest(manifest) {
      manifest._lumineMenu = { menu: [{ label: "File darwin" }] };
      manifest._lumineKeymaps = {};
      manifest._luminePackages.extra = { metadata: { name: "extra" } };
      manifest.dependencies.sample = "1.0.0";
    },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      /changed dependencies/.test(error.message) &&
      /core menu differs/.test(error.message) &&
      /core keymaps differ/.test(error.message) &&
      /bundled package names differ/.test(error.message),
  );
});

test("rejects missing parser, query, snippets, and package main files", async (t) => {
  const omitted = [
    "node_modules/sample/grammars/sample.wasm",
    "node_modules/sample/grammars/sample.scm",
    "node_modules/sample/snippets/main.json",
    "node_modules/sample/lib/main.js",
  ];
  const app = await fixture(t, { omit: omitted });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      omitted.every((entry) =>
        error.message.includes(`Missing runtime file in app.asar: ${entry}`),
      ),
  );
});

test("rejects a main module cached outside its package even if that file exists", async (t) => {
  const app = await fixture(t, {
    changeManifest(manifest) {
      manifest._luminePackages.sample.main = "../src/main.js";
    },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /baked main module points outside its package/,
  );
});

test("rejects a native binding packed inside ASAR", async (t) => {
  const app = await fixture(t, { packNative: true });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /Native or executable runtime file is packed inside app.asar/,
  );
});

test("rejects build tools copied into the runtime node_modules", async (t) => {
  const app = await fixture(t, {
    add: {
      "node_modules/electron-builder/package.json": {
        name: "electron-builder",
        version: "26.17.0",
      },
    },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /Build dependency shipped in app.asar: electron-builder/,
  );
});

test("rejects a stale shipped package even when its baked metadata is current", async (t) => {
  const app = await fixture(t, {
    add: { "node_modules/sample/package.json": { name: "sample", version: "0.9.0" } },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /sample: shipped manifest changed version/,
  );
});

test("rejects missing unpacked native files and Windows shell resources", async (t) => {
  const app = await fixture(t, { platform: "win32" });
  fs.unlinkSync(path.join(`${app.archive}.unpacked`, app.nativeFile));
  fs.unlinkSync(path.join(path.dirname(app.archive), "file.ico"));
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      /Missing app.asar.unpacked file/.test(error.message) &&
      /Missing Windows extra resource: file.ico/.test(error.message),
  );
});

test("reports output directories without a packaged application", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-built-app-empty-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  assert.throws(() => findArchives(temp), /No packaged app.asar found/);
});
