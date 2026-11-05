"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const generateMetadata = require("./generate-metadata-for-builder");
const { clearCache } = require("../src/bundled-packages");

test("baked metadata preserves bundled resources through the shipped manifest JSON", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-build-metadata-"));
  t.after(() => {
    clearCache();
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, value) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === "object" ? JSON.stringify(value) : value);
  };
  const manifest = {
    name: "lumine",
    version: "1.0.0",
    dependencies: {
      "fixture-package":
        "github:lumine-code/fixture-package#0123456789012345678901234567890123456789",
    },
  };
  const packageRoot = path.join("node_modules", "fixture-package");
  const packageManifest = {
    name: "fixture-package",
    version: "1.0.0",
    description: "Exercise bundled resources.",
    license: "MIT",
    repository: "https://github.com/lumine-code/fixture-package",
    engines: { lumine: "^1.0.0" },
    main: "lib/main.js",
    providedServices: { example: { versions: { "1.0.0": "provideExample" } } },
  };
  const packageKeymap = { "lumine-workspace": { "ctrl-alt-b": "fixture:toggle" } };
  const packageMenu = {
    menu: [{ label: "Fixture", submenu: [{ label: "Toggle", command: "fixture:toggle" }] }],
  };
  const coreMenu = {
    menu: [{ label: "File", submenu: [{ label: "Fixture", command: "fixture:toggle" }] }],
    "context-menu": { "lumine-text-editor": [{ label: "Fixture", command: "fixture:toggle" }] },
  };
  const commonKeys = { "lumine-workspace": { "ctrl-alt-a": "fixture:common" } };
  const platformKeys = { "lumine-workspace": { "ctrl-alt-p": "fixture:platform" } };
  write("package.json", manifest);
  write(path.join(packageRoot, "package.json"), packageManifest);
  write(path.join(packageRoot, "README.md"), "# Fixture\n\nExercise bundled resources.\n");
  write(path.join(packageRoot, "lib/main.js"), "module.exports = {};\n");
  write(path.join(packageRoot, "keymaps/main.json"), packageKeymap);
  write(path.join(packageRoot, "menus/main.json"), packageMenu);
  write(path.join(packageRoot, "grammars/main.json"), {
    name: "Fixture",
    scopeName: "source.fixture",
  });
  write(path.join(packageRoot, "settings/main.json"), {
    "source.fixture": { comments: { commentStart: "# " } },
  });
  write(path.join(packageRoot, "styles/main.less"), ".fixture { color: gold; }\n");
  write(path.join("menus", `${process.platform}.json`), coreMenu);
  write("keymaps/common.json", commonKeys);
  write(path.join("keymaps", `${process.platform}.json`), platformKeys);
  write(path.join("keymaps", process.platform === "win32" ? "linux.json" : "win32.json"), {
    "lumine-workspace": { "ctrl-alt-x": "fixture:other-platform" },
  });

  const previousDirectory = process.cwd();
  let generated;
  try {
    process.chdir(root);
    generated = generateMetadata(manifest);
  } finally {
    process.chdir(previousDirectory);
  }
  write("shipped-package.json", { ...manifest, ...generated });
  const shipped = JSON.parse(fs.readFileSync(path.join(root, "shipped-package.json"), "utf8"));
  assert.deepEqual(Object.keys(generated), ["lumineMetadata"]);
  const metadata = shipped.lumineMetadata;
  assert.deepEqual(metadata.menu, coreMenu);
  assert.deepEqual(metadata.keymaps, {
    "common.json": commonKeys,
    [`${process.platform}.json`]: platformKeys,
  });
  assert.deepEqual(Object.keys(metadata.packages), ["fixture-package"]);
  const bundled = metadata.packages["fixture-package"];
  for (const field of ["name", "version", "main", "engines", "providedServices"]) {
    assert.deepEqual(bundled.metadata[field], packageManifest[field]);
  }
  assert.equal(bundled.main, "../node_modules/fixture-package/lib/main.js");
  assert.deepEqual(bundled.keymaps[path.join(packageRoot, "keymaps/main.json")], packageKeymap);
  assert.deepEqual(bundled.menus[path.join(packageRoot, "menus/main.json")], packageMenu);
  assert.deepEqual(bundled.grammarPaths, [path.join("grammars", "main.json")]);
  assert.deepEqual(bundled.settingsPaths, [path.join("settings", "main.json")]);
  assert.deepEqual(bundled.styleSheetPaths, [path.join("styles", "main.less")]);
});
