const path = require("path");
const Module = require("module");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const ModuleCache = require("../src/module-cache");

describe("ModuleCache", function () {
  beforeEach(() => spyOn(Module, "_findPath").and.callThrough());

  afterEach(function () {
    try {
      temp.cleanupSync();
    } catch {
      /* ignore cleanup failure */
    }
  });

  it("resolves Electron module paths without hitting the filesystem", function () {
    const { builtins } = ModuleCache.cache;
    expect(Object.keys(builtins).length).toBeGreaterThan(0);

    for (let builtinName in builtins) {
      const builtinPath = builtins[builtinName];
      expect(require.resolve(builtinName)).toBe(builtinPath);
      expect(fs.isFileSync(require.resolve(builtinName))).toBeTruthy();
    }

    expect(Module._findPath.calls.count()).toBe(0);
  });

  it("exposes only the Lumine runtime module", function () {
    const { builtins } = ModuleCache.cache;
    expect(builtins.lumine).toBeDefined();
    expect(builtins.atom).toBeUndefined();
    expect(require("lumine")).toBe(require("../exports/lumine"));
    expect(() => require("atom")).toThrow();
  });

  it("resolves relative core paths without hitting the filesystem", function () {
    ModuleCache.add(lumine.application.getResourcePath(), {
      _lumineModuleCache: {
        extensions: {
          ".json": [path.join("spec", "fixtures", "module-cache", "file.json")],
        },
      },
    });
    expect(require("./fixtures/module-cache/file.json").foo).toBe("bar");
    expect(Module._findPath.calls.count()).toBe(0);
  });

  it("resolves module paths when a compatible version is provided by core", function () {
    const packagePath = fs.realpathSync(temp.mkdirSync("lumine-package"));
    ModuleCache.add(packagePath, {
      _lumineModuleCache: {
        folders: [
          {
            paths: [""],
            dependencies: {
              "@lumine-code/underscore-plus": "*",
            },
          },
        ],
      },
    });
    ModuleCache.add(lumine.application.getResourcePath(), {
      _lumineModuleCache: {
        dependencies: [
          {
            name: "@lumine-code/underscore-plus",
            version: require("@lumine-code/underscore-plus/package.json").version,
            path: path.join(
              "node_modules",
              "@lumine-code",
              "underscore-plus",
              "lib",
              "underscore-plus.js",
            ),
          },
        ],
      },
    });

    const indexPath = path.join(packagePath, "index.js");
    fs.writeFileSync(
      indexPath,
      `\
exports.load = function() { require('@lumine-code/underscore-plus'); };\
`,
    );

    const packageMain = require(indexPath);
    Module._findPath.calls.reset();
    packageMain.load();
    expect(Module._findPath.calls.count()).toBe(0);
  });

  it("does not resolve module paths when no compatible version is provided by core", function () {
    const packagePath = fs.realpathSync(temp.mkdirSync("lumine-package"));
    ModuleCache.add(packagePath, {
      _lumineModuleCache: {
        folders: [
          {
            paths: [""],
            dependencies: {
              "@lumine-code/underscore-plus": "0.0.1",
            },
          },
        ],
      },
    });
    ModuleCache.add(lumine.application.getResourcePath(), {
      _lumineModuleCache: {
        dependencies: [
          {
            name: "@lumine-code/underscore-plus",
            version: require("@lumine-code/underscore-plus/package.json").version,
            path: path.join(
              "node_modules",
              "@lumine-code",
              "underscore-plus",
              "lib",
              "underscore-plus.js",
            ),
          },
        ],
      },
    });

    const indexPath = path.join(packagePath, "index.js");
    fs.writeFileSync(
      indexPath,
      `\
exports.load = function() { require('@lumine-code/underscore-plus'); };\
`,
    );

    spyOn(process, "cwd").and.returnValue("/"); // Required when running this test from CLI
    const packageMain = require(indexPath);
    Module._findPath.calls.reset();
    expect(() => packageMain.load()).toThrow();
    expect(Module._findPath.calls.count()).toBe(1);
  });
});
