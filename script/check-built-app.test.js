"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const { getNodeModuleFileMatcher } = require("app-builder-lib/out/fileMatcher");
const { whatToBuild } = require("./electron-builder");
const packageWindowsCrashHelper = require("./windows-wer");
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
  {
    platform = "linux",
    changeManifest,
    omit = [],
    packNative = false,
    add = {},
    installed = {},
  } = {},
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
  const launchers = {
    "lumine.sh": "#!/bin/bash\n# POSIX application launcher\n",
    "resources/lumine.js": '"use strict";\n// Shared application launcher\n',
    "resources/win/lumine.sh": "#!/bin/bash\n# Windows application launcher\n",
  };
  for (const [entry, contents] of Object.entries(launchers)) write(repoRoot, entry, contents);
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
  write(repoRoot, "LICENSE", "MIT License\nCopyright the editor authors\n");
  write(repoRoot, "THIRD_PARTY_NOTICES", "Inherited editor license\r\n");
  write(repoRoot, "node_modules/sample/package.json", packageManifest);
  write(repoRoot, "node_modules/sample/LICENSE", "MIT License\nPackage authors\n");
  write(repoRoot, "node_modules/sample/THIRD_PARTY_NOTICES", "Parser license\r\n");
  write(repoRoot, "node_modules/sample/grammars/sample.wasm", "parser");
  write(repoRoot, "node_modules/sample/grammars/sample.scm", "(identifier) @name");
  write(repoRoot, "node_modules/sample/grammars/sample.json", { type: "tree-sitter" });
  write(repoRoot, "node_modules/sample/styles/main.css", "body {}");
  write(repoRoot, "node_modules/sample/snippets/main.json", {});
  write(repoRoot, "node_modules/sample/lib/main.js", "module.exports = {};");
  const nativeManifest = { name: "@lumine-code/native", version: "1.0.0", main: "lib/main.js" };
  write(repoRoot, "node_modules/@lumine-code/native/package.json", nativeManifest);
  write(repoRoot, "node_modules/@lumine-code/native/LICENSE.md", "Native library terms\r\n");
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
  for (const asset of RUNTIME_ASSETS) {
    write(source, asset, "asset");
    write(repoRoot, asset, "asset");
  }
  for (const [entry, value] of Object.entries(installed)) write(repoRoot, entry, value);
  fs.cpSync(path.join(repoRoot, "node_modules"), path.join(source, "node_modules"), {
    recursive: true,
  });
  const nativeFile = "node_modules/@lumine-code/native/build/Release/native.node";
  write(source, nativeFile, "native binding");
  for (const [entry, value] of Object.entries(add)) write(source, entry, value);
  for (const entry of omit) fs.unlinkSync(path.join(source, entry));
  fs.mkdirSync(resources, { recursive: true });
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
    fs.copyFileSync(path.join(repoRoot, name), path.join(resources, name));
  }
  await asar.createPackageWithOptions(source, archive, packNative ? {} : { unpack: "**/*.node" });
  write(
    resources,
    "lumine.sh",
    launchers[platform === "win32" ? "resources/win/lumine.sh" : "lumine.sh"],
  );
  write(resources, "lumine.js", launchers["resources/lumine.js"]);
  // A sibling manifest must never stand in for the one the app actually reads.
  write(resources, "package.json", { lumineMetadata: {} });
  if (platform === "win32") {
    for (const entry of ["file.ico", "lumine.cmd", "NSIS_Licenses.txt"]) {
      write(resources, entry, "resource");
    }
    for (const entry of [
      "Lumine_wer.dll",
      "Lumine.VisualElementsManifest.xml",
      "visualElements/Square150x150Logo.png",
      "visualElements/Square70x70Logo.png",
    ]) {
      write(path.dirname(resources), entry, "resource");
    }
  }
  return { archive, repoRoot, buildDir, nativeFile };
}

test("renames the Windows crash helper to match the packaged executable", async (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-wer-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(appOutDir)), path.resolve(os.tmpdir()));
    fs.rmSync(appOutDir, { recursive: true, force: true });
  });
  const original = path.join(appOutDir, "electron_wer.dll");
  fs.writeFileSync(original, "crash helper");
  await packageWindowsCrashHelper({
    electronPlatformName: "win32",
    appOutDir,
    packager: { appInfo: { productFilename: "Lumine" } },
  });
  assert.equal(fs.readFileSync(path.join(appOutDir, "Lumine_wer.dll"), "utf8"), "crash helper");
  assert.equal(fs.existsSync(original), false);
  assert.equal(whatToBuild().afterPack, "script/windows-wer.js");
});

