const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const temp = require("@lumine-code/fs-temp").track();
const ModuleLoader = require("../src/module-loader");
const Package = require("../src/package");
const { requireModule } = require("../src/module-utils");

describe("native package module loading", () => {
  let directory;
  let discoveredDirectories;

  function write(relativePath, source) {
    const filePath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    return filePath;
  }

  function runtimePathFor(value) {
    const paths = Object.keys(require.cache).filter(
      (filename) => require.cache[filename].exports === value,
    );
    return paths.find((filename) => filename.includes(".lumine-generation-")) ?? paths[0];
  }

  function buildPackage() {
    return new Package({
      path: directory,
      metadata: JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")),
      packageManager: lumine.packages,
      config: lumine.config,
      styleManager: lumine.styles,
      notificationManager: lumine.notifications,
      keymapManager: lumine.keymaps,
      commandRegistry: lumine.commands,
      grammarRegistry: lumine.grammars,
      themeManager: lumine.themes,
      menuManager: lumine.menu,
      contextMenuManager: lumine.contextMenu,
      deserializerManager: lumine.deserializers,
      viewRegistry: lumine.views,
    });
  }

  beforeEach(() => {
    discoveredDirectories = [];
    directory = fs.realpathSync(temp.mkdirSync("native-package-modules"));
    write(
      "package.json",
      JSON.stringify({
        name: path.basename(directory),
        version: "1.0.0",
        type: "module",
        main: "main.js",
        engines: { lumine: "^1.0.0" },
      }),
    );
    ModuleLoader.registerPackage(directory);
  });

  afterEach(() => {
    for (const root of [directory, ...discoveredDirectories]) {
      Package.prototype.clearRequireCache.call({ path: root });
    }
    temp.cleanupSync();
  });

  it("allows CommonJS to load a native ESM default that imports CommonJS", () => {
    write("helper.cjs", "module.exports = { value: 42 };");
    const main = write(
      "main.js",
      'import helper from "./helper.cjs"; export default { value: helper.value };',
    );
    const consumer = write("consumer.cjs", 'module.exports = require("./main.js").default;');

    expect(requireModule(main).value).toBe(42);
    expect(require(consumer)).toBe(requireModule(main));
  });

  it("honors explicit CommonJS packages while allowing their .mjs modules", () => {
    write("package.json", JSON.stringify({ name: path.basename(directory), type: "commonjs" }));
    const main = write("main.js", "module.exports = { value: 42 };");
    const native = write("native.mjs", 'import main from "./main.js"; export default main;');

    expect(requireModule(native)).toBe(require(main));
    expect(require(main).value).toBe(42);
  });

  it("adopts CommonJS loaded before discovery without duplicating its exports", async () => {
    const discovered = fs.realpathSync(temp.mkdirSync("early-commonjs-package"));
    discoveredDirectories.push(discovered);
    const main = path.join(discovered, "main.cjs");
    fs.writeFileSync(main, "module.exports = { value: 42 };");
    const first = require(main);
    ModuleLoader.registerPackage(discovered);

    expect(require(main)).toBe(first);
    expect((await import(pathToFileURL(main).href)).default).toBe(first);
  });

  it("adopts installed CommonJS constructors alongside a package loaded before discovery", () => {
    const discovered = fs.realpathSync(temp.mkdirSync("early-commonjs-dependency"));
    discoveredDirectories.push(discovered);
    const dependency = path.join(discovered, "node_modules", "legacy");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, "package.json"), '{"name":"legacy","main":"index.cjs"}');
    const implementation = path.join(dependency, "index.cjs");
    fs.writeFileSync(implementation, "exports.SharedModel = class SharedModel {};");
    const main = path.join(discovered, "main.cjs");
    fs.writeFileSync(main, 'module.exports = { SharedModel: require("legacy").SharedModel };');
    const first = require(main);
    ModuleLoader.registerPackage(discovered);

    expect(require(main)).toBe(first);
    expect(require(implementation).SharedModel).toBe(first.SharedModel);
    ModuleLoader.invalidatePackage(discovered);
    const second = require(main);
    expect(second).not.toBe(first);
    expect(second.SharedModel).toBe(first.SharedModel);
  });

  it("unifies managed require and import after a native ESM preload", async () => {
    const discovered = fs.realpathSync(temp.mkdirSync("early-esm-package"));
    discoveredDirectories.push(discovered);
    const main = path.join(discovered, "main.mjs");
    fs.writeFileSync(main, "export default { value: 42 };");
    const first = requireModule(main);
    ModuleLoader.registerPackage(discovered);
    const managed = requireModule(main);

    expect(managed).not.toBe(first);
    expect((await import(pathToFileURL(main).href)).default).toBe(managed);
    expect(managed.value).toBe(42);
  });

  it("unifies managed native ESM even when its explicit CommonJS interop returns a plain object", async () => {
    const discovered = fs.realpathSync(temp.mkdirSync("early-esm-commonjs-interop"));
    discoveredDirectories.push(discovered);
    const main = path.join(discovered, "main.mjs");
    fs.writeFileSync(
      main,
      'const api = { value: 42 }; export { api as "module.exports" }; export default api;',
    );
    const first = require(main);
    ModuleLoader.registerPackage(discovered);
    const managed = require(main);
    const native = await import(pathToFileURL(main).href);

    expect(managed).not.toBe(first);
    expect(native.default).toBe(managed);
    expect(native["module.exports"]).toBe(managed);
  });

  it("preserves named exports when native ESM later imports an adopted CommonJS generation", async () => {
    const discovered = fs.realpathSync(temp.mkdirSync("early-commonjs-namespace"));
    discoveredDirectories.push(discovered);
    const helper = path.join(discovered, "helper.cjs");
    const main = path.join(discovered, "main.mjs");
    fs.writeFileSync(helper, "exports.foo = 1;");
    const adopted = require(helper);
    fs.writeFileSync(
      main,
      'export default { prior: import.meta.require("./helper.cjs"), load: () => import("./helper.cjs") };',
    );
    ModuleLoader.registerPackage(discovered);
    const first = requireModule(main);
    expect(first.prior).toBe(adopted);
    fs.writeFileSync(helper, "exports.bar = 2;");
    ModuleLoader.invalidatePackage(discovered);
    const namespace = await first.load();

    expect(namespace.foo).toBe(1);
    expect(namespace.bar).toBeUndefined();
    expect(namespace.default).toBe(adopted);
  });

  it("exposes the same Lumine API through native default and named imports", () => {
    const main = write(
      "main.js",
      'import api, { Point, Disposable, TextEditor } from "lumine"; export default { api, Point, Disposable, TextEditor };',
    );
    const loaded = requireModule(main);
    const api = require("lumine");

    expect(loaded.api).toBe(api);
    expect(loaded.Point).toBe(api.Point);
    expect(loaded.Disposable).toBe(api.Disposable);
    expect(loaded.TextEditor).toBe(api.TextEditor);
  });

  it("compiles a native TypeScript and TSX dependency graph without rewriting its imports", () => {
    write(
      "view.tsx",
      '/** @jsx createElement */\nimport type { Unused } from "./absent.ts";\nconst createElement = (...args: unknown[]) => args;\nexport default <div title="native" />;',
    );
    const main = write(
      "main.ts",
      'import view from "./view.tsx"; export const value: number = 42; export default view;',
    );
    const loaded = require(main);

    expect(loaded.value).toBe(42);
    expect(loaded.default).toEqual(["div", { title: "native" }]);
  });

  it("keeps import and require export conditions distinct and awaits native top-level await", async () => {
    write(
      "node_modules/conditional/package.json",
      JSON.stringify({
        name: "conditional",
        type: "module",
        exports: { import: "./import.js", require: "./require.cjs" },
      }),
    );
    write(
      "node_modules/conditional/import.js",
      'await Promise.resolve(); export const mode = "import"; export class SharedModel {};',
    );
    write("node_modules/conditional/require.cjs", 'module.exports = { mode: "require" };');
    const main = write(
      "main.cjs",
      'module.exports = { synchronous: require("conditional"), load: () => import("conditional") };',
    );
    const loaded = require(main);

    expect(loaded.synchronous.mode).toBe("require");
    expect((await loaded.load()).mode).toBe("import");
    const imported = await loaded.load();
    for (let reload = 0; reload < 3; reload++) {
      ModuleLoader.invalidatePackage(directory);
      const current = require(main);
      expect(current).not.toBe(loaded);
      expect(current.synchronous).toBe(loaded.synchronous);
      const currentImport = await current.load();
      expect(currentImport.mode).toBe("import");
      expect(currentImport.SharedModel).toBe(imported.SharedModel);
    }
  });

  it("refreshes package state without cloning its installed ESM and CommonJS constructors", () => {
    write(
      "node_modules/esm-shared/package.json",
      '{"name":"esm-shared","type":"module","exports":"./index.js"}',
    );
    write("node_modules/esm-shared/index.js", "export class SharedModel {};");
    write(
      "node_modules/cjs-shared/package.json",
      '{"name":"cjs-shared","type":"commonjs","main":"index.cjs"}',
    );
    write("node_modules/cjs-shared/index.cjs", "exports.SharedModel = class SharedModel {};");
    const main = write(
      "main.js",
      'import { SharedModel } from "esm-shared"; import legacy from "cjs-shared"; export default { state: {}, SharedModel, LegacyModel: legacy.SharedModel };',
    );
    const commonMain = write(
      "main.cjs",
      'module.exports = { state: {}, SharedModel: require("esm-shared").SharedModel, LegacyModel: require("cjs-shared").SharedModel };',
    );
    const first = requireModule(main);
    let previous = first;
    for (let reload = 0; reload < 6; reload++) {
      ModuleLoader.invalidatePackage(directory);
      const current = requireModule(main);
      const common = require(commonMain);

      expect(current).not.toBe(previous);
      expect(current.state).not.toBe(previous.state);
      expect(common.state).not.toBe(current.state);
      expect(current.SharedModel).toBe(first.SharedModel);
      expect(current.LegacyModel).toBe(first.LegacyModel);
      expect(common.SharedModel).toBe(first.SharedModel);
      expect(common.LegacyModel).toBe(first.LegacyModel);
      expect(new current.SharedModel() instanceof first.SharedModel).toBe(true);
      expect(new current.LegacyModel() instanceof first.LegacyModel).toBe(true);
      previous = current;
    }
  });

  it("refreshes an installed ESM dependency after its source changes at the same manifest version", async () => {
    const manifest = write(
      "node_modules/esm-updated/package.json",
      '{"name":"esm-updated","version":"1.0.0","type":"module","exports":"./index.js"}',
    );
    const implementation = write(
      "node_modules/esm-updated/index.js",
      "export class SharedModel { static version = 1; }",
    );
    const originalTime = fs.statSync(implementation).mtimeMs;
    const originalManifest = fs.readFileSync(manifest, "utf8");
    const main = write(
      "main.js",
      'import { SharedModel } from "esm-updated"; export default { SharedModel, load: () => import("esm-updated") };',
    );
    const first = requireModule(main);
    write("node_modules/esm-updated/index.js", "export class SharedModel { static version = 2; }");
    fs.utimesSync(implementation, new Date(), new Date(originalTime + 2000));
    ModuleLoader.invalidatePackage(directory);
    const second = requireModule(main);

    expect(fs.readFileSync(manifest, "utf8")).toBe(originalManifest);
    expect(second.SharedModel).not.toBe(first.SharedModel);
    expect(second.SharedModel.version).toBe(2);
    expect(first.SharedModel.version).toBe(1);
    expect((await first.load()).SharedModel).toBe(first.SharedModel);
    expect((await second.load()).SharedModel).toBe(second.SharedModel);
  });

  it("refreshes an installed CommonJS dependency after a same-size source edit", () => {
    write(
      "node_modules/cjs-updated/package.json",
      '{"name":"cjs-updated","version":"1.0.0","type":"commonjs","main":"index.cjs"}',
    );
    const implementation = write(
      "node_modules/cjs-updated/index.cjs",
      "exports.SharedModel = class SharedModel { static version = 1; };",
    );
    const before = fs.statSync(implementation);
    const main = write("main.cjs", 'module.exports = { load: () => require("cjs-updated") };');
    const first = require(main);
    const original = first.load();
    write(
      "node_modules/cjs-updated/index.cjs",
      "exports.SharedModel = class SharedModel { static version = 2; };",
    );
    fs.utimesSync(implementation, new Date(), new Date(before.mtimeMs + 2000));
    ModuleLoader.invalidatePackage(directory);
    const second = require(main);
    const updated = second.load();

    expect(fs.statSync(implementation).size).toBe(before.size);
    expect(updated.SharedModel).not.toBe(original.SharedModel);
    expect(updated.SharedModel.version).toBe(2);
    expect(first.load()).toBe(original);
    expect(original.SharedModel.version).toBe(1);
  });

  it("refreshes an installed dependency when only its manifest payload changes", () => {
    const manifest = write(
      "node_modules/manifest-updated/package.json",
      '{"name":"manifest-updated","version":"1.0.0","type":"module","exports":"./index.js"}',
    );
    const implementation = write(
      "node_modules/manifest-updated/index.js",
      "export class SharedModel {}; export const state = {};",
    );
    const originalTime = fs.statSync(implementation).mtimeMs;
    const main = write(
      "main.js",
      'import { SharedModel, state } from "manifest-updated"; export default { SharedModel, state };',
    );
    const first = requireModule(main);
    fs.writeFileSync(
      manifest,
      '{"name":"manifest-updated","version":"1.0.1","type":"module","exports":"./index.js"}',
    );
    const manifestTime = fs.statSync(manifest).mtimeMs;
    fs.utimesSync(manifest, new Date(), new Date(manifestTime + 2000));
    ModuleLoader.invalidatePackage(directory);
    const second = requireModule(main);

    expect(fs.statSync(implementation).mtimeMs).toBe(originalTime);
    expect(second.SharedModel).not.toBe(first.SharedModel);
    expect(second.state).not.toBe(first.state);
  });

  it("preserves old installed CommonJS objects for their first late native imports after successive updates", async () => {
    write(
      "node_modules/cjs-late-import/package.json",
      '{"name":"cjs-late-import","version":"1.0.0","type":"commonjs","main":"index.cjs"}',
    );
    const implementation = write(
      "node_modules/cjs-late-import/index.cjs",
      "exports.SharedModel = class SharedModel { static version = 1; }; exports.state = {};",
    );
    const main = write(
      "main.cjs",
      'module.exports = { library: require("cjs-late-import"), load: () => import("cjs-late-import"), loadSync: () => require("cjs-late-import") };',
    );
    const first = require(main);
    first.library.state.updatedAtRuntime = true;
    write(
      "node_modules/cjs-late-import/index.cjs",
      "exports.SharedModel = class SharedModel { static version = 2; }; exports.state = {};",
    );
    const before = fs.statSync(implementation);
    fs.utimesSync(implementation, new Date(), new Date(before.mtimeMs + 2000));
    ModuleLoader.invalidatePackage(directory);
    const second = require(main);

    expect(second.library.SharedModel.version).toBe(2);
    write(
      "node_modules/cjs-late-import/index.cjs",
      "exports.SharedModel = class SharedModel { static version = 3; }; exports.state = {};",
    );
    ModuleLoader.invalidatePackage(directory);
    const third = require(main);
    expect(third.library.SharedModel.version).toBe(3);
    expect(first.loadSync()).toBe(first.library);
    expect(second.loadSync()).toBe(second.library);
    expect(third.loadSync()).toBe(third.library);
    const oldImport = await first.load();
    expect(oldImport.default).toBe(first.library);
    expect(oldImport.SharedModel).toBe(first.library.SharedModel);
    expect(oldImport.default.state.updatedAtRuntime).toBeTrue();
    expect((await second.load()).default).toBe(second.library);
    expect((await third.load()).default).toBe(third.library);
    expect(require(implementation)).toBe(third.library);
    expect(require.cache[implementation].exports).toBe(third.library);
  });

  it("retains an unchanged nested library's CommonJS cache when its parent library changes", async () => {
    const parentManifest = write(
      "node_modules/parent-library/package.json",
      '{"name":"parent-library","version":"1.0.0","type":"commonjs","main":"index.cjs"}',
    );
    write(
      "node_modules/parent-library/index.cjs",
      'module.exports = { child: require("child-library") };',
    );
    write(
      "node_modules/parent-library/node_modules/child-library/package.json",
      '{"name":"child-library","version":"1.0.0","type":"commonjs","main":"index.cjs"}',
    );
    const childPath = write(
      "node_modules/parent-library/node_modules/child-library/index.cjs",
      "exports.SharedModel = class SharedModel {}; exports.state = {};",
    );
    const main = write("main.cjs", 'module.exports = require("parent-library");');
    const first = require(main);
    const childModule = require.cache[childPath];
    fs.writeFileSync(
      parentManifest,
      '{"name":"parent-library","version":"1.0.1","type":"commonjs","main":"index.cjs"}',
    );
    ModuleLoader.invalidatePackage(directory);
    const second = require(main);

    expect(second).not.toBe(first);
    expect(second.child).toBe(first.child);
    expect(second.child.SharedModel).toBe(first.child.SharedModel);
    expect(require.cache[childPath]).toBe(childModule);
    const imported = await import(pathToFileURL(childPath).href);
    expect(imported.default).toBe(first.child);
    expect(imported.SharedModel).toBe(first.child.SharedModel);
  });

  it("requires native ESM relative extensions instead of applying CommonJS inference", () => {
    write("helper.js", "export default 42;");
    const main = write("main.js", 'import value from "./helper"; export default value;');

    expect(() => require(main)).toThrowMatching((error) => error.code === "ERR_MODULE_NOT_FOUND");
  });

  it("reports top-level await to synchronous consumers while allowing native async imports", async () => {
    const main = write("main.js", "await Promise.resolve(); export const value = 42;");

    expect(() => require(main)).toThrowMatching(
      (error) => error.code === "ERR_REQUIRE_ASYNC_MODULE",
    );
    expect((await import(pathToFileURL(main).href)).value).toBe(42);
  });

  it("loads a new complete ESM and CommonJS graph after invalidation", () => {
    const common = write("common.cjs", "module.exports = { version: 1 };");
    const dependency = write("dependency.js", "export const state = { version: 1 };");
    const main = write(
      "main.js",
      'import common from "./common.cjs"; import { state } from "./dependency.js"; export default { common, state };',
    );
    const first = requireModule(main);
    fs.writeFileSync(common, "module.exports = { version: 2 };");
    fs.writeFileSync(dependency, "export const state = { version: 2 };");
    ModuleLoader.invalidatePackage(directory);
    const second = requireModule(main);

    expect(second).not.toBe(first);
    expect(second.common).not.toBe(first.common);
    expect(second.state).not.toBe(first.state);
    expect(second.common.version).toBe(2);
    expect(second.state.version).toBe(2);
    expect(first.common.version).toBe(1);
    expect(first.state.version).toBe(1);
  });

  it("keeps late dynamic imports in the generation of the calling module", async () => {
    write("dependency.js", "export const version = 1;");
    const main = write("main.js", 'export default { load: () => import("./dependency.js") };');
    const first = requireModule(main);
    expect((await first.load()).version).toBe(1);
    Package.prototype.clearRequireCache.call({ path: directory });
    write("dependency.js", "export const version = 2;");
    const second = requireModule(main);

    expect((await second.load()).version).toBe(2);
    expect((await first.load()).version).toBe(1);
  });

  it("reloads native JSON modules with the JavaScript graph that imports them", () => {
    write("settings.json", '{"version":1}');
    const main = write(
      "main.js",
      'import settings from "./settings.json" with { type: "json" }; export default settings;',
    );
    const first = requireModule(main);
    write("settings.json", '{"version":2}');
    ModuleLoader.invalidatePackage(directory);
    const second = requireModule(main);

    expect(second).not.toBe(first);
    expect(second.version).toBe(2);
    expect(first.version).toBe(1);
  });

  it("shares a retired JSON object's runtime changes with the first later native import", async () => {
    write("settings.json", '{"version":1}');
    const main = write(
      "main.js",
      'export default { prior: import.meta.require("./settings.json"), load: () => import("./settings.json", { with: { type: "json" } }) };',
    );
    const first = requireModule(main);
    first.prior.runtimeValue = 7;
    write("settings.json", '{"version":2}');
    ModuleLoader.invalidatePackage(directory);
    const namespace = await first.load();

    expect(namespace.default).toBe(first.prior);
    expect(namespace.default.version).toBe(1);
    expect(namespace.default.runtimeValue).toBe(7);
  });

  it("keeps deferred CommonJS dependencies in the generation of the calling module", () => {
    write("dependency.cjs", "module.exports = { version: 1 };");
    const main = write("main.cjs", 'module.exports = { load: () => require("./dependency.cjs") };');
    const first = require(main);
    expect(first.load().version).toBe(1);
    Package.prototype.clearRequireCache.call({ path: directory });
    write("dependency.cjs", "module.exports = { version: 2 };");
    const second = require(main);

    expect(second.load().version).toBe(2);
    expect(first.load().version).toBe(1);
  });

  it("lets a registered spec reacquire the package while runtime closures keep their original generation", () => {
    write("state.cjs", "module.exports = { version: 1 };");
    write("main.cjs", 'module.exports = { load: () => require("./state.cjs") };');
    const specification = write(
      "spec/control.cjs",
      'module.exports = { first: require("../main.cjs"), load: () => require("../main.cjs") };',
    );
    ModuleLoader.registerTestModule(specification);
    const control = require(specification);
    const first = control.first;
    expect(first.load().version).toBe(1);
    ModuleLoader.invalidatePackage(directory);
    write("state.cjs", "module.exports = { version: 2 };");
    const second = control.load();

    expect(second).not.toBe(first);
    expect(second.load().version).toBe(2);
    expect(first.load().version).toBe(1);
    expect(control.first).toBe(first);
    expect(require(specification)).toBe(control);
  });

  it("keeps import.meta.require in the generation of the native ESM caller", () => {
    const dependency = write("dependency.cjs", "module.exports = { version: 1 };");
    const main = write(
      "main.js",
      'export default { load: () => import.meta.require("./dependency.cjs"), resolve: () => import.meta.require.resolve("./dependency.cjs") };',
    );
    const first = requireModule(main);
    expect(first.load().version).toBe(1);
    expect(first.resolve()).toBe(dependency);
    ModuleLoader.invalidatePackage(directory);
    write("dependency.cjs", "module.exports = { version: 2 };");
    const second = requireModule(main);

    expect(second.load().version).toBe(2);
    expect(first.load().version).toBe(1);
    expect(second.resolve()).toBe(dependency);
  });

  it("keeps canonical native imports old while public createRequire selects the current epoch", async () => {
    const dependency = write(
      "dependency.cjs",
      "exports.Model = class First {}; exports.version = 1;",
    );
    const main = write(
      "canonical.mjs",
      'export default { bound: () => import.meta.require("./dependency.cjs"), load: () => import("./dependency.cjs") };',
    );
    const publicRequire = require("node:module").createRequire(pathToFileURL(main));
    const first = requireModule(main);
    const original = first.bound();
    expect(publicRequire("./dependency.cjs")).toBe(original);
    original.runtimeValue = 7;
    for (const version of [2, 3]) {
      write("dependency.cjs", `exports.Model = class Current {}; exports.version = ${version};`);
      ModuleLoader.invalidatePackage(directory);
      const current = requireModule(main).bound();
      const newlyCreated = require("node:module").createRequire(pathToFileURL(main));
      expect(current.version).toBe(version);
      expect(current.Model).not.toBe(original.Model);
      expect(publicRequire("./dependency.cjs")).toBe(current);
      expect(newlyCreated("./dependency.cjs")).toBe(current);
      expect(first.bound()).toBe(original);
      const namespace = await first.load();
      expect(namespace.default).toBe(original);
      expect(namespace.Model).toBe(original.Model);
      expect(namespace.default.runtimeValue).toBe(7);
      expect(first.bound()).toBe(original);
      expect(newlyCreated.resolve("./dependency.cjs")).toBe(dependency);
    }
  });

  it("discovers preloaded native ESM through an alias of a package inside node_modules", async () => {
    const installation = fs.realpathSync(temp.mkdirSync("native-installed-package"));
    const physical = path.join(installation, "node_modules", "linked-package");
    fs.mkdirSync(physical, { recursive: true });
    fs.writeFileSync(path.join(physical, "package.json"), '{"type":"module"}');
    const main = path.join(physical, "main.mjs");
    fs.writeFileSync(
      main,
      "export default { Model: class Model {}, hasBoundRequire: typeof import.meta.require === 'function' };",
    );
    const first = (await import(pathToFileURL(main).href)).default;
    expect(first.hasBoundRequire).toBeFalse();
    const alias = path.join(temp.mkdirSync("native-installed-alias"), "package");
    fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
    discoveredDirectories.push(alias);
    ModuleLoader.registerPackage(alias);
    const managed = requireModule(path.join(alias, "main.mjs"));
    expect(managed).not.toBe(first);
    expect(managed.Model).not.toBe(first.Model);
    expect(managed.hasBoundRequire).toBeTrue();
    expect(requireModule(main)).toBe(managed);
    expect((await import(pathToFileURL(main).href)).default).toBe(managed);
  });

  it("retains canonical CommonJS callbacks and late native namespaces across successive epochs", async () => {
    write("package.json", '{"name":"canonical-cjs"}');
    write("helper.cjs", "exports.Model = class First {}; exports.foo = 1;");
    const main = write(
      "main.cjs",
      'const prior = require("./helper.cjs"); module.exports = { prior, read: () => require("./helper.cjs"), load: () => import("./helper.cjs") };',
    );
    const first = require(main);
    expect(runtimePathFor(first)).toBe(main);
    first.prior.runtimeValue = 7;
    let firstNamespace;
    for (const version of [2, 3]) {
      write("helper.cjs", `exports.Model = class Current {}; exports.bar = ${version};`);
      ModuleLoader.invalidatePackage(directory);
      const current = require(main);
      const namespace = await first.load();
      firstNamespace ??= namespace;
      expect(namespace === firstNamespace)
        .withContext("same old namespace")
        .toBeTrue();
      expect(namespace.default).toBe(first.prior);
      expect(namespace.Model).toBe(first.prior.Model);
      expect(namespace.foo).toBe(1);
      expect(namespace.bar).toBeUndefined();
      expect(namespace.default.runtimeValue).toBe(7);
      expect(first.read() === first.prior)
        .withContext("old require callback")
        .toBeTrue();
      expect(current.read() === current.prior)
        .withContext("current require callback")
        .toBeTrue();
      expect((await current.load()).default).toBe(current.prior);
      expect(current.prior.Model).not.toBe(first.prior.Model);
    }
  });

  it("normalizes a cached ambiguous dependency before a native static import", async () => {
    write("package.json", '{"name":"cached-format"}');
    write(
      "node_modules/legacy/package.json",
      '{"name":"legacy","version":"1.0.0","main":"index.js"}',
    );
    const legacy = write(
      "node_modules/legacy/index.js",
      "exports.Model = class Shared {}; exports.foo = 1; exports.target = new.target;",
    );
    const original = require(legacy);
    const main = write(
      "importer.mjs",
      'import legacy, { Model } from "legacy"; export default { legacy, Model };',
    );
    const imported = requireModule(main);
    expect(imported.legacy).toBe(original);
    expect(imported.Model).toBe(original.Model);
    expect(imported.legacy.target).toBeUndefined();
    expect((await import(pathToFileURL(main).href)).default).toBe(imported);
    await expectAsync(
      import(pathToFileURL(legacy).href, { with: { type: "json" } }),
    ).toBeRejectedWith(
      jasmine.objectContaining({ code: "ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE" }),
    );
  });

  it("detects ambiguous native ESM and wrapper-shadowing JavaScript in the initial epoch", () => {
    write("package.json", '{"name":"native-format"}');
    const native = write("native.js", "export const value = 42;");
    const shadow = write("shadow.js", "const require = 42; export { require as value };");
    expect(require(native).value).toBe(42);
    expect(require(shadow).value).toBe(42);
  });

  it("keeps the cached untyped CommonJS format after its dependency becomes a module", async () => {
    write("package.json", '{"name":"old-untyped"}');
    write(
      "node_modules/legacy/package.json",
      '{"name":"legacy","version":"1.0.0","main":"index.js"}',
    );
    const legacy = write(
      "node_modules/legacy/index.js",
      "exports.Model = class First {}; exports.version = 1;",
    );
    const main = write(
      "main.mjs",
      'export default { prior: import.meta.require("legacy"), load: () => import("legacy") };',
    );
    const first = requireModule(main);
    first.prior.runtimeValue = 7;
    write(
      "node_modules/legacy/package.json",
      '{"name":"legacy","version":"2.0.0","type":"module","main":"index.js"}',
    );
    write(
      "node_modules/legacy/index.js",
      "export class Model {}; export const version = 2; export default { Model, version };",
    );
    ModuleLoader.invalidatePackage(directory);
    const current = requireModule(main);
    expect(current.prior.version).toBe(2);
    const legacyURL = pathToFileURL(legacy).href;
    // Native resolution can observe the updated manifest while the canonical
    // URL still names the old epoch. Supply that current hint deterministically
    // instead of relying on Node's platform-dependent package.json cache.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Supported by Lumine's Node 24 runtime, as in the loader under test.
    const hook = require("node:module").registerHooks({
      load(url, context, nextLoad) {
        return nextLoad(url, url === legacyURL ? { ...context, format: "module" } : context);
      },
    });
    try {
      const oldNamespace = await first.load();
      expect(oldNamespace.default).toBe(first.prior);
      expect(oldNamespace.Model).toBe(first.prior.Model);
      expect(oldNamespace.version).toBe(1);
      expect(oldNamespace.default.runtimeValue).toBe(7);
      const currentNamespace = await current.load();
      expect(currentNamespace.default).toBe(current.prior.default);
      expect(currentNamespace.default.version).toBe(2);
      expect(currentNamespace.Model).toBe(current.prior.Model);
    } finally {
      hook.deregister();
    }
  });

  it("keeps original CommonJS named exports when an old ESM caller imports their namespace later", async () => {
    write("helper.cjs", "exports.foo = 1;");
    const main = write(
      "main.js",
      'export default { prior: import.meta.require("./helper.cjs"), load: () => import("./helper.cjs") };',
    );
    const first = requireModule(main);
    write("helper.cjs", "exports.bar = 2;");
    ModuleLoader.invalidatePackage(directory);
    const second = requireModule(main);
    const oldNamespace = await first.load();
    const newNamespace = await second.load();

    expect(oldNamespace.foo).toBe(1);
    expect(oldNamespace.bar).toBeUndefined();
    expect(oldNamespace.default).toBe(first.prior);
    expect(newNamespace.bar).toBe(2);
    expect(newNamespace.foo).toBeUndefined();
    expect(newNamespace.default).toBe(second.prior);
  });

  it("preserves CommonJS directives with comments and leaves quoted expressions unchanged", () => {
    for (const [filename, start, strict] of [
      ["strict.cjs", '"use strict"\n', true],
      ["block-comment.cjs", '"use strict" /* keep the directive */\n', true],
      ["line-comment.cjs", '"use strict" // keep the directive\n', true],
      ["expression.cjs", '"use strict"\n+1;\n', false],
    ]) {
      const main = write(
        filename,
        start + "module.exports = { strict: (function () { return this; })() === undefined };",
      );

      expect(require(main).strict).withContext(filename).toBe(strict);
    }
  });

  it("reads an updated package type when CommonJS changes to native ESM", () => {
    write("package.json", '{"type":"commonjs"}');
    const main = write("main.js", "module.exports = { version: 1 };");
    const first = requireModule(main);
    write("package.json", '{"type":"module"}');
    write("main.js", "export default { version: 2 };");
    ModuleLoader.invalidatePackage(directory);

    expect(requireModule(main).version).toBe(2);
    expect(first.version).toBe(1);
  });

  it("reads an updated package type when native ESM changes to CommonJS", () => {
    const main = write("main.js", "export default { version: 1 };");
    const first = requireModule(main);
    write("package.json", '{"type":"commonjs"}');
    write("main.js", "module.exports = { version: 2 };");
    ModuleLoader.invalidatePackage(directory);

    expect(requireModule(main).version).toBe(2);
    expect(first.version).toBe(1);
  });

  it("preserves original public paths for ESM, CommonJS and asset resolution", () => {
    write("asset.txt", "native asset");
    const common = write(
      "common.cjs",
      'module.exports = { filename: __filename, dirname: __dirname, moduleFilename: module.filename, resolved: require.resolve("./sibling.cjs") };',
    );
    const sibling = write("sibling.cjs", "module.exports = {};");
    const main = write(
      "main.js",
      'import fs from "node:fs"; import common from "./common.cjs"; export default { common, meta: { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname }, resolved: import.meta.resolve("./sibling.cjs"), asset: fs.readFileSync(new URL("./asset.txt", import.meta.url), "utf8") };',
    );
    const loaded = requireModule(main);

    expect(loaded.common.filename).toBe(common);
    expect(loaded.common.moduleFilename).toBe(common);
    expect(loaded.common.dirname).toBe(directory);
    expect(loaded.common.resolved).toBe(sibling);
    expect(loaded.meta.url).toBe(pathToFileURL(main).href);
    expect(loaded.meta.filename).toBe(main);
    expect(loaded.meta.dirname).toBe(directory);
    expect(loaded.resolved).toBe(pathToFileURL(sibling).href);
    expect(loaded.asset).toBe("native asset");
  });

  it("exposes real require.resolve paths and active source cache entries to outside callers", () => {
    const main = write("main.cjs", "module.exports = { version: 1 };");
    const descriptor = write("descriptor.json", '{"name":"native descriptor"}');
    const resolvedMain = require.resolve(main);
    const resolvedDescriptor = require.resolve(descriptor);

    expect(resolvedMain).toBe(main);
    expect(resolvedDescriptor).toBe(descriptor);
    expect(fs.existsSync(resolvedMain)).toBe(true);
    expect(fs.existsSync(resolvedDescriptor)).toBe(true);
    const first = require(main);
    expect(require.cache[resolvedMain]?.exports).toBe(first);
    expect(require.cache[resolvedDescriptor]?.exports).toBeUndefined();
    const metadata = require(descriptor);
    expect(require.cache[resolvedDescriptor]?.exports).toBe(metadata);
    ModuleLoader.invalidatePackage(directory);
    expect(require.cache[resolvedMain]).toBeUndefined();
    expect(require.cache[resolvedDescriptor]).toBeUndefined();
    write("main.cjs", "module.exports = { version: 2 };");
    const second = require(main);

    expect(second.version).toBe(2);
    expect(require.cache[resolvedMain]?.exports).toBe(second);
  });

  it("compiles the first JSX require in a fresh standalone Node process", () => {
    const main = write(
      "main.jsx",
      'const etch = { dom: (...args) => args }; module.exports = <button title="cold" />;',
    );
    const cacheDirectory = temp.mkdirSync("cold-native-module-compile-cache");
    const script = `
const CompileCache = require(${JSON.stringify(require.resolve("../src/compile-cache"))});
CompileCache.setCacheDirectory(${JSON.stringify(cacheDirectory)});
CompileCache.install(process.resourcesPath, require);
require(${JSON.stringify(require.resolve("../src/module-loader"))}).registerPackage(${JSON.stringify(directory)});
process.stdout.write(JSON.stringify(require(${JSON.stringify(main)})));
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });

    expect(result.status)
      .withContext(result.stderr || result.error?.message)
      .toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["button", { title: "cold" }]);
  });

  it("reads each managed JavaScript source and unchanged installed library only once", () => {
    const sources = [
      write("single-read.js", "export default 42;"),
      write("single-read.mjs", "export default 42;"),
      write("single-read.cjs", "module.exports = 42;"),
      write("node_modules/single-read/index.cjs", "module.exports = 42;"),
    ];
    write("node_modules/single-read/package.json", '{"main":"index.cjs"}');
    const read = spyOn(fs, "readFileSync").and.callThrough();
    for (const source of sources) {
      expect(requireModule(source)).withContext(source).toBe(42);
      expect(read.calls.allArgs().filter(([filename]) => filename === source).length)
        .withContext(source)
        .toBe(1);
    }
  });

  it("still compiles pragma-marked installed libraries after reading them natively", () => {
    const main = write(
      "node_modules/pragma/index.js",
      '/** @babel */\nconst etch = { dom: (...args) => args }; module.exports = <button title="native read" />;',
    );
    write("node_modules/pragma/package.json", '{"type":"commonjs","main":"index.js"}');

    expect(require(main)).toEqual(["button", { title: "native read" }]);
  });

  it("preserves native import-attribute validation for managed JavaScript", async () => {
    for (const filename of ["attributes.js", "attributes.mjs", "attributes.cjs"]) {
      const main = write(
        filename,
        filename.endsWith(".cjs") ? "module.exports = 42;" : "export default 42;",
      );
      await expectAsync(
        import(pathToFileURL(main).href, { with: { type: "json" } }),
      ).toBeRejectedWith(
        jasmine.objectContaining({ code: "ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE" }),
      );
    }
  });

  it("reuses syntax analysis across fresh processes and invalidates it when source changes", () => {
    const main = write(
      "cached-analysis.jsx",
      '"use strict"; module.exports = { value: 42, strict: (function () { return this; })() === undefined };',
    );
    const cacheDirectory = temp.mkdirSync("native-module-analysis-cache");
    const script = `
const Module = require("node:module");
const loader = require(${JSON.stringify(require.resolve("../src/module-loader"))});
const originalLoad = Module._load;
let parses = 0;
Module._load = function (specifier, ...args) {
  const loaded = originalLoad.call(this, specifier, ...args);
  return specifier === "@babel/parser" ? {
    parse(...args) { parses++; return loaded.parse(...args); }
  } : loaded;
};
loader.setCacheDirectory(${JSON.stringify(cacheDirectory)});
loader.install(source => source);
loader.registerPackage(${JSON.stringify(directory)});
const value = require(${JSON.stringify(main)});
process.stdout.write(JSON.stringify({ parses, value }));
`;
    const run = () => {
      const result = spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      });
      expect(result.status)
        .withContext(result.stderr || result.error?.message)
        .toBe(0);
      return JSON.parse(result.stdout);
    };
    const first = run();
    const second = run();

    expect(first.parses).toBeGreaterThan(0);
    expect(second.parses).toBe(0);
    expect(second.value).toEqual({ value: 42, strict: true });
    write("cached-analysis.jsx", "module.exports = { value: 43, strict: false };");
    const updated = run();
    expect(updated.parses).toBeGreaterThan(0);
    expect(updated.value).toEqual({ value: 43, strict: false });
  });

  it("uses one generation through both a symlinked package path and its real path", () => {
    const linked = path.join(temp.mkdirSync("native-package-link"), "package");
    fs.symlinkSync(directory, linked, process.platform === "win32" ? "junction" : "dir");
    ModuleLoader.registerPackage(linked);
    const main = write("main.js", "export default { version: 1 };");
    const first = requireModule(path.join(linked, "main.js"));

    expect(requireModule(main)).toBe(first);
    write("main.js", "export default { version: 2 };");
    Package.prototype.clearRequireCache.call({ path: linked });
    const second = requireModule(main);
    expect(second).not.toBe(first);
    expect(requireModule(path.join(linked, "main.js"))).toBe(second);
    expect(second.version).toBe(2);
  });

  it("preserves module identities across unload for rollback and advances them on a normal unload", () => {
    write("dependency.js", "export const state = {};");
    write(
      "main.js",
      'import { state } from "./dependency.js"; export default { state, version: 1 };',
    );
    let pack = buildPackage();
    pack.load();
    const first = pack.requireMainModule();
    pack.unload({ preserveModuleCache: true });
    write(
      "main.js",
      'import { state } from "./dependency.js"; export default { state, version: 2 };',
    );
    pack = buildPackage();
    pack.load();
    const rollback = pack.requireMainModule();
    expect(rollback).toBe(first);
    expect(rollback.version).toBe(1);
    pack.unload();
    pack = buildPackage();
    pack.load();
    const updated = pack.requireMainModule();

    expect(updated).not.toBe(first);
    expect(updated.state).not.toBe(first.state);
    expect(updated.version).toBe(2);
    pack.unload();
  });

  it("initializes, activates and unloads native ESM commands and service registrations across generations", async () => {
    const name = path.basename(directory);
    const serviceName = `${name}.service`;
    const command = `${name}:run`;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    manifest.providedServices = { [serviceName]: { versions: { "1.0.0": "provideService" } } };
    write("package.json", JSON.stringify(manifest));
    function writeMain(version) {
      write(
        "main.js",
        `import { Disposable } from "lumine";
export default {
  version: ${version},
  events: [],
  initialize({ subscriptions }) {
    this.events.push("initialize");
    this.subscriptions = subscriptions;
    subscriptions.add(new Disposable(() => this.events.push("cleanup")));
  },
  activate() {
    this.events.push("activate");
    this.subscriptions.add(lumine.commands.add("lumine-workspace", ${JSON.stringify(command)}, () => this.events.push("command")));
  },
  provideService() { return this; },
  deactivate() { this.events.push("deactivate"); }
};`,
      );
    }
    writeMain(1);
    const received = [];
    const disposed = [];
    const { Disposable } = require("lumine");
    const subscription = lumine.packages.serviceHub.consume(serviceName, "^1.0.0", (service) => {
      received.push(service);
      return new Disposable(() => disposed.push(service));
    });
    const workspace = lumine.views.getView(lumine.workspace);
    try {
      let pack = lumine.packages.loadPackage(directory);
      await lumine.packages.startPackage(name);
      const first = pack.mainModule;
      expect(first.events).toEqual(["initialize", "activate"]);
      expect(received).toEqual([first]);
      lumine.commands.dispatch(workspace, command);
      expect(first.events).toEqual(["initialize", "activate", "command"]);
      await lumine.packages.unloadPackage(name);
      expect(first.events).toEqual(["initialize", "activate", "command", "deactivate", "cleanup"]);
      expect(disposed).toEqual([first]);
      expect(lumine.packages.serviceHub.hasProvider(serviceName, "^1.0.0")).toBe(false);
      lumine.commands.dispatch(workspace, command);
      expect(first.events.filter((event) => event === "command").length).toBe(1);
      writeMain(2);
      pack = lumine.packages.loadPackage(directory);
      await lumine.packages.startPackage(name);
      const second = pack.mainModule;

      expect(second).not.toBe(first);
      expect(second.version).toBe(2);
      expect(second.events).toEqual(["initialize", "activate"]);
      expect(received).toEqual([first, second]);
      lumine.commands.dispatch(workspace, command);
      expect(second.events).toEqual(["initialize", "activate", "command"]);
      await lumine.packages.unloadPackage(name);
      expect(disposed).toEqual([first, second]);
    } finally {
      if (lumine.packages.getLoadedPackage(name)) await lumine.packages.unloadPackage(name);
      subscription.dispose();
    }
  });

  it("reports errors against the original package source path", () => {
    for (const [filename, source, line] of [
      ["main.js", 'export function fail() { throw new Error("native source failure"); }', 1],
      [
        "typed.ts",
        'export function fail(): never {\n  throw new Error("native source failure");\n}',
        2,
      ],
    ]) {
      const main = write(filename, source);
      let failure;
      try {
        require(main).fail();
      } catch (error) {
        failure = error;
      }

      expect(failure.message).toBe("native source failure");
      expect(
        failure.stack.includes(`${main}:${line}:`) ||
          failure.stack.includes(`${pathToFileURL(main).href}:${line}:`),
      )
        .withContext(failure.stack)
        .toBe(true);
      expect(failure.stack).not.toContain(".lumine-generation-");
    }
  });

  it("shares immutable source-map payloads across unchanged large CommonJS generations", () => {
    const padding = Array.from({ length: 2500 }, (_, index) => `  ${index},`).join("\n");
    const main = write(
      "large-map.cjs",
      `const values = [\n${padding}\n];\nmodule.exports = { values, fail() { throw new Error("original source failure"); } };`,
    );
    const failureLine = padding.split("\n").length + 3;
    const generations = [];
    const maps = [];
    for (let reload = 0; reload < 3; reload++) {
      if (reload) ModuleLoader.invalidatePackage(directory);
      const loaded = require(main);
      const virtual = runtimePathFor(loaded);
      generations.push(loaded);
      maps.push(ModuleLoader.getSourceMap(virtual));
    }

    expect(generations[1]).not.toBe(generations[0]);
    expect(generations[2]).not.toBe(generations[1]);
    expect(maps[1].map.file).not.toBe(maps[0].map.file);
    expect(maps[2].map.file).not.toBe(maps[1].map.file);
    expect(maps[0].map.sourcesContent).toEqual(maps[1].map.sourcesContent);
    for (const map of maps.slice(2)) {
      expect(map.map.sources).toBe(maps[1].map.sources);
      expect(map.map.names).toBe(maps[1].map.names);
      expect(map.map.sourcesContent).toBe(maps[1].map.sourcesContent);
      expect(map.map.mappings).toBe(maps[1].map.mappings);
    }
    expect(Object.isFrozen(maps[0])).toBe(true);
    expect(Object.isFrozen(maps[0].map)).toBe(true);
    expect(Object.isFrozen(maps[0].map.sourcesContent)).toBe(true);
    for (const loaded of generations) {
      let failure;
      try {
        loaded.fail();
      } catch (error) {
        failure = error;
      }
      expect(
        failure.stack.includes(`${main}:${failureLine}:`) ||
          failure.stack.includes(`${pathToFileURL(main).href}:${failureLine}:`),
      )
        .withContext(failure.stack)
        .toBe(true);
      expect(failure.stack).not.toContain(".lumine-generation-");
    }
  });

  it("builds diagnostic source maps only when requested", () => {
    const { SourceMapGenerator } = require("node:module").createRequire(
      require.resolve("source-map-support"),
    )("source-map");
    const addMapping = spyOn(SourceMapGenerator.prototype, "addMapping").and.callThrough();
    const main = write("lazy-map.cjs", "module.exports = { value: 42 }; // lazy diagnostics");
    const loaded = require(main);
    const virtual = runtimePathFor(loaded);

    expect(addMapping).not.toHaveBeenCalled();
    const map = ModuleLoader.getSourceMap(virtual);
    expect(addMapping).toHaveBeenCalled();
    expect(map.map.sourcesContent.join("\n")).toContain("lazy diagnostics");
    const calls = addMapping.calls.count();
    expect(ModuleLoader.getSourceMap(virtual)).toBe(map);
    expect(addMapping.calls.count()).toBe(calls);
  });

  it("keeps changed source contents and their retired stack mappings separate", () => {
    const main = write(
      "changed-map.cjs",
      'module.exports = { fail() {\n  throw new Error("old revision");\n} };',
    );
    const original = require(main);
    const originalPath = runtimePathFor(original);
    const originalMap = ModuleLoader.getSourceMap(originalPath);
    write(
      "changed-map.cjs",
      'module.exports = { fail() {\n  throw new Error("new revision");\n} };',
    );
    ModuleLoader.invalidatePackage(directory);
    const updated = require(main);
    const updatedPath = Object.keys(require.cache).find(
      (filename) =>
        filename.includes(".lumine-generation-") && require.cache[filename].exports === updated,
    );
    const updatedMap = ModuleLoader.getSourceMap(updatedPath);

    expect(updatedMap).not.toBe(originalMap);
    expect(updatedMap.map.sourcesContent).not.toBe(originalMap.map.sourcesContent);
    expect(updatedMap.map.mappings).not.toBe(originalMap.map.mappings);
    expect(ModuleLoader.getSourceMap(originalPath)).toBe(originalMap);
    expect(originalMap.map.sourcesContent.join("\n")).toContain("old revision");
    expect(updatedMap.map.sourcesContent.join("\n")).toContain("new revision");
    write(
      "changed-map.cjs",
      '\n\nmodule.exports = { fail() {\n  throw new Error("new revision");\n} };',
    );
    ModuleLoader.invalidatePackage(directory);
    const shifted = require(main);
    const shiftedPath = Object.keys(require.cache).find(
      (filename) =>
        filename.includes(".lumine-generation-") && require.cache[filename].exports === shifted,
    );
    const shiftedMap = ModuleLoader.getSourceMap(shiftedPath);
    expect(shiftedMap.map.sourcesContent).not.toBe(updatedMap.map.sourcesContent);
    expect(shiftedMap.map.mappings).not.toBe(updatedMap.map.mappings);
    for (const [loaded, line] of [
      [original, 2],
      [updated, 2],
      [shifted, 4],
    ]) {
      let failure;
      try {
        loaded.fail();
      } catch (error) {
        failure = error;
      }
      expect(
        failure.stack.includes(`${main}:${line}:`) ||
          failure.stack.includes(`${pathToFileURL(main).href}:${line}:`),
      )
        .withContext(failure.stack)
        .toBe(true);
      expect(failure.stack).not.toContain(".lumine-generation-");
    }
  });

  it("keeps source-map text and malformed diagnostics from preventing module execution", () => {
    const literal = "sourceMappingURL=data:application/json;base64,eyJ4IjoxfQ==";
    const main = write("map-literal.cjs", `module.exports = ${JSON.stringify(literal)};`);
    const malformed = write(
      "malformed-map.cjs",
      "module.exports = 42;\n//# sourceMappingURL=data:application/json;base64,not-a-map",
    );

    expect(require(main)).toBe(literal);
    expect(require(malformed)).toBe(42);
  });
});
