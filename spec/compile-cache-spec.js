const path = require("path");
const temp = require("@lumine-code/temp").track();
const babelCompiler = require("../src/babel");
const TypeScriptTranspiler = require("../src/typescript");
const CompileCache = require("../src/compile-cache");

describe("CompileCache", () => {
  let lumineHome, fixtures;

  beforeEach(() => {
    fixtures = lumine.project.getPaths()[0];
    lumineHome = temp.mkdirSync("fake-lumine-home");

    CompileCache.resetCacheStats();

    spyOn(babelCompiler, "compile");
    spyOn(TypeScriptTranspiler, "compile").and.returnValue("the-typescript-code");
  });

  afterEach(() => {
    CompileCache.setLumineHomeDirectory(process.env.LUMINE_HOME);
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
        // The shared `spyOn(babelCompiler, "compile")` returns undefined, and
        // the cache writes whatever it is handed straight to disk. Every other
        // group here stubs a return for that reason.
        babelCompiler.compile.and.returnValue("the-babel-code");

        CompileCache.addPathToCache(path.join(fixtures, "babel", "babel-comment.js"), lumineHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "babel", "babel-comment.js"), lumineHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is typescript", () => {
      it("compiles the file with typescript and caches it", function () {
        CompileCache.addPathToCache(path.join(fixtures, "typescript", "valid.ts"), lumineHome);
        expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 0, misses: 1 });
        expect(TypeScriptTranspiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "typescript", "valid.ts"), lumineHome);
        expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 1, misses: 1 });
        expect(TypeScriptTranspiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is JSX", () => {
      it("compiles the file with babel unconditionally and caches it", function () {
        babelCompiler.compile.and.returnValue("the-jsx-code");
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
