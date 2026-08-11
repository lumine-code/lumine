const { conditionPromise } = require("./helpers/async-spec-helpers");
const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const LumineEnvironment = require("../src/lumine-environment");
const { timeoutPromise: wait } = require("./helpers/async-spec-helpers");

describe("LumineEnvironment", () => {
  it("is exposed only through the Lumine renderer global", () => {
    expect(global.lumine).toBe(lumine);
    expect(global.atom).toBeUndefined();
  });

  describe("namespaced process APIs", () => {
    it("does not expose the removed top-level API", () => {
      for (const method of [
        "onWillDestroy",
        "onDidBeep",
        "onWillThrowError",
        "onDidThrowError",
        "whenShellEnvironmentLoaded",
        "whenWindowLoaded",
        "inDevMode",
        "inSafeMode",
        "inSpecMode",
        "isFirstLoad",
        "getAppName",
        "getVersion",
        "versionSatisfies",
        "getReleaseChannel",
        "isReleasedVersion",
        "getWindowLoadTime",
        "getStartupMarkers",
        "getLoadSettings",
        "open",
        "trashItem",
        "showItemInFolder",
        "openPath",
        "openExternal",
        "beep",
        "confirm",
        "pickFolder",
        "showSaveDialog",
        "downloadURL",
        "getPrimaryDisplayWorkAreaSize",
        "getCurrentWindow",
        "close",
        "getSize",
        "setSize",
        "getPosition",
        "setPosition",
        "center",
        "focus",
        "show",
        "hide",
        "reload",
        "minimize",
        "maximize",
        "unmaximize",
        "isMaximized",
        "isFullScreen",
        "isVisible",
        "setFullScreen",
        "toggleFullScreen",
        "openDevTools",
        "closeDevTools",
        "toggleDevTools",
        "executeJavaScriptInDevTools",
        "setAutoHideMenuBar",
        "isMenuBarAutoHide",
        "setMenuBarVisibility",
        "restartApplication",
      ]) {
        expect(lumine[method]).toBeUndefined();
      }
    });

    it("exposes cached application and window metadata through typed services", () => {
      const loadSettings = lumine.applicationDelegate.getWindowLoadSettings();
      expect(lumine.application.getName()).toBe(loadSettings.appName);
      expect(lumine.application.getVersion()).toBe(loadSettings.appVersion);
      expect(lumine.application.getResourcePath()).toBe(loadSettings.resourcePath);
      expect(lumine.window.isDevMode()).toBe(Boolean(loadSettings.devMode));
      expect(lumine.window.isSafeMode()).toBe(Boolean(loadSettings.safeMode));
      expect(lumine.window.isSpecMode()).toBe(Boolean(loadSettings.isSpec));
      expect(lumine.window.getInitialPaths()).toEqual(loadSettings.initialPaths || []);
    });

    it("owns beep events on the notification service", () => {
      const callback = jasmine.createSpy();
      const subscription = lumine.notifications.onDidBeep(callback);
      lumine.notifications.beep();
      expect(callback).toHaveBeenCalled();
      subscription.dispose();
    });
  });

  describe("window sizing methods", () => {
    describe("::getPosition and ::setPosition", () => {
      let originalPosition = null;
      beforeEach(async () => (originalPosition = await lumine.window.getPosition()));

      afterEach(() => lumine.window.setPosition(originalPosition.x, originalPosition.y));

      it("sets the position of the window, and can retrieve the position just set", async () => {
        await lumine.window.setPosition(22, 45);
        expect(await lumine.window.getPosition()).toEqual({ x: 22, y: 45 });
      });
    });

    describe("::getSize and ::setSize", () => {
      let originalSize = null;
      beforeEach(async () => (originalSize = await lumine.window.getSize()));

      afterEach(async () => {
        await lumine.window.setSize(originalSize.width, originalSize.height);
      });

      it("sets the size of the window, and can retrieve the size just set", async () => {
        const newWidth = originalSize.width - 12;
        const newHeight = originalSize.height - 23;
        await lumine.window.setSize(newWidth, newHeight);
        expect(await lumine.window.getSize()).toEqual({ width: newWidth, height: newHeight });
      });
    });
  });

  describe(".isReleasedVersion()", () => {
    it("returns false if the version is a SHA and true otherwise", () => {
      let version = "0.1.0";
      spyOn(lumine.application, "getVersion").and.callFake(() => version);
      expect(lumine.application.isReleasedVersion()).toBe(true);
      version = "36b5518";
      expect(lumine.application.isReleasedVersion()).toBe(false);
    });

    it("counts every channel that went through the release pipeline", () => {
      let version = "1.1.0";
      spyOn(lumine.application, "getVersion").and.callFake(() => version);
      for (version of ["1.1.0", "1.1.0-beta.1", "1.1.0-rc.1", "1.1.0-nightly1"]) {
        expect(lumine.application.isReleasedVersion()).toBe(true);
      }
      version = "1.1.0-dev";
      expect(lumine.application.isReleasedVersion()).toBe(false);
    });
  });

  describe(".versionSatisfies()", () => {
    it("returns appropriately for provided range", () => {
      let testLumineVersion = "0.1.0";
      spyOn(lumine.application, "getVersion").and.callFake(() => testLumineVersion);
      expect(lumine.application.versionSatisfies(">0.2.0")).toBe(false);
      expect(lumine.application.versionSatisfies(">=0.x.x <=2.x.x")).toBe(true);
      expect(lumine.application.versionSatisfies("^0.1.x")).toBe(true);
    });

    // Every package declares an `engines.lumine` range, so a prerelease build
    // rejecting its own version line would report the whole fleet incompatible.
    it("measures a prerelease build against the release it precedes", () => {
      spyOn(lumine.application, "getVersion").and.returnValue("1.1.0-rc.1");
      expect(lumine.application.versionSatisfies("^1.0.0")).toBe(true);
      expect(lumine.application.versionSatisfies("^1.1.0")).toBe(true);
      expect(lumine.application.versionSatisfies("^1.2.0")).toBe(false);
    });
  });

  describe("loading default config", () => {
    it("loads the default core config schema", () => {
      expect(lumine.config.get("core.excludeVcsIgnoredPaths")).toBe(true);
      expect(lumine.config.get("core.followSymlinks")).toBe(true);
      expect(lumine.config.get("language.showInvisibles")).toBe(false);
    });
  });

  describe("the repository platform", () => {
    it("installs Git as the default operation provider", () => {
      expect(lumine.repositories.getWorkspaceOperationCapabilities()).toEqual([
        "initialize",
        "clone",
      ]);
    });
  });

  describe("the icon registry", () => {
    it("resolves every vocabulary from the built-in providers", () => {
      expect(lumine.icons.iconFor({ path: "/a/b.png" }).classes).toEqual(["icon-file-media"]);
      expect(lumine.icons.iconFor({ name: "gear" }).classes).toEqual(["icon-gear"]);
      expect(lumine.icons.iconFor({ kind: "class" }).classes).toEqual(["icon-puzzle"]);
    });
  });

  describe("uncaught error handlers", () => {
    let devToolsPromise = null;
    beforeEach(() => {
      devToolsPromise = Promise.resolve();
      spyOn(lumine.window, "openDevTools").and.returnValue(devToolsPromise);
      spyOn(lumine.window, "executeJavaScriptInDevTools");
    });

    it("will open the dev tools when an error is triggered", async () => {
      try {
        a + 1; // eslint-disable-line no-undef
      } catch (e) {
        window.onerror(e.toString(), "abc", 2, 3, e);
      }

      await devToolsPromise;
      expect(lumine.window.openDevTools).toHaveBeenCalled();
      expect(lumine.window.executeJavaScriptInDevTools).toHaveBeenCalled();
    });

    describe("::onWillThrowError", () => {
      let willThrowSpy = null;
      // These outlive their spec otherwise, and one of them calls
      // preventDefault() — every later spec would find the dev tools suppressed.
      let subscription = null;

      beforeEach(() => {
        willThrowSpy = jasmine.createSpy();
      });

      afterEach(() => subscription?.dispose());

      it("is called when there is an error", () => {
        let error = null;
        subscription = lumine.runtime.onWillThrowError(willThrowSpy);
        try {
          a + 1; // eslint-disable-line no-undef
        } catch (e) {
          error = e;
          window.onerror(e.toString(), "abc", 2, 3, e);
        }

        delete willThrowSpy.calls.mostRecent().args[0].preventDefault;
        expect(willThrowSpy).toHaveBeenCalledWith({
          message: error.toString(),
          url: "abc",
          line: 2,
          column: 3,
          originalError: error,
        });
      });

      // Chromium hands over no error object at all for one it could not
      // marshal, and every handler downstream — the notifications package
      // first — reads `originalError` without asking.
      it("stands an Error in when the browser reports none", () => {
        subscription = lumine.runtime.onWillThrowError(willThrowSpy);
        expect(() => window.onerror("Uncaught Error: nope", "abc", 2, 3, null)).not.toThrow();

        const { originalError } = willThrowSpy.calls.mostRecent().args[0];
        expect(originalError instanceof Error).toBe(true);
        expect(originalError.message).toBe("Uncaught Error: nope");
        // Reporting this file's own stack would read as a fault in core.
        expect(originalError.stack).toBeUndefined();
      });

      it("passes on a thrown non-Error untouched", () => {
        subscription = lumine.runtime.onWillThrowError(willThrowSpy);
        const thrown = { name: "BufferedProcessError" };
        window.onerror("Uncaught BufferedProcessError: nope", "abc", 2, 3, thrown);

        expect(willThrowSpy.calls.mostRecent().args[0].originalError).toBe(thrown);
      });

      it("will not show the devtools when preventDefault() is called", () => {
        willThrowSpy.and.callFake((errorObject) => errorObject.preventDefault());
        subscription = lumine.runtime.onWillThrowError(willThrowSpy);

        try {
          a + 1; // eslint-disable-line no-undef
        } catch (e) {
          window.onerror(e.toString(), "abc", 2, 3, e);
        }

        expect(willThrowSpy).toHaveBeenCalled();
        expect(lumine.window.openDevTools).not.toHaveBeenCalled();
        expect(lumine.window.executeJavaScriptInDevTools).not.toHaveBeenCalled();
      });
    });

    describe("::onDidThrowError", () => {
      let didThrowSpy = null;
      let subscription = null;
      beforeEach(() => (didThrowSpy = jasmine.createSpy()));
      afterEach(() => subscription?.dispose());

      it("is called when there is an error", () => {
        let error = null;
        subscription = lumine.runtime.onDidThrowError(didThrowSpy);
        try {
          a + 1; // eslint-disable-line no-undef
        } catch (e) {
          error = e;
          window.onerror(e.toString(), "abc", 2, 3, e);
        }
        expect(didThrowSpy).toHaveBeenCalledWith({
          message: error.toString(),
          url: "abc",
          line: 2,
          column: 3,
          originalError: error,
        });
      });
    });

    // A rejected promise carries no position of its own, so the report has to
    // be reconstructed from its stack.
    describe("unhandled promise rejections", () => {
      let willThrowSpy = null;
      let subscription = null;

      beforeEach(() => {
        willThrowSpy = jasmine.createSpy();
        subscription = lumine.runtime.onWillThrowError(willThrowSpy);
      });

      afterEach(() => subscription.dispose());

      const reject = (reason) => window.onunhandledrejection({ reason });

      it("reports one the same way as a thrown error", () => {
        const error = new Error("write EPIPE");
        error.stack = "Error: write EPIPE\n    at doWrite (C:\\app\\src\\writer.js:596:12)";
        reject(error);

        const event = willThrowSpy.calls.mostRecent().args[0];
        expect(event.message).toBe("Uncaught (in promise) Error: write EPIPE");
        expect(event.originalError).toBe(error);
        expect(event.url).toBe("C:\\app\\src\\writer.js");
        expect(event.line).toBe(596);
        expect(event.column).toBe(12);
      });

      it("reads the frame of a stack whose first line is bare", () => {
        const error = new Error("nope");
        error.stack = "Error: nope\n    at /app/lib/thing.js:12:5";
        reject(error);

        const event = willThrowSpy.calls.mostRecent().args[0];
        expect(event.url).toBe("/app/lib/thing.js");
        expect(event.line).toBe(12);
      });

      it("wraps a rejection that carries no Error, and blames no file for it", () => {
        reject("just a string");

        const event = willThrowSpy.calls.mostRecent().args[0];
        expect(event.message).toBe(
          "Uncaught (in promise) Error: Promise rejected with 'just a string'",
        );
        // Reporting this file's own stack would read as a fault in core.
        expect(event.originalError.stack).toBeUndefined();
        expect(event.url).toBeUndefined();
        expect(event.line).toBeUndefined();
      });

      it("survives a rejection with no reason at all", () => {
        expect(() => reject(undefined)).not.toThrow();
        expect(willThrowSpy.calls.mostRecent().args[0].message).toContain("undefined");
      });

      // The reporter opens the dev tools through a promise. Left unhandled,
      // that promise's own rejection arrives back here and opens them again.
      it("does not feed itself when opening the dev tools fails", async () => {
        // The loop this guards runs on the event loop, not on microtasks.
        jasmine.useRealClock();
        lumine.window.openDevTools.and.returnValue(Promise.reject(new Error("no dev tools")));
        reject(new Error("first"));
        await wait(100);
        expect(lumine.window.openDevTools.calls.count()).toBe(1);
      });

      it("opens the dev tools unless a handler prevents it", () => {
        reject(new Error("shown"));
        expect(lumine.window.openDevTools).toHaveBeenCalled();

        lumine.window.openDevTools.calls.reset();
        willThrowSpy.and.callFake((event) => event.preventDefault());
        reject(new Error("hidden"));
        expect(lumine.window.openDevTools).not.toHaveBeenCalled();
      });
    });
  });

  describe(".assert(condition, message, callback)", () => {
    let errors = null;

    beforeEach(() => {
      errors = [];
      // Stand in for a build a user is running: neither dev mode nor the spec
      // runner, so a failed assertion reports instead of throwing.
      spyOn(lumine.window, "isDevMode").and.returnValue(false);
      spyOn(lumine.window, "isSpecMode").and.returnValue(false);
      lumine.onDidFailAssertion((error) => errors.push(error));
    });

    describe("if the condition is false", () => {
      it("notifies onDidFailAssertion handlers with an error object based on the call site of the assertion", () => {
        const result = lumine.assert(false, "a == b");
        expect(result).toBe(false);
        expect(errors.length).toBe(1);
        expect(errors[0].message).toBe("Assertion failed: a == b");
        expect(errors[0].stack).toContain("lumine-environment-spec");
      });

      describe("if passed a callback function", () => {
        it("calls the callback with the assertion failure's error object", () => {
          let error = null;
          lumine.assert(false, "a == b", (e) => (error = e));
          expect(error).toBe(errors[0]);
        });
      });

      describe("if passed metadata", () => {
        it("assigns the metadata on the assertion failure's error object", () => {
          lumine.assert(false, "a == b", { foo: "bar" });
          expect(errors[0].metadata).toEqual({ foo: "bar" });
        });
      });

      // Whether a broken invariant is fatal depends on who is at the keyboard,
      // never on the version string: a release carrying no prerelease suffix
      // must not silence assertions for the person developing against it.
      describe("when running in dev mode", () => {
        it("throws an error", () => {
          lumine.window.isDevMode.and.returnValue(true);
          expect(() => lumine.assert(false, "testing")).toThrowError("Assertion failed: testing");
        });
      });

      describe("when running under the spec runner", () => {
        it("throws an error", () => {
          lumine.window.isSpecMode.and.returnValue(true);
          expect(() => lumine.assert(false, "testing")).toThrowError("Assertion failed: testing");
        });
      });
    });

    describe("if the condition is true", () => {
      it("does nothing", () => {
        const result = lumine.assert(true, "a == b");
        expect(result).toBe(true);
        expect(errors).toEqual([]);
      });
    });
  });

  describe("saving and loading", () => {
    beforeEach(() => {
      jasmine.useRealClock();
      lumine.enablePersistence = true;
    });

    afterEach(() => {
      lumine.enablePersistence = false;
    });

    it("selects the state based on the current project paths", async () => {
      jasmine.useRealClock();

      const [dir1, dir2] = [temp.mkdirSync("dir1-"), temp.mkdirSync("dir2-")];

      const loadSettings = Object.assign(lumine.applicationDelegate.getWindowLoadSettings(), {
        initialProjectRoots: [dir1],
        windowState: null,
      });

      spyOn(lumine.applicationDelegate, "getWindowLoadSettings").and.callFake(() => loadSettings);
      spyOn(lumine, "serialize").and.returnValue({ stuff: "cool" });

      lumine.project.setPaths([dir1, dir2]);

      // State persistence will fail if other Lumine instances are running
      expect(await lumine.stateStore.connect()).toBe(true);

      await lumine.saveState();
      expect(await lumine.loadState()).toBeFalsy();

      loadSettings.initialProjectRoots = [dir2, dir1];
      expect(await lumine.loadState()).toEqual({ stuff: "cool" });
    });

    it("saves state when the CPU is idle after a keydown or mousedown event", async () => {
      jasmine.useRealClock();
      const lumineEnv = new LumineEnvironment({
        applicationDelegate: global.lumine.applicationDelegate,
      });
      const idleCallbacks = [];
      lumineEnv.initialize({
        window: {
          requestIdleCallback(callback) {
            idleCallbacks.push(callback);
          },
          addEventListener() {},
          removeEventListener() {},
        },
        document: document.implementation.createHTMLDocument(),
      });

      spyOn(lumineEnv, "saveState");

      const keydown = new KeyboardEvent("keydown");
      lumineEnv.document.dispatchEvent(keydown);
      await wait(lumineEnv.saveStateDebounceInterval);
      idleCallbacks.shift()?.();
      expect(lumineEnv.saveState).toHaveBeenCalledWith({ isUnloading: false });
      expect(lumineEnv.saveState).not.toHaveBeenCalledWith({ isUnloading: true });

      lumineEnv.saveState.calls.reset();
      const mousedown = new MouseEvent("mousedown");
      lumineEnv.document.dispatchEvent(mousedown);
      await wait(lumineEnv.saveStateDebounceInterval);
      idleCallbacks.shift()?.();
      expect(lumineEnv.saveState).toHaveBeenCalledWith({ isUnloading: false });
      expect(lumineEnv.saveState).not.toHaveBeenCalledWith({ isUnloading: true });

      lumineEnv.destroy();
    });

    it("ignores mousedown/keydown events happening after calling prepareToUnloadEditorWindow", async () => {
      const lumineEnv = new LumineEnvironment({
        applicationDelegate: global.lumine.applicationDelegate,
      });
      const idleCallbacks = [];
      lumineEnv.initialize({
        window: {
          requestIdleCallback(callback) {
            idleCallbacks.push(callback);
          },
          addEventListener() {},
          removeEventListener() {},
        },
        document: document.implementation.createHTMLDocument(),
      });

      spyOn(lumineEnv, "saveState");

      let mousedown = new MouseEvent("mousedown");
      lumineEnv.document.dispatchEvent(mousedown);
      expect(lumineEnv.saveState).not.toHaveBeenCalled();
      await lumineEnv.prepareToUnloadEditorWindow();
      expect(lumineEnv.saveState).toHaveBeenCalledWith({ isUnloading: true });

      await wait(lumineEnv.saveStateDebounceInterval);
      idleCallbacks.shift()();
      expect(lumineEnv.saveState.calls.count()).toBe(1);

      mousedown = new MouseEvent("mousedown");
      lumineEnv.document.dispatchEvent(mousedown);
      await wait(lumineEnv.saveStateDebounceInterval);
      idleCallbacks.shift()();
      expect(lumineEnv.saveState.calls.count()).toBe(1);

      lumineEnv.destroy();
    });

    // Every orderly unload deactivates, reload included — that is what lets a
    // package tear down while the workspace it reaches for is still there. The
    // wait is bounded so that a package which never finishes cannot hold the
    // window open, which is what skipping deactivation used to buy.
    it("bounds package deactivation when preparing to unload", async () => {
      const lumineEnv = new LumineEnvironment({
        applicationDelegate: global.lumine.applicationDelegate,
      });
      lumineEnv.initialize({
        window: {
          requestIdleCallback() {},
          addEventListener() {},
          removeEventListener() {},
        },
        document: document.implementation.createHTMLDocument(),
      });

      spyOn(lumineEnv, "saveState");
      spyOn(lumineEnv.packages, "deactivatePackages").and.returnValue(Promise.resolve());

      const shouldUnload = await lumineEnv.prepareToUnloadEditorWindow();

      expect(shouldUnload).toBe(true);
      expect(lumineEnv.saveState).toHaveBeenCalledWith({ isUnloading: true });
      expect(lumineEnv.packages.deactivatePackages).toHaveBeenCalled();
      const [{ timeout }] = lumineEnv.packages.deactivatePackages.calls.argsFor(0);
      expect(typeof timeout).toBe("number");
      expect(timeout).toBeGreaterThan(0);

      lumineEnv.destroy();
    });

    it("serializes the project state with all the options supplied in saveState", async () => {
      spyOn(lumine.project, "serialize").and.returnValue({ foo: 42 });

      await lumine.saveState({ anyOption: "any option" });
      expect(lumine.project.serialize.calls.count()).toBe(1);
      expect(lumine.project.serialize.calls.mostRecent().args[0]).toEqual({
        anyOption: "any option",
      });
    });

    it("serializes the text editor registry", async () => {
      await lumine.packages.activatePackage("language-text");
      const editor = await lumine.workspace.open("sample.js");
      expect(lumine.grammars.assignLanguageMode(editor, "text.plain")).toBe(true);

      const lumine2 = new LumineEnvironment({
        applicationDelegate: lumine.applicationDelegate,
        window: document.createElement("div"),
        document: Object.assign(document.createElement("div"), {
          body: document.createElement("div"),
          head: document.createElement("div"),
        }),
      });
      lumine2.initialize({ document, window });

      await lumine2.deserialize(lumine.serialize());
      await lumine2.packages.activatePackage("language-text");
      const editor2 = lumine2.workspace.getActiveTextEditor();
      expect(editor2.getBuffer().getLanguageMode().getLanguageId()).toBe("text.plain");
      lumine2.destroy();
    });

    describe("deserialization failures", () => {
      it("propagates unrecognized project state restoration failures", async () => {
        let err;
        spyOn(lumine.project, "deserialize").and.callFake(() => {
          err = new Error("deserialization failure");
          return Promise.reject(err);
        });
        spyOn(lumine.notifications, "addError");

        await lumine.deserialize({ project: "should work" });
        expect(lumine.notifications.addError).toHaveBeenCalledWith(
          "Unable to deserialize project",
          {
            description: "deserialization failure",
            stack: err.stack,
          },
        );
      });

      it("disregards missing project folder errors", async () => {
        spyOn(lumine.project, "deserialize").and.callFake(() => {
          const err = new Error("deserialization failure");
          err.missingProjectPaths = ["nah"];
          return Promise.reject(err);
        });
        spyOn(lumine.notifications, "addError");

        await lumine.deserialize({ project: "should work" });
        expect(lumine.notifications.addError).not.toHaveBeenCalled();
      });
    });
  });

  describe("openInitialEmptyEditorIfNecessary", () => {
    describe("when there are no paths set", () => {
      beforeEach(() => {
        const loadSettings = {
          ...lumine.applicationDelegate.getWindowLoadSettings(),
          hasOpenFiles: false,
        };
        spyOn(lumine.applicationDelegate, "getWindowLoadSettings").and.returnValue(loadSettings);
      });

      it("opens an empty buffer", () => {
        spyOn(lumine.workspace, "open");
        lumine.openInitialEmptyEditorIfNecessary();
        expect(lumine.workspace.open).toHaveBeenCalledWith(null, {
          pending: true,
        });
      });

      it("does not open an empty buffer when a buffer is already open", async () => {
        await lumine.workspace.open();
        spyOn(lumine.workspace, "open");
        lumine.openInitialEmptyEditorIfNecessary();
        expect(lumine.workspace.open).not.toHaveBeenCalled();
      });

      it("does not open an empty buffer when core.openEmptyEditorOnStart is false", () => {
        lumine.config.set("core.openEmptyEditorOnStart", false);
        spyOn(lumine.workspace, "open");
        lumine.openInitialEmptyEditorIfNecessary();
        expect(lumine.workspace.open).not.toHaveBeenCalled();
      });
    });

    describe("when the project has a path", () => {
      beforeEach(() => {
        const loadSettings = {
          ...lumine.applicationDelegate.getWindowLoadSettings(),
          hasOpenFiles: true,
        };
        spyOn(lumine.applicationDelegate, "getWindowLoadSettings").and.returnValue(loadSettings);
        spyOn(lumine.workspace, "open");
      });

      it("does not open an empty buffer", () => {
        lumine.openInitialEmptyEditorIfNecessary();
        expect(lumine.workspace.open).not.toHaveBeenCalled();
      });
    });
  });

  describe("adding a project folder", () => {
    it("does nothing if the user dismisses the file picker", async () => {
      const projectRoots = lumine.project.getPaths();
      spyOn(lumine.window, "pickFolder").and.returnValue(Promise.resolve(null));
      await lumine.addProjectFolder();
      expect(lumine.project.getPaths()).toEqual(projectRoots);
    });

    describe("when there is no saved state for the added folders", () => {
      beforeEach(() => {
        spyOn(lumine, "loadState").and.returnValue(Promise.resolve(null));
        spyOn(lumine, "attemptRestoreProjectStateForPaths");
      });

      it("adds the selected folder to the project", async () => {
        lumine.project.setPaths([]);
        const tempDirectory = temp.mkdirSync("a-new-directory");
        spyOn(lumine.window, "pickFolder").and.returnValue(Promise.resolve([tempDirectory]));
        await lumine.addProjectFolder();
        expect(lumine.project.getPaths()).toEqual([tempDirectory]);
        expect(lumine.attemptRestoreProjectStateForPaths).not.toHaveBeenCalled();
      });
    });

    describe("when there is saved state for the relevant directories", () => {
      const state = Symbol("savedState");

      beforeEach(() => {
        spyOn(lumine, "getStateKey").and.callFake((dirs) => dirs.join(":"));
        spyOn(lumine, "loadState").and.callFake((key) => (key === __dirname ? state : null));
        spyOn(lumine, "attemptRestoreProjectStateForPaths");
        spyOn(lumine.window, "pickFolder").and.returnValue(Promise.resolve([__dirname]));
        lumine.project.setPaths([]);
      });

      describe("when there are no project folders", () => {
        it("attempts to restore the project state", async () => {
          await lumine.addProjectFolder();
          expect(lumine.attemptRestoreProjectStateForPaths).toHaveBeenCalledWith(state, [
            __dirname,
          ]);
          expect(lumine.project.getPaths()).toEqual([]);
        });
      });

      describe("when there are already project folders", () => {
        const openedPath = path.join(__dirname, "fixtures");

        beforeEach(() => lumine.project.setPaths([openedPath]));

        it("does not attempt to restore the project state, instead adding the project paths", async () => {
          await lumine.addProjectFolder();
          expect(lumine.attemptRestoreProjectStateForPaths).not.toHaveBeenCalled();
          expect(lumine.project.getPaths()).toEqual([openedPath, __dirname]);
        });
      });
    });
  });

  describe("attemptRestoreProjectStateForPaths(state, projectPaths, filesToOpen)", () => {
    describe("when the window is clean (empty or has only unnamed, unmodified buffers)", () => {
      beforeEach(async () => {
        // Unnamed, unmodified buffer doesn't count toward "clean"-ness
        await lumine.workspace.open();
      });

      it("automatically restores the saved state into the current environment", async () => {
        const projectPath = temp.mkdirSync();
        const filePath1 = path.join(projectPath, "file-1");
        const filePath2 = path.join(projectPath, "file-2");
        const filePath3 = path.join(projectPath, "file-3");
        fs.writeFileSync(filePath1, "abc");
        fs.writeFileSync(filePath2, "def");
        fs.writeFileSync(filePath3, "ghi");

        const env1 = new LumineEnvironment({
          applicationDelegate: lumine.applicationDelegate,
        });
        env1.project.setPaths([projectPath]);
        await env1.workspace.open(filePath1);
        await env1.workspace.open(filePath2);
        await env1.workspace.open(filePath3);
        const env1State = env1.serialize();
        env1.destroy();

        const env2 = new LumineEnvironment({
          applicationDelegate: lumine.applicationDelegate,
        });
        await env2.attemptRestoreProjectStateForPaths(env1State, [projectPath], [filePath2]);
        const restoredURIs = env2.workspace.getPaneItems().map((p) => p.getURI());
        expect(restoredURIs).toEqual([filePath1, filePath2, filePath3]);
        env2.destroy();
      });

      it("keeps persistent items open when restoring the saved state into the current environment", async () => {
        const projectPath = temp.mkdirSync();

        const env1 = new LumineEnvironment({
          applicationDelegate: lumine.applicationDelegate,
        });
        env1.project.setPaths([projectPath]);
        const env1State = env1.serialize();
        env1.destroy();

        const env2 = new LumineEnvironment({
          applicationDelegate: lumine.applicationDelegate,
        });
        const persistentItem = {
          element: document.createElement("div"),
          getTitle: () => "Persistent Item",
          getURI: () => "lumine://persistent-item",
          getDefaultLocation: () => "left",
          isPersistentDockItem: () => true,
        };
        await env2.workspace.open(persistentItem, { activatePane: false });
        env2.workspace.getLeftDock().show();

        await env2.attemptRestoreProjectStateForPaths(env1State, [projectPath]);

        expect(env2.workspace.paneForURI("lumine://persistent-item")).toBeTruthy();
        expect(env2.workspace.getLeftDock().isVisible()).toBe(true);
        env2.destroy();
      });

      describe("when a dock has a non-text editor", () => {
        it("doesn't prompt the user to restore state", async () => {
          const dock = lumine.workspace.getLeftDock();
          dock.getActivePane().addItem({
            getTitle() {
              return "title";
            },
            element: document.createElement("div"),
          });
          const state = {};
          spyOn(lumine.window, "confirm");
          await lumine.attemptRestoreProjectStateForPaths(state, [__dirname], [__filename]);
          expect(lumine.window.confirm).not.toHaveBeenCalled();
        });
      });
    });

    describe("when the window is dirty", () => {
      let editor;

      beforeEach(async () => {
        editor = await lumine.workspace.open();
        editor.setText("new editor");
      });

      describe("when a dock has a modified editor", () => {
        it("prompts the user to restore the state", async () => {
          const dock = lumine.workspace.getLeftDock();
          dock.getActivePane().addItem(editor);
          spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(1));
          spyOn(lumine.project, "addPath");
          spyOn(lumine.workspace, "open");
          const state = Symbol("state");
          await lumine.attemptRestoreProjectStateForPaths(state, [__dirname], [__filename]);
          expect(lumine.window.confirm).toHaveBeenCalled();
        });
      });

      it("prompts the user to restore the state in a new window, discarding it and adding folder to current window", async () => {
        jasmine.useRealClock();
        spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(1));
        spyOn(lumine.project, "addPaths");
        spyOn(lumine.workspace, "open");
        const state = Symbol("state");

        await lumine.attemptRestoreProjectStateForPaths(state, [__dirname], [__filename]);
        expect(lumine.window.confirm).toHaveBeenCalled();
        await conditionPromise(() => lumine.project.addPaths.calls.count() === 1);

        expect(lumine.project.addPaths).toHaveBeenCalledWith([__dirname]);
        expect(lumine.workspace.open.calls.count()).toBe(1);
        expect(lumine.workspace.open).toHaveBeenCalledWith(__filename);
      });

      it("prompts the user to restore the state in a new window, opening a new window", async () => {
        jasmine.useRealClock();
        spyOn(lumine.window, "confirm").and.returnValue(Promise.resolve(0));
        spyOn(lumine.application, "openWindow");
        const state = Symbol("state");

        await lumine.attemptRestoreProjectStateForPaths(state, [__dirname], [__filename]);
        expect(lumine.window.confirm).toHaveBeenCalled();
        await conditionPromise(() => lumine.application.openWindow.calls.count() === 1);
        expect(lumine.application.openWindow).toHaveBeenCalledWith({
          pathsToOpen: [__dirname, __filename],
          newWindow: true,
          devMode: lumine.window.isDevMode(),
          safeMode: lumine.window.isSafeMode(),
        });
      });
    });
  });

  describe("project.setState(projectPaths)", () => {
    let env, dirA, dirB, fileA, fileB;

    // A window of its own, so setting project state can tear down a whole
    // workspace without taking the spec runner's `lumine` with it. Persistence is
    // on and the state store points at the spec home, because this is nothing
    // but a state store round trip.
    const buildEnvironment = () => {
      const built = new LumineEnvironment({
        applicationDelegate: lumine.applicationDelegate,
        enablePersistence: true,
      });
      const configDirPath = lumine.getConfigDirPath();
      built.stateStore.initialize({ configDirPath });
      // The workspace keeps a store of its own for remembered item locations,
      // which ::open consults whenever persistence is on.
      built.workspace.initialize({ configDirPath });
      return built;
    };

    const openPaths = (environment) =>
      environment.workspace.getTextEditors().map((editor) => editor.getPath());

    beforeEach(async () => {
      jasmine.useRealClock();

      // `temp` hands back a path that may be shortened or symlinked; the
      // project resolves what it is given, so settle both sides on the real one
      // up front.
      dirA = fs.realpathSync.native(temp.mkdirSync("state-a-"));
      dirB = fs.realpathSync.native(temp.mkdirSync("state-b-"));
      fileA = path.join(dirA, "a.txt");
      fileB = path.join(dirB, "b.txt");
      fs.writeFileSync(fileA, "aaa");
      fs.writeFileSync(fileB, "bbb");

      env = buildEnvironment();
      // State persistence will fail if other Lumine instances are running
      expect(await env.stateStore.connect()).toBe(true);
      // Off by default here so an untitled editor does not stand in the way of
      // asserting what was restored; the spec below turns it back on.
      env.config.set("core.openEmptyEditorOnStart", false);
      env.project.setPaths([dirA]);
    });

    afterEach(() => {
      env.stateStore.close();
      env.destroy();
    });

    it("saves the state of the outgoing project and restores the incoming one's", async () => {
      await env.workspace.open(fileA);

      expect(await env.project.setState([dirB])).toBe(true);
      expect(env.project.getPaths()).toEqual([dirB]);
      expect(openPaths(env)).toEqual([]);

      await env.workspace.open(fileB);

      expect(await env.project.setState([dirA])).toBe(true);
      expect(env.project.getPaths()).toEqual([dirA]);
      expect(openPaths(env)).toEqual([fileA]);

      expect(await env.project.setState([dirB])).toBe(true);
      expect(openPaths(env)).toEqual([fileB]);
    });

    it("carries unsaved changes across and back", async () => {
      const editor = await env.workspace.open(fileA);
      editor.setText("edited but never saved");

      expect(await env.project.setState([dirB])).toBe(true);
      expect(await env.project.setState([dirA])).toBe(true);

      expect(openPaths(env)).toEqual([fileA]);
      expect(env.workspace.getActiveTextEditor().getText()).toBe("edited but never saved");
      expect(env.workspace.getActiveTextEditor().isModified()).toBe(true);
    });

    it("starts clean when the incoming project has no saved state", async () => {
      await env.workspace.open(fileA);

      expect(await env.project.setState([dirB])).toBe(true);
      expect(env.project.getPaths()).toEqual([dirB]);
      expect(env.workspace.getCenter().getPaneItems()).toEqual([]);
    });

    it("opens an empty editor for a project with no saved state when configured to", async () => {
      env.config.set("core.openEmptyEditorOnStart", true);
      await env.workspace.open(fileA);

      expect(await env.project.setState([dirB])).toBe(true);
      expect(openPaths(env)).toEqual([undefined]);
    });

    it("destroys the outgoing project's buffers", async () => {
      await env.workspace.open(fileA);
      const buffer = env.project.getBuffers()[0];

      expect(await env.project.setState([dirB])).toBe(true);

      expect(buffer.isDestroyed()).toBe(true);
      expect(env.project.getBuffers()).toEqual([]);
    });

    // The docks belong to the window, not to the project: a tree view, a
    // terminal or a panel must keep running across a project change.
    it("leaves the docks alone", async () => {
      const dockItem = {
        element: document.createElement("div"),
        getTitle: () => "Dock Item",
        getURI: () => "lumine://dock-item",
        getDefaultLocation: () => "bottom",
      };
      await env.workspace.open(dockItem, { activatePane: false });
      env.workspace.getBottomDock().show();
      await env.workspace.open(fileA);

      expect(await env.project.setState([dirB])).toBe(true);

      expect(env.workspace.paneForURI("lumine://dock-item")).toBe(
        env.workspace.getBottomDock().getActivePane(),
      );
      expect(env.workspace.getBottomDock().isVisible()).toBe(true);
      expect(env.workspace.getCenter().getPaneItems()).toEqual([]);
    });

    it("does nothing when the paths are already open", async () => {
      await env.workspace.open(fileA);

      expect(await env.project.setState([dirA])).toBe(false);
      expect(env.project.getPaths()).toEqual([dirA]);
      expect(openPaths(env)).toEqual([fileA]);
    });

    it("does nothing when given no paths", async () => {
      await env.workspace.open(fileA);

      expect(await env.project.setState([])).toBe(false);
      expect(env.project.getPaths()).toEqual([dirA]);
      expect(openPaths(env)).toEqual([fileA]);
    });

    it("leaves the window alone when the user cancels at the save prompt", async () => {
      await env.workspace.open(fileA);
      spyOn(env.workspace, "confirmClose").and.returnValue(Promise.resolve(false));

      expect(await env.project.setState([dirB])).toBe(false);
      expect(env.project.getPaths()).toEqual([dirA]);
      expect(openPaths(env)).toEqual([fileA]);
    });
  });

  describe("::unloadEditorWindow()", () => {
    it("saves the BlobStore so it can be loaded after reload", () => {
      const configDirPath = temp.mkdirSync("lumine-spec-environment");
      const fakeBlobStore = jasmine.createSpyObj("blob store", ["save"]);
      const lumineEnvironment = new LumineEnvironment({
        applicationDelegate: lumine.applicationDelegate,
        enablePersistence: true,
      });
      lumineEnvironment.initialize({
        configDirPath,
        blobStore: fakeBlobStore,
        window,
        document,
      });

      lumineEnvironment.unloadEditorWindow();

      expect(fakeBlobStore.save).toHaveBeenCalled();

      lumineEnvironment.destroy();
    });
  });

  describe("::destroy()", () => {
    it("does not throw exceptions when unsubscribing from ipc events (regression)", async () => {
      jasmine.useRealClock();
      const fakeDocument = {
        addEventListener() {},
        removeEventListener() {},
        head: document.createElement("head"),
        body: document.createElement("body"),
      };
      const lumineEnvironment = new LumineEnvironment({
        applicationDelegate: lumine.applicationDelegate,
      });
      lumineEnvironment.initialize({ window, document: fakeDocument });
      spyOn(lumineEnvironment.packages, "loadPackages").and.returnValue(Promise.resolve());
      spyOn(lumineEnvironment.packages, "activate").and.returnValue(Promise.resolve());
      spyOn(lumineEnvironment, "displayWindow").and.returnValue(Promise.resolve());
      await lumineEnvironment.startEditorWindow();
      lumineEnvironment.unloadEditorWindow();
      lumineEnvironment.destroy();
    });
  });

  describe("RuntimeService::whenShellEnvironmentLoaded()", () => {
    let lumineEnvironment, envLoaded;

    beforeEach(() => {
      let resolvePromise = null;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      envLoaded = () => {
        resolvePromise();
        return promise;
      };
      lumineEnvironment = new LumineEnvironment({
        applicationDelegate: lumine.applicationDelegate,
        updateProcessEnv() {
          return promise;
        },
      });
      lumineEnvironment.initialize({ window, document });
    });

    afterEach(() => lumineEnvironment.destroy());

    it("is triggered once the shell environment is loaded", async () => {
      const loaded = lumineEnvironment.runtime.whenShellEnvironmentLoaded();
      lumineEnvironment.updateProcessEnvAndTriggerHooks();
      await envLoaded();
      await loaded;
    });

    it("resolves immediately if the shell environment is already loaded", async () => {
      lumineEnvironment.updateProcessEnvAndTriggerHooks();
      await envLoaded();
      await lumineEnvironment.runtime.whenShellEnvironmentLoaded();
    });
  });

  describe("WindowService::whenLoaded()", () => {
    let lumineEnvironment;

    beforeEach(() => {
      lumineEnvironment = new LumineEnvironment({
        applicationDelegate: lumine.applicationDelegate,
      });
      lumineEnvironment.initialize({ window, document });
    });

    afterEach(() => lumineEnvironment.destroy());

    it("resolves once the window load time is recorded", async () => {
      const loaded = lumineEnvironment.window.whenLoaded();
      lumineEnvironment.setWindowLoadTime(42);
      expect(await loaded).toBe(42);
      expect(lumineEnvironment.window.getLoadTime()).toBe(42);
    });

    it("resolves immediately if the window has already loaded", async () => {
      lumineEnvironment.setWindowLoadTime(42);
      expect(await lumineEnvironment.window.whenLoaded()).toBe(42);
    });
  });

  describe("::openLocations(locations)", () => {
    beforeEach(() => {
      lumine.project.setPaths([]);
    });

    describe("when there is no saved state", () => {
      beforeEach(() => {
        spyOn(lumine, "loadState").and.returnValue(Promise.resolve(null));
      });

      describe("when the opened path exists", () => {
        it("opens a file", async () => {
          const pathToOpen = __filename;
          await lumine.openLocations([{ pathToOpen, exists: true, isFile: true }]);
          expect(lumine.project.getPaths()).toEqual([]);
        });

        it("opens a directory as a project folder", async () => {
          const pathToOpen = __dirname;
          await lumine.openLocations([{ pathToOpen, exists: true, isDirectory: true }]);
          expect(lumine.workspace.getTextEditors().map((e) => e.getPath())).toEqual([]);
          expect(lumine.project.getPaths()).toEqual([pathToOpen]);
        });
      });

      describe("when the opened path does not exist", () => {
        it("opens it as a new file", async () => {
          const pathToOpen = path.join(__dirname, "this-path-does-not-exist.txt");
          await lumine.openLocations([{ pathToOpen, exists: false }]);
          expect(lumine.workspace.getTextEditors().map((e) => e.getPath())).toEqual([pathToOpen]);
          expect(lumine.project.getPaths()).toEqual([]);
        });

        it("may be required to be an existing directory", async () => {
          spyOn(lumine.notifications, "addWarning");

          const nonExistent = path.join(__dirname, "no");
          const existingFile = __filename;
          const existingDir = path.join(__dirname, "fixtures");

          await lumine.openLocations([
            { pathToOpen: nonExistent, isDirectory: true },
            { pathToOpen: existingFile, isDirectory: true },
            { pathToOpen: existingDir, isDirectory: true },
          ]);

          expect(lumine.workspace.getTextEditors()).toEqual([]);
          expect(lumine.project.getPaths()).toEqual([existingDir]);

          expect(lumine.notifications.addWarning).toHaveBeenCalled();
          expect(lumine.notifications.addWarning.calls.mostRecent().args[0]).toEqual(
            "Unable to open project folders",
          );

          expect(lumine.notifications.addWarning.calls.mostRecent().args[1]).toEqual(
            jasmine.objectContaining({
              description: `The directories \`${nonExistent}\` and \`${existingFile}\` do not exist.`,
              dismissable: true,
              buttons: jasmine.arrayContaining([
                jasmine.objectContaining({
                  text: "Remove all",
                  onDidClick: jasmine.any(Function),
                }),
                jasmine.objectContaining({
                  text: "Skip for now",
                  onDidClick: jasmine.any(Function),
                }),
              ]),
            }),
          );
        });
      });

      describe("when more files are opened at once than `core.maxTextEditors` allows", () => {
        const locations = (count) =>
          Array.from({ length: count }, (_, index) => ({
            pathToOpen: path.join(__dirname, "fixtures", "dir", `file-${index}.txt`),
            exists: false,
          }));

        it("opens up to the limit and reports the rest as unopened", async () => {
          lumine.config.set("core.maxTextEditors", 3);
          spyOn(lumine.notifications, "addWarning");

          await lumine.openLocations(locations(7));

          expect(lumine.workspace.getTextEditors().length).toBe(3);
          expect(lumine.notifications.addWarning).toHaveBeenCalled();
          expect(lumine.notifications.addWarning.calls.mostRecent().args[0]).toBe(
            "Opened 3 of 7 files",
          );
          expect(lumine.notifications.addWarning.calls.mostRecent().args[1].description).toContain(
            "core.maxTextEditors",
          );
        });

        it("offers to open the ones it left alone", async () => {
          lumine.config.set("core.maxTextEditors", 2);
          spyOn(lumine.notifications, "addWarning");

          await lumine.openLocations(locations(5));
          expect(lumine.workspace.getTextEditors().length).toBe(2);

          const [button] = lumine.notifications.addWarning.calls.mostRecent().args[1].buttons;
          expect(button.text).toBe("Open the other 3 anyway");
          await button.onDidClick();

          expect(lumine.workspace.getTextEditors().length).toBe(5);
        });

        it("counts items already in the workspace center", async () => {
          lumine.config.set("core.maxTextEditors", 4);
          await lumine.workspace.open(path.join(__dirname, "fixtures", "sample.js"));
          expect(lumine.workspace.getCenter().getPaneItems().length).toBe(1);

          await lumine.openLocations(locations(6));

          expect(lumine.workspace.getCenter().getPaneItems().length).toBe(4);
        });

        it("never limits a single file, so a deliberate open always lands", async () => {
          lumine.config.set("core.maxTextEditors", 1);
          await lumine.openLocations(locations(1));
          await lumine.openLocations([
            { pathToOpen: path.join(__dirname, "fixtures", "dir", "beyond.txt"), exists: false },
          ]);

          expect(lumine.workspace.getTextEditors().length).toBe(2);
        });

        // `--wait` resolves when the item is destroyed, so a file that never
        // opens would leave the command line waiting forever.
        it("never limits a file the command line is waiting on", async () => {
          lumine.config.set("core.maxTextEditors", 2);

          const waited = locations(5).map((location, index) =>
            index >= 3 ? { ...location, hasWaitSession: true } : location,
          );
          await lumine.openLocations(waited);

          const opened = lumine.workspace.getTextEditors().map((editor) => editor.getPath());
          expect(opened).toContain(waited[3].pathToOpen);
          expect(opened).toContain(waited[4].pathToOpen);
        });

        it("does not limit anything when set to 0", async () => {
          lumine.config.set("core.maxTextEditors", 0);
          await lumine.openLocations(locations(6));
          expect(lumine.workspace.getTextEditors().length).toBe(6);
        });
      });

      describe("when the opened path is handled by a registered directory provider", () => {
        let serviceDisposable;

        beforeEach(() => {
          serviceDisposable = lumine.packages.serviceHub.provide(
            "project.directory-provider",
            "1.0.0",
            {
              directoryForURISync(uri) {
                if (uri.startsWith("remote://")) {
                  return {
                    getPath() {
                      return uri;
                    },
                  };
                } else {
                  return null;
                }
              },
            },
          );
        });

        afterEach(() => {
          serviceDisposable.dispose();
        });

        it("adds it to the project's paths as is", async () => {
          const pathToOpen = "remote://server:7644/some/dir/path";
          spyOn(lumine.project, "addPaths");
          await lumine.openLocations([{ pathToOpen }]);
          expect(lumine.project.addPaths).toHaveBeenCalledWith(new Set([pathToOpen]));
        });
      });
    });

    describe("when there is saved state for the relevant directories", () => {
      const state = Symbol("savedState");

      beforeEach(() => {
        spyOn(lumine, "getStateKey").and.callFake((dirs) => dirs.join(":"));
        spyOn(lumine, "loadState").and.callFake(function (key) {
          if (key === __dirname) {
            return Promise.resolve(state);
          } else {
            return Promise.resolve(null);
          }
        });
        spyOn(lumine, "attemptRestoreProjectStateForPaths");
      });

      describe("when there are no project folders", () => {
        it("attempts to restore the project state", async () => {
          const pathToOpen = __dirname;
          await lumine.openLocations([{ pathToOpen, isDirectory: true }]);
          expect(lumine.attemptRestoreProjectStateForPaths).toHaveBeenCalledWith(
            state,
            [pathToOpen],
            [],
          );
          expect(lumine.project.getPaths()).toEqual([]);
        });

        it("includes missing mandatory project folders in computation of initial state key", async () => {
          const existingDir = path.join(__dirname, "fixtures");
          const missingDir = path.join(__dirname, "no");

          lumine.loadState.and.callFake(function (key) {
            if (key === `${existingDir}:${missingDir}`) {
              return Promise.resolve(state);
            } else {
              return Promise.resolve(null);
            }
          });

          await lumine.openLocations([
            { pathToOpen: existingDir },
            { pathToOpen: missingDir, isDirectory: true },
          ]);

          expect(lumine.attemptRestoreProjectStateForPaths).toHaveBeenCalledWith(
            state,
            [existingDir],
            [],
          );
          expect(lumine.project.getPaths(), [existingDir]);
        });

        it("opens the specified files", async () => {
          await lumine.openLocations([
            { pathToOpen: __dirname, isDirectory: true },
            { pathToOpen: __filename },
          ]);
          expect(lumine.attemptRestoreProjectStateForPaths).toHaveBeenCalledWith(
            state,
            [__dirname],
            [__filename],
          );
          expect(lumine.project.getPaths()).toEqual([]);
        });
      });

      describe("when there are already project folders", () => {
        beforeEach(() => lumine.project.setPaths([__dirname]));

        it("does not attempt to restore the project state, instead adding the project paths", async () => {
          const pathToOpen = path.join(__dirname, "fixtures");
          await lumine.openLocations([{ pathToOpen, exists: true, isDirectory: true }]);
          expect(lumine.attemptRestoreProjectStateForPaths).not.toHaveBeenCalled();
          expect(lumine.project.getPaths()).toEqual([__dirname, pathToOpen]);
        });

        it("opens the specified files", async () => {
          const pathToOpen = path.join(__dirname, "fixtures");
          const fileToOpen = path.join(pathToOpen, "michelle-is-awesome.txt");
          await lumine.openLocations([
            { pathToOpen, exists: true, isDirectory: true },
            { pathToOpen: fileToOpen, exists: true, isFile: true },
          ]);
          expect(lumine.attemptRestoreProjectStateForPaths).not.toHaveBeenCalledWith(
            state,
            [pathToOpen],
            [fileToOpen],
          );
          expect(lumine.project.getPaths()).toEqual([__dirname, pathToOpen]);
        });
      });
    });
  });

  describe("::getReleaseChannel()", () => {
    let version;

    beforeEach(() => {
      spyOn(lumine.application, "getVersion").and.callFake(() => version);
    });

    it("returns the correct channel based on the version number", () => {
      version = "1.5.6";
      expect(lumine.application.getReleaseChannel()).toBe("stable");

      version = "1.5.0-beta10";
      expect(lumine.application.getReleaseChannel()).toBe("beta");

      version = "1.7.0-dev-5340c91";
      expect(lumine.application.getReleaseChannel()).toBe("dev");
    });
  });

  describe("::trashItem()", () => {
    let fileToBeTrashed, tempDir;

    beforeEach(() => {
      tempDir = temp.mkdirSync("trash-item-");
      fileToBeTrashed = path.join(tempDir, "file-1.txt");
      fs.writeFileSync(fileToBeTrashed, "test file");

      spyOn(lumine.applicationDelegate, "trashItem").and.callFake((filePath) => {
        if (!fs.existsSync(filePath)) return Promise.reject(new Error("File does not exist"));
        fs.unlinkSync(filePath);
        return Promise.resolve();
      });
    });

    it("trashes the file", async () => {
      expect(fs.existsSync(fileToBeTrashed)).toBe(true);
      await lumine.shell.trashItem(fileToBeTrashed);
      expect(lumine.applicationDelegate.trashItem).toHaveBeenCalledWith(fileToBeTrashed);
      expect(fs.existsSync(fileToBeTrashed)).toBe(false);
    });

    it("rejects when asked to trash a nonexistent file", async () => {
      const nonexistentFile = path.join(tempDir, "zzyzx.txt");
      expect(fs.existsSync(nonexistentFile)).toBe(false);
      let outcome;

      try {
        await lumine.shell.trashItem(nonexistentFile);
        outcome = "success";
      } catch {
        outcome = "failure";
      } finally {
        expect(lumine.applicationDelegate.trashItem).toHaveBeenCalledWith(nonexistentFile);
        expect(outcome).toBe("failure");
      }
    });
  });
});
