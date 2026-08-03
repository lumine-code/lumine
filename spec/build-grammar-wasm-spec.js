const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  packageDirsInRoot,
  collectAllConfigs,
  resolvePackageRoots,
  PACKAGES_DIR,
} = require("../script/build-grammar-wasm");

// Covers only the root resolution added so grammar packages can live outside
// this repository. Everything downstream of it needs emscripten and the
// network, so it stays out of the spec suite.

describe("build-grammar-wasm root resolution", () => {
  let tempRoot;

  function writeConfig(packageDir, fileName, config) {
    let grammarsDir = path.join(packageDir, "grammars");
    fs.mkdirSync(grammarsDir, { recursive: true });
    fs.writeFileSync(path.join(grammarsDir, fileName), JSON.stringify(config));
  }

  function treeSitterConfig(scopeName, wasm) {
    return {
      name: scopeName,
      scopeName,
      type: "modern-tree-sitter",
      treeSitter: { parserSource: "github:example/example#v1.0.0", grammar: wasm },
    };
  }

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-grammar-roots-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("packageDirsInRoot", () => {
    it("treats a root holding grammars/ as a single package", () => {
      let packageDir = path.join(tempRoot, "language-example");
      writeConfig(packageDir, "example.json", treeSitterConfig("source.example", "example.wasm"));

      expect(packageDirsInRoot(packageDir)).toEqual([packageDir]);
    });

    it("treats any other root as a directory of packages", () => {
      writeConfig(
        path.join(tempRoot, "language-a"),
        "a.json",
        treeSitterConfig("source.a", "a.wasm"),
      );
      writeConfig(
        path.join(tempRoot, "language-b"),
        "b.json",
        treeSitterConfig("source.b", "b.wasm"),
      );

      expect(packageDirsInRoot(tempRoot).sort()).toEqual(
        [path.join(tempRoot, "language-a"), path.join(tempRoot, "language-b")].sort(),
      );
    });

    it("returns nothing for a root that does not exist", () => {
      expect(packageDirsInRoot(path.join(tempRoot, "absent"))).toEqual([]);
    });
  });

  describe("collectAllConfigs", () => {
    it("defaults to this repository's packages", () => {
      let configs = collectAllConfigs();

      expect(configs.length).toBeGreaterThan(0);
      for (let entry of configs) {
        expect(entry.configPath.startsWith(PACKAGES_DIR)).toBe(true);
      }
    });

    it("collects configs from an out-of-tree package root", () => {
      let packageDir = path.join(tempRoot, "language-example");
      writeConfig(packageDir, "example.json", treeSitterConfig("source.example", "example.wasm"));

      let configs = collectAllConfigs([tempRoot]);

      expect(configs.length).toBe(1);
      expect(configs[0].packageName).toBe("language-example");
      expect(configs[0].config.scopeName).toBe("source.example");
    });

    it("skips configs that are not modern-tree-sitter grammars", () => {
      let packageDir = path.join(tempRoot, "language-example");
      writeConfig(packageDir, "textmate.json", { scopeName: "source.textmate", patterns: [] });
      writeConfig(packageDir, "no-wasm.json", {
        scopeName: "source.incomplete",
        type: "modern-tree-sitter",
        treeSitter: {},
      });

      expect(collectAllConfigs([tempRoot])).toEqual([]);
    });

    it("yields a config once even when its roots overlap", () => {
      let packageDir = path.join(tempRoot, "language-example");
      writeConfig(packageDir, "example.json", treeSitterConfig("source.example", "example.wasm"));

      expect(collectAllConfigs([tempRoot, packageDir]).length).toBe(1);
    });
  });

  describe("resolvePackageRoots", () => {
    it("always includes this repository's packages", () => {
      expect(resolvePackageRoots({ packageRoots: [], configPath: null })).toContain(PACKAGES_DIR);
    });

    it("includes explicitly requested roots", () => {
      let roots = resolvePackageRoots({ packageRoots: [tempRoot], configPath: null });

      expect(roots).toContain(path.resolve(tempRoot));
    });

    it("includes the package owning an explicitly passed config", () => {
      let packageDir = path.join(tempRoot, "language-example");
      let configPath = path.join(packageDir, "grammars", "example.json");

      let roots = resolvePackageRoots({ packageRoots: [], configPath });

      // The owning *package*, so its sibling configs join the same family.
      expect(roots).toContain(path.resolve(packageDir));
    });

    it("does not repeat a root requested twice", () => {
      let roots = resolvePackageRoots({ packageRoots: [tempRoot, tempRoot], configPath: null });

      expect(roots.filter((root) => root === path.resolve(tempRoot)).length).toBe(1);
    });
  });
});
