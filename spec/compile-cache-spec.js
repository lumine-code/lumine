/*
 * EDITOR NOTE: Manually added arrow return function syntax to match other tests.
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/main/docs/suggestions.md
 */
const path = require("path");
const temp = require("@lumine-code/temp").track();
const babelCompiler = require("../src/babel");
const TypeScriptTranspiler = require("../src/typescript");
const CompileCache = require("../src/compile-cache");

describe("CompileCache", () => {
  let atomHome, fixtures;

  beforeEach(() => {
    fixtures = atom.project.getPaths()[0];
    atomHome = temp.mkdirSync("fake-atom-home");

    CompileCache.resetCacheStats();

    spyOn(babelCompiler, "compile");
    spyOn(TypeScriptTranspiler, "compile").and.returnValue("the-typescript-code");
  });

  afterEach(() => {
    CompileCache.setAtomHomeDirectory(process.env.LUMINE_HOME);
    try {
      temp.cleanupSync();
    } catch {
      /* ignore cleanup failure */
    }
  });

  describe("addPathToCache(filePath, atomHome)", () => {
    describe("when the given file is plain javascript", () => {
      it("does not compile or cache the file", function () {
        CompileCache.addPathToCache(path.join(fixtures, "sample.js"), atomHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 0, misses: 0 });
      });
    });

    /**
     * TODO: FAILING TEST - This test fails with the following output:
     * TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined
     */
    xdescribe("when the given file uses babel", () => {
      it("compiles the file with babel and caches it", function () {
        CompileCache.addPathToCache(path.join(fixtures, "babel", "babel-comment.js"), atomHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "babel", "babel-comment.js"), atomHome);
        expect(CompileCache.getCacheStats()[".js"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is typescript", () => {
      it("compiles the file with typescript and caches it", function () {
        CompileCache.addPathToCache(path.join(fixtures, "typescript", "valid.ts"), atomHome);
        expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 0, misses: 1 });
        expect(TypeScriptTranspiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "typescript", "valid.ts"), atomHome);
        expect(CompileCache.getCacheStats()[".ts"]).toEqual({ hits: 1, misses: 1 });
        expect(TypeScriptTranspiler.compile.calls.count()).toBe(1);
      });
    });

    describe("when the given file is JSX", () => {
      it("compiles the file with babel unconditionally and caches it", function () {
        babelCompiler.compile.and.returnValue("the-jsx-code");
        CompileCache.addPathToCache(path.join(fixtures, "babel", "default-factory.jsx"), atomHome);
        expect(CompileCache.getCacheStats()[".jsx"]).toEqual({ hits: 0, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);

        CompileCache.addPathToCache(path.join(fixtures, "babel", "default-factory.jsx"), atomHome);
        expect(CompileCache.getCacheStats()[".jsx"]).toEqual({ hits: 1, misses: 1 });
        expect(babelCompiler.compile.calls.count()).toBe(1);
      });
    });
  });

  describe("overriding Error.prepareStackTrace", function () {
    it("removes the override on the next tick, and always assigns the raw stack", async function () {
      jasmine.filterByPlatform({ except: ["win32"] }); // Flakey Error.stack contents on Win32

      Error.prepareStackTrace = () => "a-stack-trace";

      let error = new Error("Oops");
      expect(error.stack).toBe("a-stack-trace");
      expect(Array.isArray(error.getRawStack())).toBe(true);

      await new Promise((resolve) => {
        jasmine.unspy(window, "setTimeout");
        setTimeout(resolve, 1);
      });

      error = new Error("Oops again");
      expect(error.stack).toContain("compile-cache-spec.js");
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