test("does not package a WER helper on other platforms", async () => {
  await packageWindowsCrashHelper({ electronPlatformName: "linux" });
  await packageWindowsCrashHelper({ electronPlatformName: "darwin" });
});

test("rejects a Windows package with a missing crash helper", async (t) => {
  const { archive, repoRoot } = await fixture(t, { platform: "win32" });
  fs.unlinkSync(path.join(path.dirname(path.dirname(archive)), "Lumine_wer.dll"));
  assert.throws(
    () => checkBuiltApp(archive, { repoRoot }),
    /Missing Windows extra file: Lumine_wer/,
  );
});

test("packages exactly one shell launcher for each target platform", () => {
  const config = whatToBuild();
  for (const [platform, source] of [
    ["linux", "lumine.sh"],
    ["mac", "lumine.sh"],
    ["win", "resources/win/lumine.sh"],
  ]) {
    const launchers = [...config.extraResources, ...config[platform].extraResources].filter(
      (entry) => entry.to === "lumine.sh",
    );
    assert.deepEqual(launchers, [{ from: source, to: "lumine.sh" }]);
  }
});

test("packages the same shared launcher for every target platform", () => {
  const config = whatToBuild();
  const helper = { from: "resources/lumine.js", to: "lumine.js" };
  assert.ok(config.extraResources.some((entry) => entry.from === helper.from));
  assert.ok(config.files.includes("!resources/lumine.js"));
  for (const platform of ["linux", "mac", "win"]) {
    const helpers = [...config.extraResources, ...config[platform].extraResources].filter(
      (entry) => entry.to === helper.to,
    );
    assert.deepEqual(helpers, [helper]);
  }
});

test("preserves legal Markdown and notices in the actual dependency filter", () => {
  const root = path.resolve(__dirname, "..");
  const config = whatToBuild();
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
    assert.ok(config.extraResources.some((entry) => entry.from === name && entry.to === name));
  }
  const matcher = getNodeModuleFileMatcher(
    root,
    root,
    (value) => value,
    {},
    {
      config,
      debugLogger: { isEnabled: false },
    },
  );
  const include = matcher.createFilter();
  const stat = { isDirectory: () => false };
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "LICENCE.markdown",
    "license.md",
    "COPYING.md",
    "NOTICE.md",
    "Copyright.md",
    "ThirdPartyNotices.md",
    "THIRD_PARTY_NOTICES",
  ]) {
    assert.equal(include(path.join(root, "node_modules", "sample", name), stat), true, name);
  }
  assert.equal(include(path.join(root, "node_modules/sample/README.md"), stat), false);
});

test("rejects missing or altered dependency licenses and third-party notices", async (t) => {
  const app = await fixture(t, {
    omit: ["node_modules/sample/THIRD_PARTY_NOTICES"],
    add: { "node_modules/@lumine-code/native/LICENSE.md": "Replaced terms\n" },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      /Missing runtime file in app.asar: node_modules\/sample\/THIRD_PARTY_NOTICES/.test(
        error.message,
      ) &&
      /Dependency legal file differs from its source: node_modules\/@lumine-code\/native\/LICENSE.md/.test(
        error.message,
      ),
  );
});

function rehoistedDependency({ alterLicense = false, omitNotices = false } = {}) {
  const sourceRoot = "node_modules/sample/node_modules/rehoisted";
  const packagedRoot = "node_modules/rehoisted";
  const manifest = { name: "rehoisted", version: "2.0.0" };
  const license = "Production dependency license\n";
  const notices = "Inherited production notices\n";
  return {
    installed: {
      [`${packagedRoot}/package.json`]: { name: "rehoisted", version: "1.0.0" },
      [`${packagedRoot}/LICENSE`]: "Build tooling dependency license\n",
      [`${sourceRoot}/package.json`]: manifest,
      [`${sourceRoot}/LICENSE.md`]: license,
      [`${sourceRoot}/THIRD_PARTY_NOTICES`]: notices,
    },
    add: {
      [`${packagedRoot}/package.json`]: manifest,
      [`${packagedRoot}/LICENSE.md`]: alterLicense ? "Wrong license\n" : license,
      ...(!omitNotices ? { [`${packagedRoot}/THIRD_PARTY_NOTICES`]: notices } : {}),
    },
    omit: [
      `${packagedRoot}/LICENSE`,
      `${sourceRoot}/package.json`,
      `${sourceRoot}/LICENSE.md`,
      `${sourceRoot}/THIRD_PARTY_NOTICES`,
    ],
  };
}

test("validates legal files from the production source after dependency rehoisting", async (t) => {
  const app = await fixture(t, rehoistedDependency());
  assert.doesNotThrow(() => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }));
});

