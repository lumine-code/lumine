"use strict";
/* global spyOn */

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");

// Load a coherent graph without replacing require.cache or the live checkout.
// In particular, the view and model must share their private record Symbols.
module.exports = function loadSnapshot(directory) {
  const workspace = path.resolve(__dirname, "../..");
  const cache = new Map();
  const libraryDirectory = path.join(directory, "fuzzy-search/lib");
  const library = require(path.join(libraryDirectory, "main.js"));
  const installedLibraryDirectory = path.dirname(require.resolve("@lumine-code/fuzzy-search"));
  const sources = {};
  const workerLibraryHashes = {};
  const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  function load(relative) {
    relative = relative.replaceAll("\\", "/");
    const file = path.join(directory, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const original = path.join(workspace, relative);
    const instance = new Module(file, module);
    instance.filename = file;
    instance.paths = Module._nodeModulePaths(path.dirname(original));
    cache.set(file, instance);
    const localRequire = Module.createRequire(original);
    instance.require = (name) => {
      if (name === "@lumine-code/fuzzy-search") return library;
      if (relative === "lumine/src/fuzzy-search-worker-client.js" && name === "node:fs") {
        return {
          ...fs,
          readFileSync(filename, ...args) {
            // workerSource resolves the installed library itself. Redirect its
            // bytes too, so the renderer and real Chromium worker agree.
            if (path.dirname(filename) === installedLibraryDirectory) {
              filename = path.join(libraryDirectory, path.basename(filename));
              workerLibraryHashes[path.basename(filename)] = hash(fs.readFileSync(filename));
            }
            return fs.readFileSync(filename, ...args);
          },
        };
      }
      if (name.startsWith(".")) {
        const target = path.resolve(path.dirname(file), name);
        for (const candidate of [target, `${target}.js`, `${target}.json`]) {
          if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
          if (candidate.endsWith(".json")) return JSON.parse(fs.readFileSync(candidate));
          return load(path.relative(directory, candidate));
        }
      }
      return localRequire(name);
    };
    const bytes = fs.readFileSync(file);
    sources[relative.replaceAll("\\", "/")] = hash(bytes);
    instance._compile(bytes.toString(), file);
    return instance.exports;
  }
  const SelectList = load("lumine/src/select-list.js");
  const factory = lumine.workspace.modalDialogFactory;
  spyOn(factory, "buildSelectList").and.callFake((options) => {
    const model = new SelectList(options, factory.services);
    factory.models.add(model);
    return model;
  });
  return { load, library, libraryDirectory, sources, workerLibraryHashes };
};
