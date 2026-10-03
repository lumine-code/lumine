const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
const CompileCache = require("../src/compile-cache");

describe("TypeScript transpiler support", function () {
  const fixtureDirectory = path.join(__dirname, "fixtures", "typescript");
  let originalCacheDir;

  function clearFixtureModules() {
    for (const cacheKey of Object.keys(require.cache)) {
      if (cacheKey.startsWith(fixtureDirectory + path.sep)) delete require.cache[cacheKey];
    }
  }

  beforeEach(function () {
    originalCacheDir = CompileCache.getCacheDirectory();
    CompileCache.setCacheDirectory(temp.mkdirSync("typescript-compile-cache"));
    clearFixtureModules();
  });

  afterEach(function () {
    clearFixtureModules();
    CompileCache.setCacheDirectory(originalCacheDir);
    try {
      temp.cleanupSync();
    } catch {
      /* ignore cleanup failure */
    }
  });

  describe("when there is a .ts file", () =>
    it("removes type annotations and preserves CommonJS exports", function () {
      const transpiled = require("./fixtures/typescript/valid.ts");
      expect(transpiled(3)).toBe(4);
    }));

  it("resolves .ts for an extensionless require", function () {
    const transpiled = require("./fixtures/typescript/valid");
    expect(transpiled(3)).toBe(4);
  });

  it("transforms ES module imports and named exports to CommonJS", function () {
    const transpiled = require("./fixtures/typescript/modules.ts");
    expect(transpiled.value).toBe(4);
    expect(transpiled.label).toBe("TypeScript");
  });

  it("removes explicit and inferred type-only imports before loading dependencies", function () {
    const transpiled = require("./fixtures/typescript/type-imports.ts");
    expect(transpiled).toEqual({ value: 42 });
  });

  it("leaves semantic type checking to the package's build", function () {
    const transpiled = require("./fixtures/typescript/type-mismatch.ts");
    expect(transpiled).toBe("a string assigned to a number");
  });

  it("transforms enums into their runtime values", function () {
    const transpiled = require("./fixtures/typescript/enum.ts");
    expect(transpiled.Direction.Up).toBe(1);
    expect(transpiled.Direction[2]).toBe("Down");
    expect(transpiled.direction).toBe(2);
  });

  it("parses angle-bracket type assertions in .ts files without treating them as JSX", function () {
    const transpiled = require("./fixtures/typescript/type-assertion.ts");
    expect(transpiled).toBe(3);
  });

  describe("when there is a .tsx file", function () {
    it("transpiles it with etch.dom as the default JSX factory", function () {
      const element = require("./fixtures/typescript/jsx.tsx");
      expect(element[0]).toBe("div");
      expect(element[1]).toEqual({ className: "settings-view" });
    });

    it("resolves .tsx for an extensionless require", function () {
      const element = require("./fixtures/typescript/jsx");
      expect(element[0]).toBe("div");
    });

    it("preserves the imported JSX factory and groups fragments without a wrapper", function () {
      const node = require("./fixtures/typescript/fragment.tsx");
      expect(node.tag).toBe("div");
      expect(node.children.map((child) => child.tag)).toEqual(["span", "span"]);
    });

    it("prefers the per-file JSX factory and fragment pragmas", function () {
      const element = require("./fixtures/typescript/factory-override.tsx");
      expect(element[0]).toBe("custom");
      expect(element[1]).toBe("custom-fragment");
      expect(element[3][1]).toBe("span");
    });
  });

  describe("when the .ts file is invalid", () => {
    it("reports a syntax error before executing the module", () => {
      expect(() => require("./fixtures/typescript/invalid.ts")).toThrowError(SyntaxError);
    });
  });
});
