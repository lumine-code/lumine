const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/fs-temp").track();
const babelCompiler = require("../src/babel");
const CompileCache = require("../src/compile-cache");

describe("CompileCache", () => {
  let lumineHome, fixtures, originalCacheDir;

  beforeEach(() => {
    fixtures = lumine.project.getPaths()[0];
    lumineHome = temp.mkdirSync("fake-lumine-home");
    originalCacheDir = CompileCache.getCacheDirectory();

    CompileCache.resetCacheStats();

    spyOn(babelCompiler, "compile").and.returnValue("the-babel-code");
  });

  afterEach(() => {
    CompileCache.setCacheDirectory(originalCacheDir);
    try {
      temp.cleanupSync();
    } catch {
      /* ignore cleanup failure */
    }
  });

  describe("addPathToCache(filePath, lumineHome)", () => {
    describe("when the given file is plain javascript", () => {
      it("does not compile or cache the file", function () {
        CompileCache.addPathToCache(path.join(fixtures, "sample.js"), lumineHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 0, misses: 0 });
      });
    });

    describe("when the given file uses babel", () => {
      it("compiles the file with babel and caches it", () => {
        CompileCache.addPathToCache(path.join(fixtures, "babel", "babel-comment.js"), lumineHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "babel", "babel-comment.js"), lumineHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is typescript", () => {
      it("compiles the file with babel unconditionally and caches it", function () {
        CompileCache.addPathToCache(path.join(fixtures, "typescript", "valid.ts"), lumineHome);
        expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "typescript", "valid.ts"), lumineHome);
        expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is TSX", () => {
      it("compiles the file with babel unconditionally and caches it", function () {
        CompileCache.addPathToCache(path.join(fixtures, "typescript", "jsx.tsx"), lumineHome);
        expect(CompileCache.getCacheStats()[".tsx"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "typescript", "jsx.tsx"), lumineHome);
        expect(CompileCache.getCacheStats()[".tsx"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is JSX", () => {
      it("compiles the file with babel unconditionally and caches it", function () {
        CompileCache.addPathToCache(
          path.join(fixtures, "babel", "default-factory.jsx"),
          lumineHome,
        );
        expect(CompileCache.getCacheStats()[".jsx"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(
          path.join(fixtures, "babel", "default-factory.jsx"),
          lumineHome,
        );
        expect(CompileCache.getCacheStats()[".jsx"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });

    it("does not reuse compiled TypeScript for identical source in a TSX file", function () {
      const directory = temp.mkdirSync("typescript-cache-extensions");
      const tsPath = path.join(directory, "same.ts");
      const tsxPath = path.join(directory, "same.tsx");
      const source = "export const value: number = 42;";
      fs.writeFileSync(tsPath, source);
      fs.writeFileSync(tsxPath, source);

      CompileCache.addPathToCache(tsPath, lumineHome);
      CompileCache.addPathToCache(tsxPath, lumineHome);

      expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 0, misses: 1 });
      expect(CompileCache.getCacheStats()[".tsx"]).toEqual({ hits: 0, misses: 1 });
      expect(babelCompiler.compile.calls.count()).toBe(2);
    });

    it("keeps each file's source map when TypeScript source is identical", function () {
      const directory = temp.mkdirSync("typescript-cache-paths");
      const firstPath = path.join(directory, "first.ts");
      const secondPath = path.join(directory, "second.ts");
      const source = "export const value: number = 42;";
      fs.writeFileSync(firstPath, source);
      fs.writeFileSync(secondPath, source);
      babelCompiler.compile.and.callThrough();

      const firstCompiled = CompileCache.addPathToCache(firstPath, lumineHome);
      const secondCompiled = CompileCache.addPathToCache(secondPath, lumineHome);
      const readSourceMap = (compiled) => {
        const encodedMap = compiled.match(/sourceMappingURL=data:[^,]+,([^\s]+)/)[1];
        return JSON.parse(Buffer.from(encodedMap, "base64").toString("utf8"));
      };

      expect(readSourceMap(firstCompiled).sources).toEqual(["first.ts"]);
      expect(readSourceMap(secondCompiled).sources).toEqual(["second.ts"]);
      expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 0, misses: 2 });
      expect(babelCompiler.compile.calls.count()).toBe(2);
    });
  });

  describe("overriding Error.prepareStackTrace", function () {
    it("removes the override on the next tick, and always assigns the raw stack", async function () {
      Error.prepareStackTrace = () => "a-stack-trace";

      let error = new Error("Oops");
      expect(error.stack).toBe("a-stack-trace");
      expect(Array.isArray(error.getRawStack())).toBe(true);

      await new Promise((resolve) => {
        jasmine.unspy(window, "setTimeout");
        setTimeout(resolve, 1);
      });

      error = new Error("Oops again");
      expect(error.stack).not.toBe("a-stack-trace");
      expect(Array.isArray(error.getRawStack())).toBe(true);
    });

    it("does not infinitely loop when the original prepareStackTrace value is reassigned", function () {
      const originalPrepareStackTrace = Error.prepareStackTrace;

      Error.prepareStackTrace = () => "a-stack-trace";
      Error.prepareStackTrace = originalPrepareStackTrace;

      const error = new Error("Oops");
      expect(error.stack).toContain("compile-cache-spec.js");
      expect(Array.isArray(error.getRawStack())).toBe(true);
    });

    it("does not infinitely loop when the assigned prepareStackTrace calls the original prepareStackTrace", function () {
      const originalPrepareStackTrace = Error.prepareStackTrace;

      Error.prepareStackTrace = function (error, stack) {
        error.foo = "bar";
        return originalPrepareStackTrace(error, stack);
      };

      const error = new Error("Oops");
      expect(error.stack).toContain("compile-cache-spec.js");
      expect(error.foo).toBe("bar");
      expect(Array.isArray(error.getRawStack())).toBe(true);
    });
  });
});