test("rejects missing or altered legal files after dependency rehoisting", async (t) => {
  const app = await fixture(t, rehoistedDependency({ alterLicense: true, omitNotices: true }));
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      /Dependency legal file differs from its source: node_modules\/rehoisted\/LICENSE.md/.test(
        error.message,
      ) &&
      /Missing runtime file in app.asar: node_modules\/rehoisted\/THIRD_PARTY_NOTICES/.test(
        error.message,
      ),
  );
});

test("rejects a packaged dependency whose installed source version is unavailable", async (t) => {
  const app = await fixture(t, {
    add: { "node_modules/unknown/package.json": { name: "unknown", version: "1.0.0" } },
  });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /No installed source for packaged dependency: node_modules\/unknown \(unknown@1.0.0\)/,
  );
});

test("rejects missing or altered editor legal resources", async (t) => {
  const app = await fixture(t);
  const resources = path.dirname(app.archive);
  fs.unlinkSync(path.join(resources, "LICENSE"));
  fs.writeFileSync(path.join(resources, "THIRD_PARTY_NOTICES"), "Incomplete notices\n");
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    (error) =>
      /Missing legal resource: LICENSE/.test(error.message) &&
      /Legal resource differs from its source: THIRD_PARTY_NOTICES/.test(error.message),
  );
});

for (const platform of ["linux", "win32", "darwin"]) {
  test(`validates a real ${platform} ASAR and detects its output layout`, async (t) => {
    const app = await fixture(t, { platform });
    assert.deepEqual(findArchives(app.buildDir), [app.archive]);
    assert.equal(platformForArchive(app.archive), platform);
    const result = checkBuiltApp(app.archive, { repoRoot: app.repoRoot });
    assert.equal(result.bundledPackages, 1);
    assert.equal(result.unpackedFiles, 1);
  });

  test(`rejects a ${platform} build missing its shared launcher`, async (t) => {
    const app = await fixture(t, { platform });
    fs.unlinkSync(path.join(path.dirname(app.archive), "lumine.js"));

    assert.throws(
      () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
      /Missing shared command-line launcher: lumine.js/,
    );
  });

  test(`rejects a ${platform} build with a stale shared launcher`, async (t) => {
    const app = await fixture(t, { platform });
    fs.writeFileSync(path.join(path.dirname(app.archive), "lumine.js"), "// stale launcher\n");

    assert.throws(
      () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
      /Incorrect shared command-line launcher: lumine.js/,
    );
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

test("rejects runtime bytes corrupted by a source change during packaging", async (t) => {
  const app = await fixture(t, { add: { "src/main.js": "// wrong archive offset\nasset" } });
  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /Runtime asset differs from its source: src\/main.js/,
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
    "src/parse-command-line-options.js",
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

test("rejects a shared launcher copied inside ASAR", async (t) => {
  const app = await fixture(t, {
    add: { "resources/lumine.js": "// redundant launcher\n" },
  });

  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /Shared command-line launcher must ship outside app.asar/,
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

test("rejects a Windows build shipping the POSIX shell launcher", async (t) => {
  const app = await fixture(t, { platform: "win32" });
  const launcher = path.join(path.dirname(app.archive), "lumine.sh");
  fs.copyFileSync(path.join(app.repoRoot, "lumine.sh"), launcher);

  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /Incorrect win32 shell launcher/,
  );
});

test("rejects a build missing its shell launcher", async (t) => {
  const app = await fixture(t);
  fs.unlinkSync(path.join(path.dirname(app.archive), "lumine.sh"));

  assert.throws(
    () => checkBuiltApp(app.archive, { repoRoot: app.repoRoot }),
    /Missing linux shell launcher/,
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
