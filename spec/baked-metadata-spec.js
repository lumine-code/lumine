const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function loadWithManifest(name, manifest, replacements = {}) {
  const filename = require.resolve(`../src/${name}`);
  const sourceRequire = createRequire(filename);
  const localRequire = (request) => {
    if (request === "../package.json") return manifest;
    if (Object.hasOwn(replacements, request)) return replacements[request];
    return sourceRequire(request);
  };
  localRequire.resolve = sourceRequire.resolve;
  const loaded = { exports: {} };
  const initialize = vm.runInThisContext(
    `(function(module, exports, require, __filename, __dirname) {\n${fs.readFileSync(filename, "utf8")}\n})`,
    { filename },
  );
  initialize(loaded, loaded.exports, localRequire, filename, path.dirname(filename));
  return loaded.exports;
}

describe("baked build metadata", () => {
  const metadata = {
    packages: { "fixture-package": { metadata: { name: "fixture-package", main: "lib/main.js" } } },
    menu: {
      menu: [{ label: "Fixture", submenu: [{ label: "Toggle", command: "fixture:toggle" }] }],
      "context-menu": { "lumine-workspace": [{ label: "Toggle", command: "fixture:toggle" }] },
    },
    keymaps: { "common.json": { "lumine-workspace": { "ctrl-alt-b": "fixture:toggle" } } },
  };
  const manifest = JSON.parse(JSON.stringify({ lumineMetadata: metadata }));

  it("uses bundled package metadata on construction and after lifecycle reset", async () => {
    const PackageManager = loadWithManifest("package-manager", manifest);
    const manager = new PackageManager({ config: lumine.config, storage: {} });
    expect(manager.packagesCache).toEqual(metadata.packages);
    expect(Array.from(manager.getBundledPackageNames())).toEqual(["fixture-package"]);
    manager.packagesCache = {};
    await manager.reset();
    expect(manager.packagesCache).toEqual(metadata.packages);
    expect(Array.from(manager.getBundledPackageNames())).toEqual(["fixture-package"]);
    manager.emitter.dispose();
  });

  it("loads the baked application menu without source menu files", () => {
    const MenuManager = loadWithManifest("menu-manager", manifest);
    const add = jasmine.createSpy("add");
    MenuManager.prototype.loadPlatformItems.call({
      resourcePath: "missing-build-source",
      coreLayouts: new Map(),
      structuralIds: new Set(),
      add,
    });
    expect(add).toHaveBeenCalledOnceWith(metadata.menu.menu);
  });

  it("loads baked context-menu selectors without source menu files", () => {
    const ContextMenuManager = loadWithManifest("context-menu-manager", manifest);
    const add = jasmine.createSpy("add");
    ContextMenuManager.prototype.loadPlatformItems.call({
      resourcePath: "missing-build-source",
      devMode: false,
      add,
    });
    expect(add).toHaveBeenCalledOnceWith(metadata.menu["context-menu"], false);
  });

  it("loads baked key bindings with their core source identity", () => {
    class KeymapManager {}
    loadWithManifest("keymap-extensions", manifest, { "./keymap-manager": KeymapManager });
    const keymaps = new KeymapManager();
    keymaps.add = jasmine.createSpy("add");
    keymaps.loadKeymap = jasmine.createSpy("loadKeymap");
    keymaps.emitter = { emit: jasmine.createSpy("emit") };
    expect(keymaps.canLoadBundledKeymapsFromMemory()).toBe(true);
    keymaps.loadBundledKeymaps();
    expect(keymaps.add).toHaveBeenCalledOnceWith(
      "core:common.json",
      metadata.keymaps["common.json"],
      0,
      false,
    );
    expect(keymaps.loadKeymap).not.toHaveBeenCalled();
    expect(keymaps.emitter.emit).toHaveBeenCalledOnceWith("did-load-bundled-keymaps");
  });
});
