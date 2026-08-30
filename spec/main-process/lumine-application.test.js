/* globals assert */

const path = require("path");
const { EventEmitter } = require("events");
const temp = require("@lumine-code/temp").track();
const fs = require("@lumine-code/fs-plus");
const electron = require("electron");
const sandbox = require("sinon").createSandbox();

const LumineApplication = require("../../src/lumine-application");
const parseCommandLine = require("../../src/parse-command-line");
const { emitterEventPromise, conditionPromise } = require("../helpers/async-spec-helpers");

// These tests use a utility class called LaunchScenario, defined below, to manipulate LumineApplication instances that
// (1) are stubbed to only simulate LumineWindow creation and (2) allow you to use a shorthand notation to assert the
// application state after certain launch actions.
//
// Each scenario instance has access to a small set of directories and files created within a dedicated temporary
// directory. For convenience, you may use short names to refer to any of its contents (their basenames, basically).
// Check `LaunchScenario::init()` to see what directories and files are available.
//
// To create an application and its first window, call `await scenario.launch({})`. "Launch" may open multiple windows,
// so it returns a Promise that resolves to an array of StubWindows. Its options argument may be created by
// `parseCommandLine()` from a simulated argv string, or built by hand to include `{pathsToOpen}` and so on.
//
// To create additional windows, call `await scenario.open({})` with similar arguments. `LaunchScenario::open()` returns
// a Promise that resolves to the opened or re-used StubWindows. The one exception is if `urlsToOpen` are provided in the open
// arguments; then it resolves to an Array of StubWindows, because LumineApplication processes each URL individually.
//
// To ensure that the expected windows have been created, call `await scenario.assert('')` with a string specifying the
// expected window contents. The specification shorthand language is as follows:
//
// * '[_ _]' describes a single window with no project roots and no open editors.
// * '[_ 1.md]' describes a single window with no project roots and a single editor open on the file `./a/1.md` within
//   the LaunchScenario temporary directory.
// * '[a _]' describes a single window with one project root - the directory `./a` within the LaunchScenario temporary
//   directory - and no open editors.
// * '[a,b 1.md,2.md]' describes a single window with two project roots - the directories `./a` and `./b` - and two
//   open editors - `./a/1.md` and `./b/2.md`.
// * '[a _] [b,c 2.md]' describes two windows, one with a project root of `./a` and no open editors, and another with
//   two project roots, `./b` and `./c`, and one open editor on `./b/2.md`. The windows are listed in their expected
//   creation order.

describe("LumineApplication", function () {
  let scenario, sinon, originalDevMode;

  beforeEach(async function () {
    originalDevMode = process.env.LUMINE_DEV_MODE;
    delete process.env.LUMINE_DEV_MODE;
    sinon = sandbox;
    scenario = await LaunchScenario.create(sinon);
  });

  afterEach(async function () {
    await scenario.destroy();
    sinon.restore();
    if (originalDevMode === undefined) {
      delete process.env.LUMINE_DEV_MODE;
    } else {
      process.env.LUMINE_DEV_MODE = originalDevMode;
    }
  });

  describe("command-line interface behavior", function () {
    describe("with no open windows", function () {
      // This is also the case when a user selects the application from the OS shell
      it("opens an empty window", async function () {
        await scenario.launch(parseCommandLine([]));
        await scenario.assert("[_ _]");
      });

      // This is also the case when a user clicks on a file in their file manager
      it("opens a file", async function () {
        await scenario.open(parseCommandLine(["a/1.md"]));
        await scenario.assert("[_ 1.md]");
      });

      // This is also the case when a user clicks on a folder in their file manager
      // (or, on macOS, drags the folder to Lumine in their dock)
      it("opens a directory", async function () {
        await scenario.open(parseCommandLine(["a"]));
        await scenario.assert("[a _]");
      });

      it("opens a file with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a/1.md"]));
        await scenario.assert("[_ 1.md]");
      });

      it("opens a directory with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a"]));
        await scenario.assert("[a _]");
      });

      it("opens a file with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a/1.md"]));
        await scenario.assert("[_ 1.md]");
      });

      it("opens a directory with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a"]));
        await scenario.assert("[a _]");
      });

      describe("with previous window state", function () {
        let app;

        beforeEach(function () {
          app = scenario.addApplication({
            applicationJson: {
              version: "1",
              windows: [
                { projectRoots: [scenario.convertRootPath("b")] },
                { projectRoots: [scenario.convertRootPath("c")] },
              ],
            },
          });
        });

        describe('with core.restorePreviousState set to "no"', function () {
          beforeEach(function () {
            app.config.set("core.restorePreviousState", "no");
          });

          it("doesn't restore windows when launched with no arguments", async function () {
            await scenario.launch({ app });
            await scenario.assert("[_ _]");
          });

          it("doesn't restore windows when launched with paths to open", async function () {
            await scenario.launch({ app, pathsToOpen: ["a/1.md"] });
            await scenario.assert("[_ 1.md]");
          });

          it("doesn't restore windows when --new-window is provided", async function () {
            await scenario.launch({ app, newWindow: true });
            await scenario.assert("[_ _]");
          });
        });

        describe('with core.restorePreviousState set to "yes"', function () {
          beforeEach(function () {
            app.config.set("core.restorePreviousState", "yes");
          });

          it("restores windows when launched with no arguments", async function () {
            await scenario.launch({ app });
            await scenario.assert("[b _] [c _]");
          });

          it("doesn't restore windows when launched with paths to open", async function () {
            await scenario.launch({ app, pathsToOpen: ["a/1.md"] });
            await scenario.assert("[_ 1.md]");
          });

          it("doesn't restore windows when --new-window is provided", async function () {
            await scenario.launch({ app, newWindow: true });
            await scenario.assert("[_ _]");
          });
        });

        describe('with core.restorePreviousState set to "always"', function () {
          beforeEach(function () {
            app.config.set("core.restorePreviousState", "always");
          });

          it("restores windows when launched with no arguments", async function () {
            await scenario.launch({ app });
            await scenario.assert("[b _] [c _]");
          });

          it("restores windows when launched with a project path to open", async function () {
            await scenario.launch({ app, pathsToOpen: ["a"] });
            await scenario.assert("[b _] [c _] [a _]");
          });

          it("restores windows when launched with a file path to open", async function () {
            await scenario.launch({ app, pathsToOpen: ["a/1.md"] });
            await scenario.assert("[b _] [c 1.md]");
          });

          it("collapses new paths into restored windows when appropriate", async function () {
            await scenario.launch({ app, pathsToOpen: ["b/2.md"] });
            await scenario.assert("[b 2.md] [c _]");
          });

          it("doesn't restore windows when --new-window is provided", async function () {
            await scenario.launch({ app, newWindow: true });
            await scenario.assert("[_ _]");
          });

          it("doesn't restore windows on open, just launch", async function () {
            await scenario.launch({ app, pathsToOpen: ["a"], newWindow: true });
            await scenario.open(parseCommandLine(["b"]));
            await scenario.assert("[a _] [b _]");
          });
        });
      });

      describe("with unversioned application state", function () {
        it('reads "initialPaths" as project roots', async function () {
          const app = scenario.addApplication({
            applicationJson: [
              { initialPaths: [scenario.convertRootPath("a")] },
              {
                initialPaths: [scenario.convertRootPath("b"), scenario.convertRootPath("c")],
              },
            ],
          });
          app.config.set("core.restorePreviousState", "always");

          await scenario.launch({ app });
          await scenario.assert("[a _] [b,c _]");
        });

        it("filters file paths from project root lists", async function () {
          const app = scenario.addApplication({
            applicationJson: [
              {
                initialPaths: [scenario.convertRootPath("b"), scenario.convertEditorPath("a/1.md")],
              },
            ],
          });
          app.config.set("core.restorePreviousState", "always");

          await scenario.launch({ app });
          await scenario.assert("[b _]");
        });
      });
    });

    describe("with one empty window", function () {
      beforeEach(async function () {
        await scenario.preconditions("[_ _]");
      });

      // This is also the case when a user selects the application from the OS shell
      it("opens a new, empty window", async function () {
        await scenario.open(parseCommandLine([]));
        await scenario.assert("[_ _] [_ _]");
      });

      // This is also the case when a user clicks on a file in their file manager
      it("opens a file", async function () {
        await scenario.open(parseCommandLine(["a/1.md"]));
        await scenario.assert("[_ 1.md]");
      });

      // This is also the case when a user clicks on a folder in their file manager
      it("opens a directory", async function () {
        await scenario.open(parseCommandLine(["a"]));
        await scenario.assert("[a _]");
      });

      it("opens a file with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a/1.md"]));
        await scenario.assert("[_ 1.md]");
      });

      it("opens a directory with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a"]));
        await scenario.assert("[a _]");
      });

      it("reuses the empty window for a file with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a/1.md"]));
        await scenario.assert("[_ 1.md]");
      });

      it("reuses the empty window for a directory with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a"]));
        await scenario.assert("[a _]");
      });
    });

    describe("with one window that has a project root", function () {
      beforeEach(async function () {
        await scenario.preconditions("[a _]");
      });

      // This is also the case when a user selects the application from the OS shell
      it("opens a new, empty window", async function () {
        await scenario.open(parseCommandLine([]));
        await scenario.assert("[a _] [_ _]");
      });

      // This is also the case when a user clicks on a file within the project root in their file manager
      it("opens a file within the project root", async function () {
        await scenario.open(parseCommandLine(["a/1.md"]));
        await scenario.assert("[a 1.md]");
      });

      // This is also the case when a user clicks on a project root folder in their file manager
      it("opens a directory that matches the project root", async function () {
        await scenario.open(parseCommandLine(["a"]));
        await scenario.assert("[a _]");
      });

      // This is also the case when a user clicks on a file outside the project root in their file manager
      it("opens a file outside the project root", async function () {
        await scenario.open(parseCommandLine(["b/2.md"]));
        await scenario.assert("[a 2.md]");
      });

      // This is also the case when a user clicks on a new folder in their file manager
      it("opens a directory other than the project root", async function () {
        await scenario.open(parseCommandLine(["b"]));
        await scenario.assert("[a _] [b _]");
      });

      it("opens a file within the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a/1.md"]));
        await scenario.assert("[a 1.md]");
      });

      it("opens a directory that matches the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a"]));
        await scenario.assert("[a _]");
      });

      it("opens a file outside the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "b/2.md"]));
        await scenario.assert("[a 2.md]");
      });

      it("opens a directory other than the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "b"]));
        await scenario.assert("[a,b _]");
      });

      it("opens a file within the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a/1.md"]));
        await scenario.assert("[a _] [_ 1.md]");
      });

      it("opens a directory that matches the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a"]));
        await scenario.assert("[a _] [a _]");
      });

      it("opens a file outside the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "b/2.md"]));
        await scenario.assert("[a _] [_ 2.md]");
      });

      it("opens a directory other than the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "b"]));
        await scenario.assert("[a _] [b _]");
      });
    });

    describe("with two windows, one with a project root and one empty", function () {
      beforeEach(async function () {
        await scenario.preconditions("[a _] [_ _]");
      });

      // This is also the case when a user selects the application from the OS shell
      it("opens a new, empty window", async function () {
        await scenario.open(parseCommandLine([]));
        await scenario.assert("[a _] [_ _] [_ _]");
      });

      // This is also the case when a user clicks on a file within the project root in their file manager
      it("opens a file within the project root", async function () {
        await scenario.open(parseCommandLine(["a/1.md"]));
        await scenario.assert("[a 1.md] [_ _]");
      });

      // This is also the case when a user clicks on a project root folder in their file manager
      it("opens a directory that matches the project root", async function () {
        await scenario.open(parseCommandLine(["a"]));
        await scenario.assert("[a _] [_ _]");
      });

      // This is also the case when a user clicks on a file outside the project root in their file manager
      it("opens a file outside the project root", async function () {
        await scenario.open(parseCommandLine(["b/2.md"]));
        await scenario.assert("[a _] [_ 2.md]");
      });

      // This is also the case when a user clicks on a new folder in their file manager
      it("opens a directory other than the project root", async function () {
        await scenario.open(parseCommandLine(["b"]));
        await scenario.assert("[a _] [b _]");
      });

      it("opens a file within the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a/1.md"]));
        await scenario.assert("[a 1.md] [_ _]");
      });

      it("opens a directory that matches the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a"]));
        await scenario.assert("[a _] [_ _]");
      });

      it("opens a file outside the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "b/2.md"]));
        await scenario.assert("[a _] [_ 2.md]");
      });

      it("opens a directory other than the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "b"]));
        await scenario.assert("[a _] [b _]");
      });

      it("opens a file within the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a/1.md"]));
        await scenario.assert("[a _] [_ 1.md]");
      });

      it("opens a directory that matches the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a"]));
        await scenario.assert("[a _] [a _]");
      });

      it("opens a file outside the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "b/2.md"]));
        await scenario.assert("[a _] [_ 2.md]");
      });

      it("opens a directory other than the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "b"]));
        await scenario.assert("[a _] [b _]");
      });
    });

    describe("with two windows, one empty and one with a project root", function () {
      beforeEach(async function () {
        await scenario.preconditions("[_ _] [a _]");
      });

      // This is also the case when a user selects the application from the OS shell
      it("opens a new, empty window", async function () {
        await scenario.open(parseCommandLine([]));
        await scenario.assert("[_ _] [a _] [_ _]");
      });

      // This is also the case when a user clicks on a file within the project root in their file manager
      it("opens a file within the project root", async function () {
        await scenario.open(parseCommandLine(["a/1.md"]));
        await scenario.assert("[_ _] [a 1.md]");
      });

      // This is also the case when a user clicks on a project root folder in their file manager
      it("opens a directory that matches the project root", async function () {
        await scenario.open(parseCommandLine(["a"]));
        await scenario.assert("[_ _] [a _]");
      });

      // This is also the case when a user clicks on a file outside the project root in their file manager
      it("opens a file outside the project root", async function () {
        await scenario.open(parseCommandLine(["b/2.md"]));
        await scenario.assert("[_ 2.md] [a _]");
      });

      // This is also the case when a user clicks on a new folder in their file manager
      it("opens a directory other than the project root", async function () {
        await scenario.open(parseCommandLine(["b"]));
        await scenario.assert("[b _] [a _]");
      });

      it("opens a file within the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a/1.md"]));
        await scenario.assert("[_ _] [a 1.md]");
      });

      it("opens a directory that matches the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "a"]));
        await scenario.assert("[_ _] [a _]");
      });

      it("opens a file outside the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "b/2.md"]));
        await scenario.assert("[_ _] [a 2.md]");
      });

      it("opens a directory other than the project root with --add", async function () {
        await scenario.open(parseCommandLine(["--add", "b"]));
        await scenario.assert("[_ _] [a,b _]");
      });

      it("opens a file within the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a/1.md"]));
        await scenario.assert("[_ 1.md] [a _]");
      });

      it("opens a directory that matches the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "a"]));
        await scenario.assert("[a _] [a _]");
      });

      it("opens a file outside the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "b/2.md"]));
        await scenario.assert("[_ 2.md] [a _]");
      });

      it("opens a directory other than the project root with --new-window", async function () {
        await scenario.open(parseCommandLine(["--new-window", "b"]));
        await scenario.assert("[b _] [a _]");
      });
    });

    describe("--wait", function () {
      it("kills the specified pid after a newly-opened window is closed", async function () {
        const [w0] = await scenario.launch(
          parseCommandLine(["--new-window", "--wait", "--pid", "101"]),
        );
        const w1 = await scenario.open(
          parseCommandLine(["--new-window", "--wait", "--pid", "202"]),
        );

        assert.lengthOf(scenario.killedPids, 0);

        w0.browserWindow.emit("closed");
        assert.deepEqual(scenario.killedPids, [101]);

        w1.browserWindow.emit("closed");
        assert.deepEqual(scenario.killedPids, [101, 202]);
      });

      it("kills the specified pid after all newly-opened files in an existing window are closed", async function () {
        const [w] = await scenario.launch(parseCommandLine(["--new-window", "a"]));
        await scenario.open(
          parseCommandLine(["--add", "--wait", "--pid", "303", "a/1.md", "b/2.md"]),
        );
        await scenario.assert("[a 1.md,2.md]");

        assert.lengthOf(scenario.killedPids, 0);

        scenario
          .getApplication(0)
          .windowDidClosePathWithWaitSession(w, scenario.convertEditorPath("b/2.md"));
        assert.lengthOf(scenario.killedPids, 0);
        scenario
          .getApplication(0)
          .windowDidClosePathWithWaitSession(w, scenario.convertEditorPath("a/1.md"));
        assert.deepEqual(scenario.killedPids, [303]);
      });

      it("kills the specified pid after a newly-opened directory in an existing window is closed", async function () {
        const [w] = await scenario.launch(parseCommandLine(["--new-window", "a"]));
        await scenario.open(parseCommandLine(["--add", "--wait", "--pid", "404", "b"]));
        await scenario.assert("[a,b _]");

        assert.lengthOf(scenario.killedPids, 0);

        scenario
          .getApplication(0)
          .windowDidClosePathWithWaitSession(w, scenario.convertRootPath("b"));
        assert.deepEqual(scenario.killedPids, [404]);
      });
    });

    describe("lumine:// URLs", function () {
      describe("with a package-name host", function () {
        it("loads the package's urlMain in a new window", async function () {
          await scenario.launch({});

          const app = scenario.getApplication(0);
          app.packages = {
            getAvailablePackageMetadata: () => [
              { name: "package-with-url-main", urlMain: "some/url-main" },
            ],
            resolvePackagePath: () => path.resolve("packages/package-with-url-main"),
          };

          const [w1, w2] = await scenario.open(
            parseCommandLine([
              "lumine://package-with-url-main/test1",
              "lumine://package-with-url-main/test2",
            ]),
          );

          assert.strictEqual(
            w1.loadSettings.windowInitializationScript,
            path.resolve("packages/package-with-url-main/some/url-main"),
          );
          assert.strictEqual(w1.loadSettings.urlToOpen, "lumine://package-with-url-main/test1");

          assert.strictEqual(
            w2.loadSettings.windowInitializationScript,
            path.resolve("packages/package-with-url-main/some/url-main"),
          );
          assert.strictEqual(w2.loadSettings.urlToOpen, "lumine://package-with-url-main/test2");
        });

        it("sends a URI message to the most recently focused non-spec window", async function () {
          const [w0] = await scenario.launch({});
          const w1 = await scenario.open(parseCommandLine(["--new-window"]));
          const w2 = await scenario.open(parseCommandLine(["--new-window"]));
          const w3 = await scenario.open(parseCommandLine(["--test", "a/1.md"]));

          const app = scenario.getApplication(0);
          app.packages = {
            getAvailablePackageMetadata: () => [],
          };

          const [uw] = await scenario.open(
            parseCommandLine(["lumine://package-without-url-main/test"]),
          );
          assert.strictEqual(uw, w2);

          assert.isTrue(w2.sendURIMessage.calledWith("lumine://package-without-url-main/test"));
          assert.strictEqual(w2.focus.callCount, 2);

          for (const other of [w0, w1, w3]) {
            assert.isFalse(other.sendURIMessage.called);
          }
        });

        it("creates a new window and sends a URI message to it once it loads", async function () {
          const [w0] = await scenario.launch(parseCommandLine(["--test", "a/1.md"]));

          const app = scenario.getApplication(0);
          app.packages = {
            getAvailablePackageMetadata: () => [],
          };

          const [uw] = await scenario.open(
            parseCommandLine(["lumine://package-without-url-main/test"]),
          );
          assert.notStrictEqual(uw, w0);
          assert.strictEqual(
            uw.loadSettings.windowInitializationScript,
            path.resolve(__dirname, "../../src/initialize-application-window.js"),
          );

          uw.emit("window:loaded");
          assert.isTrue(uw.sendURIMessage.calledWith("lumine://package-without-url-main/test"));
        });
      });

      describe('with a "core" host', function () {
        it("sends a URI message to the most recently focused non-spec window that owns the open locations", async function () {
          const [w0] = await scenario.launch(parseCommandLine(["a"]));
          const w1 = await scenario.open(parseCommandLine(["--new-window", "a"]));
          const w2 = await scenario.open(parseCommandLine(["--new-window", "b"]));

          const uri = `lumine://core/open/file?filename=${encodeURIComponent(
            scenario.convertEditorPath("a/1.md"),
          )}`;
          const [uw] = await scenario.open(parseCommandLine([uri]));
          assert.strictEqual(uw, w1);
          assert.isTrue(w1.sendURIMessage.calledWith(uri));

          for (const other of [w0, w2]) {
            assert.isFalse(other.sendURIMessage.called);
          }
        });

        it("creates a new window and sends a URI message to it once it loads", async function () {
          const [w0] = await scenario.launch(parseCommandLine(["--test", "a/1.md"]));

          const uri = `lumine://core/open/file?filename=${encodeURIComponent(
            scenario.convertEditorPath("b/2.md"),
          )}`;
          const [uw] = await scenario.open(parseCommandLine([uri]));
          assert.notStrictEqual(uw, w0);

          uw.emit("window:loaded");
          assert.isTrue(uw.sendURIMessage.calledWith(uri));
        });
      });
    });

    it("opens a file to a specific line number", async function () {
      await scenario.open(parseCommandLine(["a/1.md:10"]));
      await scenario.assert("[_ 1.md]");

      const w = scenario.getWindow(0);
      assert.lengthOf(w._locations, 1);
      assert.strictEqual(w._locations[0].initialLine, 9);
      assert.isNull(w._locations[0].initialColumn);
    });

    it("opens a file to a specific line number and column", async function () {
      await scenario.open(parseCommandLine(["b/2.md:12:5"]));
      await scenario.assert("[_ 2.md]");

      const w = scenario.getWindow(0);
      assert.lengthOf(w._locations, 1);
      assert.strictEqual(w._locations[0].initialLine, 11);
      assert.strictEqual(w._locations[0].initialColumn, 4);
    });

    it("opens a directory with a non-file protocol", async function () {
      await scenario.open(parseCommandLine(["remote://server:3437/some/directory/path"]));

      const w = scenario.getWindow(0);
      assert.lengthOf(w._locations, 1);
      assert.strictEqual(w._locations[0].pathToOpen, "remote://server:3437/some/directory/path");
      assert.isFalse(w._locations[0].exists);
      assert.isFalse(w._locations[0].isDirectory);
      assert.isFalse(w._locations[0].isFile);
    });

    it("truncates trailing whitespace and colons", async function () {
      await scenario.open(parseCommandLine(["b/2.md::  "]));
      await scenario.assert("[_ 2.md]");

      const w = scenario.getWindow(0);
      assert.lengthOf(w._locations, 1);
      assert.isNull(w._locations[0].initialLine);
      assert.isNull(w._locations[0].initialColumn);
    });

    it("disregards test windows", async function () {
      await scenario.launch(parseCommandLine(["--test", "b"]));
      await scenario.open(parseCommandLine(["--new-window"]));
      await scenario.open(parseCommandLine(["--test", "c"]));

      await scenario.open(parseCommandLine(["a/1.md"]));

      // Test StubWindows are visible as empty editor windows here.
      await scenario.assert("[_ _] [_ 1.md] [_ _]");
    });
  });

  if (process.platform === "darwin" || process.platform === "win32") {
    it("positions new windows at an offset from the previous window", async function () {
      const [w0] = await scenario.launch(parseCommandLine(["a"]));
      w0.setSize(400, 400);
      const d0 = w0.getDimensions();

      const w1 = await scenario.open(parseCommandLine(["b"]));
      const d1 = w1.getDimensions();

      assert.isAbove(d1.x, d0.x);
      assert.isAbove(d1.y, d0.y);
    });
  }

  if (process.platform === "darwin") {
    describe("with no windows open", function () {
      let app;

      beforeEach(async function () {
        const [w] = await scenario.launch(parseCommandLine([]));

        app = scenario.getApplication(0);
        app.removeWindow(w);
        sinon.stub(app, "promptForPathToOpen");
        global.lumine = { workspace: { getActiveTextEditor() {} } };
      });

      it("opens a new file", function () {
        app.emit("application:open-file");
        assert.isTrue(
          app.promptForPathToOpen.calledWith("file", {
            devMode: false,
            safeMode: false,
            window: null,
          }),
        );
      });

      it("opens a new directory", function () {
        app.emit("application:open-folder");
        assert.isTrue(
          app.promptForPathToOpen.calledWith("folder", {
            devMode: false,
            safeMode: false,
            window: null,
          }),
        );
      });

      it("opens a new file or directory", function () {
        app.emit("application:open");
        assert.isTrue(
          app.promptForPathToOpen.calledWith("all", {
            devMode: false,
            safeMode: false,
            window: null,
          }),
        );
      });

      it("reopens a project in a new window", async function () {
        const paths = scenario.convertPaths(["a", "b"]);
        app.emit("application:reopen-project", { paths });

        await conditionPromise(() => app.getAllWindows().length > 0);

        assert.deepEqual(
          app.getAllWindows().map((w) => Array.from(w._rootPaths)),
          [paths],
        );
      });
    });
  }

  describe("existing application re-use", function () {
    let createApplication;

    const version = electron.app.getVersion();

    beforeEach(function () {
      createApplication = async (options) => {
        options.version = version;

        const app = scenario.addApplication(options);
        await app.listenForArgumentsFromNewProcess(options);
        await app.launch(options);
        return app;
      };
    });

    it("creates a new application when no socket is present", async function () {
      const app0 = await LumineApplication.open({ createApplication, version });
      await app0.deleteSocketSecretFile();

      const app1 = await LumineApplication.open({ createApplication, version });
      assert.isNotNull(app1);
      assert.notStrictEqual(app0, app1);
    });

    it("creates a new application for spec windows", async function () {
      const app0 = await LumineApplication.open({ createApplication, version });

      const app1 = await LumineApplication.open({
        createApplication,
        version,
        ...parseCommandLine(["--test", "a"]),
      });
      assert.isNotNull(app1);
      assert.notStrictEqual(app0, app1);
    });

    it("sends a request to an existing application when a socket is present", async function () {
      const app0 = await LumineApplication.open({ createApplication, version });
      assert.lengthOf(app0.getAllWindows(), 1);

      const app1 = await LumineApplication.open({
        createApplication,
        version,
        ...parseCommandLine(["--new-window"]),
      });
      assert.isNull(app1);
      assert.isTrue(electron.app.quit.called);

      await conditionPromise(() => app0.getAllWindows().length === 2);
      await scenario.assert("[_ _] [_ _]");
    });
  });

  describe("IPC handling", function () {
    let w0, w1, w2, app;

    beforeEach(async function () {
      await scenario.preconditions("[a _] [_ _] [b _]");
      app = scenario.getApplication(0);
      w0 = scenario.getWindow(0);
      w1 = scenario.getWindow(1);
      w2 = scenario.getWindow(2);
      [w0, w1, w2].forEach((window, index) => {
        const contents = window.browserWindow.webContents;
        contents.id = 7000 + index;
        contents.isDestroyed = () => false;
        window.browserWindow.isDestroyed = () => false;
        window.id = index + 1;
        app.registerLumineWindow(window);
      });
      sinon.spy(app, "openPaths");
      sinon
        .stub(app, "promptForPath")
        .callsFake((_type, callback, defaultPath) => callback([defaultPath]));
    });

    it("showWindow focuses only the requested window on Windows", function () {
      w1.preserveFocus = false;
      w1.browserWindow.show = w1.show;
      w1.browserWindow.focus = w1.focus;
      w1.focus.resetHistory();

      const focusApplication = sinon.stub(electron.app, "focus");

      app.showWindow(w1);

      assert.isTrue(w1.show.calledOnce);
      if (process.platform === "win32") {
        assert.isTrue(w1.focus.calledOnce);
        assert.isFalse(focusApplication.called);
      } else if (process.platform === "darwin") {
        assert.isFalse(w1.focus.called);
        assert.isTrue(focusApplication.calledOnce);
      } else {
        assert.isFalse(w1.focus.called);
        assert.isFalse(focusApplication.called);
      }
    });

    it("accepts only the exact live WebContents registered for a Lumine window", function () {
      const sender = { id: 9001, isDestroyed: () => false };
      const registeredWindow = {
        browserWindow: {
          webContents: sender,
          isDestroyed: () => false,
        },
      };

      app.registerLumineWindow(registeredWindow);
      assert.strictEqual(app.lumineWindowForSender(sender), registeredWindow);
      assert.throws(
        () => app.lumineWindowForSender({ id: sender.id, isDestroyed: () => false }),
        /not a registered Lumine window/,
      );

      sender.isDestroyed = () => true;
      assert.throws(() => app.lumineWindowForSender(sender), /not a registered Lumine window/);

      sender.isDestroyed = () => false;
      app.unregisterLumineWindow(registeredWindow);
      assert.throws(() => app.lumineWindowForSender(sender), /not a registered Lumine window/);
    });

    it("discards stale one-way renderer signals after their window was unregistered", async function () {
      const staleEvent = { sender: { id: 9002, isDestroyed: () => false } };
      assert.isUndefined(
        await LumineApplication.handleWindowAction(staleEvent, "updateApplicationMenu", [], {}),
      );
      assert.isUndefined(await LumineApplication.handleWindowAction(staleEvent, "loaded"));
      await LumineApplication.handleWindowAction(staleEvent, "getState").then(
        () => assert.fail("a stale sender could perform a window action"),
        (error) => assert.match(error.message, /not a registered Lumine window/),
      );
    });

    it("bootstraps only serializable settings, cached metadata, and one-shot markers", function () {
      w1.getLoadSettingsForRenderer = sinon.stub().returns({
        isSpec: false,
        callbackThatMustNotCrossIPC: () => {},
      });
      w1.consumeStartupMarkers = sinon.stub().returns({ start: 1, ready: 2 });

      const result = LumineApplication.handleWindowBootstrap({
        sender: w1.browserWindow.webContents,
      });

      assert.strictEqual(result.loadSettings.windowId, w1.id);
      assert.isFalse(result.loadSettings.isSpec);
      assert.isFalse(Object.hasOwn(result.loadSettings, "callbackThatMustNotCrossIPC"));
      assert.strictEqual(typeof result.loadSettings.appLocale, "string");
      assert.strictEqual(typeof result.loadSettings.appPaths, "object");
      assert.deepEqual(result.startupMarkers, { start: 1, ready: 2 });
      assert.isTrue(w1.consumeStartupMarkers.calledOnce);
    });

    it("routes detached-pane IPC only through the registered owner WebContents", function () {
      const manager = {
        reserve: sinon.stub().returns({ transactionId: "drag-1" }),
        perform: sinon.stub().returns({ state: "ready" }),
      };
      w1.detachedPaneWindows = manager;
      const event = { sender: w1.browserWindow.webContents };

      assert.deepEqual(
        LumineApplication.handleDetachedPaneWindowAction(event, "reserve", {
          transactionId: "drag-1",
        }),
        { transactionId: "drag-1" },
      );
      assert.deepEqual(
        LumineApplication.handleDetachedPaneWindowAction(event, "perform", "drag-1", "ready"),
        { state: "ready" },
      );
      assert.isTrue(manager.reserve.calledOnce);
      assert.isTrue(manager.perform.calledOnceWithExactly("drag-1", "ready"));

      assert.throws(
        () =>
          LumineApplication.handleDetachedPaneWindowAction(
            { sender: { id: 9999, isDestroyed: () => false } },
            "reserve",
            {},
          ),
        /not a registered Lumine window/,
      );
    });

    it("handles allowlisted window state and lifecycle operations for the originating window", async function () {
      const window = w1.browserWindow;
      const contents = window.webContents;
      window.getPosition = sinon.stub().returns([10, 20]);
      window.getSize = sinon.stub().returns([800, 600]);
      window.setSize = sinon.spy();
      window.setPosition = sinon.spy();
      window.center = sinon.spy();
      window.hide = sinon.spy();
      window.isMaximized = sinon.stub().returns(true);
      window.isFullScreen = sinon.stub().returns(false);
      window.isVisible = sinon.stub().returns(true);
      window.setAutoHideMenuBar = sinon.spy();
      window.setMenuBarVisibility = sinon.spy();
      contents.focus = sinon.spy();
      contents.downloadURL = sinon.spy();
      contents.openDevTools = sinon.spy();
      contents.closeDevTools = sinon.spy();
      contents.toggleDevTools = sinon.spy();
      w1.unmaximize = sinon.spy();
      w1.setFullScreen = sinon.spy();
      w1.openDevTools = contents.openDevTools;
      w1.closeDevTools = contents.closeDevTools;
      w1.toggleDevTools = contents.toggleDevTools;

      const event = { sender: contents };
      assert.deepEqual(await LumineApplication.handleWindowAction(event, "getState"), {
        id: w1.id,
        position: { x: 10, y: 20 },
        size: { width: 800, height: 600 },
        maximized: true,
        fullScreen: false,
        visible: true,
      });
      assert.deepEqual(await LumineApplication.handleWindowAction(event, "getSize"), {
        width: 800,
        height: 600,
      });
      assert.deepEqual(await LumineApplication.handleWindowAction(event, "getPosition"), {
        x: 10,
        y: 20,
      });

      await LumineApplication.handleWindowAction(event, "setSize", 900, 700);
      await LumineApplication.handleWindowAction(event, "setPosition", 30, 40);
      await LumineApplication.handleWindowAction(event, "center");
      await LumineApplication.handleWindowAction(event, "focus");
      await LumineApplication.handleWindowAction(event, "hide");
      await LumineApplication.handleWindowAction(event, "minimize");
      await LumineApplication.handleWindowAction(event, "maximize");
      await LumineApplication.handleWindowAction(event, "unmaximize");
      await LumineApplication.handleWindowAction(event, "setFullScreen", true);
      await LumineApplication.handleWindowAction(event, "downloadURL", "https://example.test/a");
      await LumineApplication.handleWindowAction(event, "setAutoHideMenuBar", true);
      await LumineApplication.handleWindowAction(event, "setMenuBarVisibility", false);
      await LumineApplication.handleWindowAction(event, "openDevTools");
      await LumineApplication.handleWindowAction(event, "closeDevTools");
      await LumineApplication.handleWindowAction(event, "toggleDevTools");

      assert.isTrue(window.setSize.calledWithExactly(900, 700));
      assert.isTrue(window.setPosition.calledWithExactly(30, 40));
      assert.isTrue(window.center.calledOnce);
      assert.isTrue(w1.focus.called);
      assert.isTrue(contents.focus.calledOnce);
      assert.isTrue(window.hide.calledOnce);
      assert.isTrue(w1.minimize.calledOnce);
      assert.isTrue(w1.maximize.calledOnce);
      assert.isTrue(w1.setFullScreen.calledWithExactly(true));
      assert.isTrue(contents.downloadURL.calledWithExactly("https://example.test/a"));
      assert.isTrue(window.setAutoHideMenuBar.calledWithExactly(true));
      assert.isTrue(window.setMenuBarVisibility.calledWithExactly(false));
      assert.isTrue(contents.openDevTools.calledOnce);
      assert.isTrue(contents.closeDevTools.calledOnce);
      assert.isTrue(contents.toggleDevTools.calledOnce);

      await LumineApplication.handleWindowAction(event, "setSize", -1, 10).then(
        () => assert.fail("invalid size was accepted"),
        (error) => assert.match(error.message, /positive integer/),
      );
      await LumineApplication.handleWindowAction(event, "not-allowlisted").then(
        () => assert.fail("unknown window action was accepted"),
        (error) => assert.match(error.message, /Unsupported window action/),
      );
    });

    it("strictly validates and routes native application-menu popup actions", async function () {
      const originalApplicationMenu = app.applicationMenu;
      const applicationMenu = {
        showPopup: sinon.stub().resolves(true),
        closePopup: sinon.stub().returns(true),
      };
      app.applicationMenu = applicationMenu;

      try {
        const event = { sender: w1.browserWindow.webContents };
        const submenuHoverTarget = {
          key: "submenu:file",
          kind: "submenu",
          id: "file",
          bounds: { x: 0, y: 0, width: 40, height: 24 },
        };
        const submenuRequest = {
          kind: "submenu",
          id: "file",
          x: 12,
          y: 34,
          sourceType: "mouse",
          activeHoverTarget: "submenu:file",
          hoverTargets: [submenuHoverTarget],
        };
        const overflowHoverTarget = {
          key: "overflow",
          kind: "overflow",
          ids: ["file", "edit"],
          bounds: { x: 40, y: 0, width: 30, height: 24 },
        };
        const overflowRequest = {
          kind: "overflow",
          ids: ["file", "edit"],
          x: 56,
          y: 78,
          sourceType: "keyboard",
          activeHoverTarget: "overflow",
          hoverTargets: [overflowHoverTarget],
        };

        assert.isTrue(
          await LumineApplication.handleWindowAction(
            event,
            "showApplicationMenuPopup",
            submenuRequest,
          ),
        );
        assert.isTrue(
          applicationMenu.showPopup.calledWithExactly(w1.browserWindow, submenuRequest),
        );
        assert.isTrue(
          await LumineApplication.handleWindowAction(
            event,
            "showApplicationMenuPopup",
            overflowRequest,
          ),
        );
        assert.isTrue(
          applicationMenu.showPopup.calledWithExactly(w1.browserWindow, overflowRequest),
        );
        assert.isTrue(
          await LumineApplication.handleWindowAction(event, "closeApplicationMenuPopup"),
        );
        assert.isTrue(applicationMenu.closePopup.calledWithExactly(w1.browserWindow));

        app.applicationMenu = null;
        assert.isFalse(
          await LumineApplication.handleWindowAction(
            event,
            "showApplicationMenuPopup",
            submenuRequest,
          ),
        );
        assert.isFalse(
          await LumineApplication.handleWindowAction(event, "closeApplicationMenuPopup"),
        );
        app.applicationMenu = applicationMenu;

        const invalidRequests = [
          null,
          {},
          { ...submenuRequest, kind: "unknown" },
          { ...submenuRequest, extra: true },
          { ...submenuRequest, id: "" },
          { ...submenuRequest, x: -1 },
          { ...submenuRequest, x: 1.5 },
          { ...submenuRequest, y: 0x80000000 },
          { ...submenuRequest, sourceType: "touch" },
          { ...overflowRequest, ids: [] },
          { ...overflowRequest, ids: ["file", ""] },
          { ...overflowRequest, ids: ["file", "file"] },
          { ...overflowRequest, id: "file" },
          { ...submenuRequest, activeHoverTarget: "missing" },
          { ...submenuRequest, hoverTargets: [] },
          {
            ...submenuRequest,
            hoverTargets: [{ ...submenuHoverTarget, extra: true }],
          },
          {
            ...submenuRequest,
            hoverTargets: [{ ...submenuHoverTarget, key: "" }],
          },
          {
            ...submenuRequest,
            hoverTargets: [submenuHoverTarget, { ...submenuHoverTarget, key: "duplicate-target" }],
          },
          {
            ...submenuRequest,
            hoverTargets: [
              submenuHoverTarget,
              { ...submenuHoverTarget, id: "edit", bounds: { x: 40, y: 0, width: 40, height: 24 } },
            ],
          },
          {
            ...submenuRequest,
            hoverTargets: [{ ...submenuHoverTarget, bounds: { x: 0, y: 0, width: 0, height: 24 } }],
          },
          {
            ...submenuRequest,
            hoverTargets: [
              { ...submenuHoverTarget, bounds: { x: 0.5, y: 0, width: 40, height: 24 } },
            ],
          },
          {
            ...submenuRequest,
            hoverTargets: [
              {
                ...submenuHoverTarget,
                bounds: { x: 0x7fffffff, y: 0, width: 1, height: 24 },
              },
            ],
          },
          {
            ...submenuRequest,
            activeHoverTarget: "overflow",
            hoverTargets: [{ ...overflowHoverTarget, ids: ["edit"] }],
          },
          {
            ...overflowRequest,
            hoverTargets: [{ ...overflowHoverTarget, ids: ["file"] }],
          },
        ];
        for (const request of invalidRequests) {
          await assert.rejects(
            LumineApplication.handleWindowAction(event, "showApplicationMenuPopup", request),
            TypeError,
          );
        }
        await assert.rejects(
          LumineApplication.handleWindowAction(event, "showApplicationMenuPopup"),
          TypeError,
        );
        await assert.rejects(
          LumineApplication.handleWindowAction(
            event,
            "showApplicationMenuPopup",
            submenuRequest,
            submenuRequest,
          ),
          TypeError,
        );
        await assert.rejects(
          LumineApplication.handleWindowAction(event, "closeApplicationMenuPopup", true),
          TypeError,
        );

        const staleEvent = { sender: { id: 9003, isDestroyed: () => false } };
        await assert.rejects(
          LumineApplication.handleWindowAction(
            staleEvent,
            "showApplicationMenuPopup",
            submenuRequest,
          ),
          /not a registered Lumine window/,
        );
      } finally {
        app.applicationMenu = originalApplicationMenu;
      }
    });

    it("broadcasts structured data only to other live registered windows", function () {
      const payload = { sourceWindowId: w1.id, targetWindowId: w2.id, item: "tab" };
      LumineApplication.handleWindowBroadcast(
        { sender: w1.browserWindow.webContents },
        "tabs:item-dropped",
        payload,
      );

      assert.isTrue(
        w0.sendToRenderer.calledWithExactly("window-event", "tabs:item-dropped", payload),
      );
      assert.isFalse(w1.sendToRenderer.called);
      assert.isTrue(
        w2.sendToRenderer.calledWithExactly("window-event", "tabs:item-dropped", payload),
      );
      assert.throws(
        () =>
          LumineApplication.handleWindowBroadcast(
            { sender: w1.browserWindow.webContents },
            "",
            payload,
          ),
        /eventName must be a non-empty string/,
      );
    });

    it("returns the existing IPC result shape for Electron shell operations", async function () {
      const event = { sender: w1.browserWindow.webContents };
      const openPath = sinon.stub(electron.shell, "openPath").resolves("");
      const openError = Object.assign(new Error("could not open"), { code: "OPEN_FAILED" });
      const openExternal = sinon.stub(electron.shell, "openExternal").rejects(openError);

      assert.deepEqual(await LumineApplication.handleAppAction(event, "openPath", "C:\\a.txt"), {
        outcome: "success",
        result: "",
      });
      assert.deepEqual(
        await LumineApplication.handleAppAction(event, "openExternal", "https://example.test"),
        {
          outcome: "failure",
          error: { message: "could not open", code: "OPEN_FAILED" },
        },
      );
      assert.isTrue(openPath.calledWithExactly("C:\\a.txt"));
      assert.isTrue(openExternal.calledWithExactly("https://example.test"));
    });

    it("rejects unknown application and safe-storage operations", async function () {
      const event = { sender: w1.browserWindow.webContents };
      await LumineApplication.handleAppAction(event, "not-allowlisted").then(
        () => assert.fail("unknown application action was accepted"),
        (error) => assert.match(error.message, /Unsupported application action/),
      );
      await LumineApplication.handleSafeStorageAction(event, "not-allowlisted").then(
        () => assert.fail("unknown safe-storage action was accepted"),
        (error) => assert.match(error.message, /Unsupported safe-storage action/),
      );
    });

    // This is the IPC message used to handle:
    // * application:reopen-project
    // * choosing "open in new window" when adding a folder that has previously saved state
    // * drag and drop
    // * deprecated call links in deprecation-cop
    // * other direct callers of `lumine.application.openWindow()`
    it('"open" opens a fixed path by the standard opening rules', async function () {
      sinon.stub(app, "lumineWindowForEvent").callsFake(() => w1);

      electron.ipcMain.emit("open", {}, { pathsToOpen: [scenario.convertEditorPath("a/1.md")] });
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a 1.md] [_ _] [b _]");

      electron.ipcMain.emit("open", {}, { pathsToOpen: [scenario.convertRootPath("c")] });
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a 1.md] [c _] [b _]");

      electron.ipcMain.emit(
        "open",
        {},
        { pathsToOpen: [scenario.convertRootPath("d")], here: true },
      );
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a 1.md] [c,d _] [b _]");
    });

    it('"open" honors LUMINE_DEV_MODE for internal window requests', async function () {
      process.env.LUMINE_DEV_MODE = "1";

      electron.ipcMain.emit(
        "open",
        {},
        { pathsToOpen: [scenario.convertRootPath("c")], newWindow: true },
      );
      await app.openPaths.lastCall.returnValue;
      assert.isTrue(scenario.getWindow(3).devMode);

      electron.ipcMain.emit(
        "open",
        {},
        {
          pathsToOpen: [scenario.convertRootPath("d")],
          newWindow: true,
          devMode: false,
        },
      );
      await app.openPaths.lastCall.returnValue;
      assert.isTrue(scenario.getWindow(4).devMode);
    });

    it('"open" without any option open the prompt for selecting a path', async function () {
      sinon.stub(app, "lumineWindowForEvent").callsFake(() => w1);

      electron.ipcMain.emit("open", {});
      assert.strictEqual(app.promptForPath.lastCall.args[0], "all");
    });

    it('"open-chosen-any" opens a file in the sending window', async function () {
      sinon.stub(app, "lumineWindowForEvent").callsFake(() => w2);

      electron.ipcMain.emit("open-chosen-any", {}, scenario.convertEditorPath("a/1.md"));
      await conditionPromise(() => app.openPaths.called);
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a _] [_ _] [b 1.md]");

      assert.isTrue(app.promptForPath.called);
      assert.strictEqual(app.promptForPath.lastCall.args[0], "all");
    });

    it('"open-chosen-any" opens a directory by the standard opening rules', async function () {
      sinon.stub(app, "lumineWindowForEvent").callsFake(() => w1);

      // Open unrecognized directory in empty window
      electron.ipcMain.emit("open-chosen-any", {}, scenario.convertRootPath("c"));
      await conditionPromise(() => app.openPaths.callCount > 0);
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a _] [c _] [b _]");

      assert.strictEqual(app.promptForPath.callCount, 1);
      assert.strictEqual(app.promptForPath.lastCall.args[0], "all");

      // Open unrecognized directory in new window
      electron.ipcMain.emit("open-chosen-any", {}, scenario.convertRootPath("d"));
      await conditionPromise(() => app.openPaths.callCount > 1);
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a _] [c _] [b _] [d _]");

      assert.strictEqual(app.promptForPath.callCount, 2);
      assert.strictEqual(app.promptForPath.lastCall.args[0], "all");

      // Open recognized directory in existing window
      electron.ipcMain.emit("open-chosen-any", {}, scenario.convertRootPath("a"));
      await conditionPromise(() => app.openPaths.callCount > 2);
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a _] [c _] [b _] [d _]");

      assert.strictEqual(app.promptForPath.callCount, 3);
      assert.strictEqual(app.promptForPath.lastCall.args[0], "all");
    });

    it('"open-chosen-file" opens a file chooser and opens the chosen file in the sending window', async function () {
      sinon.stub(app, "lumineWindowForEvent").callsFake(() => w0);

      electron.ipcMain.emit("open-chosen-file", {}, scenario.convertEditorPath("b/2.md"));
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a 2.md] [_ _] [b _]");

      assert.isTrue(app.promptForPath.called);
      assert.strictEqual(app.promptForPath.lastCall.args[0], "file");
    });

    it('"open-chosen-folder" opens a directory chooser and opens the chosen directory', async function () {
      sinon.stub(app, "lumineWindowForEvent").callsFake(() => w0);

      electron.ipcMain.emit("open-chosen-folder", {}, scenario.convertRootPath("c"));
      await app.openPaths.lastCall.returnValue;
      await scenario.assert("[a _] [c _] [b _]");

      assert.isTrue(app.promptForPath.called);
      assert.strictEqual(app.promptForPath.lastCall.args[0], "folder");
    });
  });

  describe("window state serialization", function () {
    it("occurs immediately when adding a window", async function () {
      await scenario.launch(parseCommandLine(["a"]));

      const promise = emitterEventPromise(scenario.getApplication(0), "application:did-save-state");
      await scenario.open(parseCommandLine(["c", "b"]));
      await promise;

      assert.isTrue(
        scenario.getApplication(0).storageFolder.store.calledWith("application.json", {
          version: "1",
          windows: [
            { projectRoots: [scenario.convertRootPath("a")] },
            {
              projectRoots: [scenario.convertRootPath("b"), scenario.convertRootPath("c")],
            },
          ],
        }),
      );
    });

    it("occurs immediately when removing a window", async function () {
      await scenario.launch(parseCommandLine(["a"]));
      const w = await scenario.open(parseCommandLine(["b"]));

      const promise = emitterEventPromise(scenario.getApplication(0), "application:did-save-state");
      scenario.getApplication(0).removeWindow(w);
      await promise;

      assert.isTrue(
        scenario.getApplication(0).storageFolder.store.calledWith("application.json", {
          version: "1",
          windows: [{ projectRoots: [scenario.convertRootPath("a")] }],
        }),
      );
    });

    it("occurs when the window is blurred", async function () {
      const [w] = await scenario.launch(parseCommandLine(["a"]));
      const promise = emitterEventPromise(scenario.getApplication(0), "application:did-save-state");
      w.browserWindow.emit("blur");
      await promise;
    });
  });

  describe("reopening the focused window in development mode", function () {
    it("opens the same project in a loaded development window before closing the source", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine(["a"]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.prepareToUnload = sinon.stub().resolves(true);
      sinon.spy(sourceWindow, "close");

      const openedWindow = await app.reopenWindowInDevMode();

      assert.isTrue(sourceWindow.prepareToUnload.calledOnce);
      assert.isTrue(sourceWindow.close.calledOnce);
      assert.isTrue(openedWindow.devMode);
      assert.isFalse(openedWindow.safeMode);
      assert.deepEqual(openedWindow.projectRoots, [scenario.convertRootPath("a")]);
      assert.deepEqual(app.getAllWindows(), [openedWindow]);
    });

    it("replaces a window without project roots", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine([]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.prepareToUnload = sinon.stub().resolves(true);

      const openedWindow = await app.reopenWindowInDevMode();

      assert.isTrue(openedWindow.devMode);
      assert.deepEqual(openedWindow.projectRoots || [], []);
      assert.deepEqual(app.getAllWindows(), [openedWindow]);
    });

    it("waits for the replacement renderer to load before closing the source", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine(["a"]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.prepareToUnload = sinon.stub().resolves(true);
      sinon.spy(sourceWindow, "close");

      let resolveLoaded;
      const replacementWindow = {
        loadedPromise: new Promise((resolve) => {
          resolveLoaded = resolve;
        }),
      };
      sinon.stub(app, "openPaths").resolves(replacementWindow);

      const reopenPromise = app.reopenWindowInDevMode();
      await new Promise(process.nextTick);
      assert.isFalse(sourceWindow.close.called);

      resolveLoaded();
      assert.strictEqual(await reopenPromise, replacementWindow);
      assert.isTrue(sourceWindow.close.calledOnce);
      assert.isTrue(
        app.openPaths.calledWith({
          foldersToOpen: [scenario.convertRootPath("a")],
          newWindow: true,
          devMode: true,
          safeMode: false,
        }),
      );
    });

    it("keeps the source window open when unloading is cancelled", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine(["a"]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.prepareToUnload = sinon.stub().resolves(false);
      sinon.spy(sourceWindow, "close");
      sinon.spy(app, "openPaths");

      assert.isUndefined(await app.reopenWindowInDevMode());
      assert.isFalse(sourceWindow.close.called);
      assert.isFalse(app.openPaths.called);
      assert.isFalse(sourceWindow.unloading);
    });

    it("keeps the source usable when preparing to unload fails", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine(["a"]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.prepareToUnload = sinon.stub().rejects(new Error("prepare failed"));
      sinon.spy(app, "openPaths");
      sinon.stub(console, "error");

      assert.isUndefined(await app.reopenWindowInDevMode());
      assert.isFalse(app.openPaths.called);
      assert.isFalse(sourceWindow.unloading);
      assert.isTrue(
        console.error.calledWithMatch(
          "Failed to prepare the window for development mode",
          sinon.match.instanceOf(Error),
        ),
      );
    });

    it("reloads an existing development window instead of replacing it", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine(["--dev", "a"]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.reload = sinon.stub().resolves("reloaded");
      sinon.spy(app, "openPaths");

      assert.strictEqual(await app.reopenWindowInDevMode(), "reloaded");
      assert.isTrue(sourceWindow.reload.calledOnceWithExactly());
      assert.isFalse(app.openPaths.called);
    });

    it("reloads the source window if opening its replacement fails", async function () {
      const [sourceWindow] = await scenario.launch(parseCommandLine(["a"]));
      const app = scenario.getApplication(0);
      sourceWindow.isFocused.returns(true);
      sourceWindow.prepareToUnload = sinon.stub().resolves(true);
      sourceWindow.reload = sinon.stub().resolves();
      sinon.stub(app, "openPaths").rejects(new Error("opening failed"));
      sinon.stub(console, "error");

      assert.isUndefined(await app.reopenWindowInDevMode());
      assert.isTrue(sourceWindow.reload.calledOnceWithExactly({ skipPrepareToUnload: true }));
      assert.isFalse(sourceWindow.unloading);
      assert.isTrue(
        console.error.calledWithMatch(
          "Failed to reopen the window in development mode",
          sinon.match.instanceOf(Error),
        ),
      );
    });

    it("exposes the operation as an application command", async function () {
      const app = scenario.addApplication();
      sinon.stub(app, "reopenWindowInDevMode").resolves();

      app.emit("application:reopen-window-in-dev-mode");
      await new Promise(process.nextTick);

      assert.isTrue(app.reopenWindowInDevMode.calledOnce);
    });
  });

  describe("when closing the last window", function () {
    if (process.platform === "linux" || process.platform === "win32") {
      it("quits the application", async function () {
        const [w] = await scenario.launch(parseCommandLine(["a"]));
        scenario.getApplication(0).removeWindow(w);
        assert.isTrue(electron.app.quit.called);
      });
    } else if (process.platform === "darwin") {
      it("leaves the application open", async function () {
        const [w] = await scenario.launch(parseCommandLine(["a"]));
        scenario.getApplication(0).removeWindow(w);
        assert.isFalse(electron.app.quit.called);
      });
    }
  });

  describe("quitting", function () {
    it("waits until all windows have saved their state before quitting", async function () {
      const [w0] = await scenario.launch(parseCommandLine(["a"]));
      const w1 = await scenario.open(parseCommandLine(["b"]));
      assert.notStrictEqual(w0, w1);

      sinon.spy(w0, "close");
      let resolveUnload0;
      w0.prepareToUnload = () =>
        new Promise((resolve) => {
          resolveUnload0 = resolve;
        });

      sinon.spy(w1, "close");
      let resolveUnload1;
      w1.prepareToUnload = () =>
        new Promise((resolve) => {
          resolveUnload1 = resolve;
        });

      const evt = { preventDefault: sinon.spy() };
      electron.app.emit("before-quit", evt);
      await new Promise(process.nextTick);
      assert.isTrue(evt.preventDefault.called);
      assert.isFalse(electron.app.quit.called);

      resolveUnload1(true);
      await new Promise(process.nextTick);
      assert.isFalse(electron.app.quit.called);

      resolveUnload0(true);
      await scenario.getApplication(0).lastBeforeQuitPromise;
      assert.isTrue(electron.app.quit.called);

      assert.isTrue(w0.close.called);
      assert.isTrue(w1.close.called);
    });

    it("prevents a quit if a user cancels when prompted to save", async function () {
      const [w] = await scenario.launch(parseCommandLine(["a"]));
      let resolveUnload;
      w.prepareToUnload = () =>
        new Promise((resolve) => {
          resolveUnload = resolve;
        });

      const evt = { preventDefault: sinon.spy() };
      electron.app.emit("before-quit", evt);
      await new Promise(process.nextTick);
      assert.isTrue(evt.preventDefault.called);

      resolveUnload(false);
      await scenario.getApplication(0).lastBeforeQuitPromise;

      assert.isFalse(electron.app.quit.called);
    });

    it("closes successfully unloaded windows", async function () {
      const [w0] = await scenario.launch(parseCommandLine(["a"]));
      const w1 = await scenario.open(parseCommandLine(["b"]));

      sinon.spy(w0, "close");
      let resolveUnload0;
      w0.prepareToUnload = () =>
        new Promise((resolve) => {
          resolveUnload0 = resolve;
        });

      sinon.spy(w1, "close");
      let resolveUnload1;
      w1.prepareToUnload = () =>
        new Promise((resolve) => {
          resolveUnload1 = resolve;
        });

      const evt = { preventDefault() {} };
      electron.app.emit("before-quit", evt);

      resolveUnload0(false);
      resolveUnload1(true);

      await scenario.getApplication(0).lastBeforeQuitPromise;

      assert.isFalse(electron.app.quit.called);
      assert.isFalse(w0.close.called);
      assert.isTrue(w1.close.called);
    });
  });

  describe("clipboard requests", function () {
    // The renderer half of this lives in `src/clipboard-bridge.js`; Electron
    // deprecated its direct access to the clipboard, so every operation
    // arrives here by name instead.
    const handle = (method, ...args) =>
      LumineApplication.prototype.handleClipboardRequest(method, args);

    it("routes text operations through the Promise-based clipboard", async function () {
      const readText = sinon.stub(electron.clipboard, "readText").resolves("text");
      const writeText = sinon.stub(electron.clipboard, "writeText").resolves();

      assert.equal(await handle("readText"), "text");
      assert.deepEqual(readText.lastCall.args, []);

      await handle("writeText", "selection");
      assert.deepEqual(writeText.lastCall.args, ["selection"]);
    });

    it("carries images across the process boundary as PNG bytes", async function () {
      const png = Buffer.from("png image data");
      const read = sinon.stub(electron.clipboard, "read").resolves([
        {
          types: ["image/png"],
          getType: sinon.stub().resolves(new Blob([png], { type: "image/png" })),
        },
      ]);
      const write = sinon.stub(electron.clipboard, "write").resolves();

      assert.deepEqual(await handle("readImage"), png);
      assert.isTrue(read.calledOnce);

      // The renderer's Buffer arrives as a Uint8Array — structured clone knows
      // nothing of Node's subclass. Electron 44 accepts it as a Blob payload.
      await handle("writeImage", new Uint8Array(png));
      const [items] = write.lastCall.args;
      assert.equal(items.length, 1);
      const blob = await items[0].getType("image/png");
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
    });

    it("answers an unrecognised request with nothing", async function () {
      assert.isNull(await handle("readBookmark"));
    });
  });

  describe("starting a test run", function () {
    // `exit()` does not unwind the stack the way `process.exit()` is assumed
    // to, so a rejected test run has to return on its own. Before it did, the
    // messages below were printed and then buried under a type error raised by
    // the null they left behind.
    let app;

    beforeEach(function () {
      // The scenario stubs runner resolution out, since its temp project roots
      // have no package.json above them — that is exactly the case under test.
      app = scenario.addApplication({ devResourcePath: path.resolve(__dirname, "../..") });
      app.resolveTestRunnerPath.restore();
      sinon.stub(app, "exit");
      sinon.stub(process.stderr, "write");
    });

    it("reports a test path with no package.json above it", function () {
      const orphanPath = path.join(temp.mkdirSync("lumine-orphan-specs-"), "spec");

      assert.isNull(app.resolveTestRunnerPath(orphanPath));
      assert.isTrue(app.exit.calledWith(1));
      assert.match(process.stderr.write.lastCall.args[0], /Could not find a package\.json/);
    });

    it("reports a run with no test paths, and opens no window", function () {
      assert.isNull(
        app.runTests({
          headless: true,
          resourcePath: app.resourcePath,
          executedFrom: process.cwd(),
          pathsToOpen: [],
        }),
      );
      assert.isTrue(app.exit.calledWith(1));
      assert.match(process.stderr.write.lastCall.args[0], /Specify at least one test path/);
      assert.isFalse(app.createWindow.called);
    });

    it("resolves the default runner for a package that declares none", function () {
      const runnerPath = app.resolveTestRunnerPath(path.resolve(__dirname, "../../spec"));

      assert.isNotNull(runnerPath);
      assert.match(runnerPath, /jasmine-test-runner/);
      assert.isFalse(app.exit.called);
    });
  });
});

class StubWindow extends EventEmitter {
  constructor(sinon, loadSettings, options) {
    super();

    this.loadSettings = loadSettings;

    this._dimensions = Object.assign({}, loadSettings.windowDimensions) || {
      x: 100,
      y: 100,
    };
    this._position = { x: 0, y: 0 };
    this._locations = [];
    this._rootPaths = new Set();
    this._editorPaths = new Set();

    let resolveClosePromise;
    this.closedPromise = new Promise((resolve) => {
      resolveClosePromise = resolve;
    });

    this.minimize = sinon.spy();
    this.maximize = sinon.spy();
    this.center = sinon.spy();
    this.focus = sinon.spy();
    this.show = sinon.spy();
    this.hide = sinon.spy();
    this.prepareToUnload = sinon.spy();
    this.reload = sinon.stub().resolves();
    this.close = () => {
      // A real BrowserWindow emits "closed" when it closes. Emit it here too so
      // LumineApplication#addWindow's teardown runs and disposes per-window
      // subscriptions (e.g. the macOS scrollbar-style listener) rather than
      // leaking them onto the module-level emitter across tests.
      this.browserWindow.emit("closed");
      resolveClosePromise();
    };

    this.replaceEnvironment = sinon.spy();
    this.disableZoom = sinon.spy();

    this.isFocused = sinon
      .stub()
      .returns(options.isFocused !== undefined ? options.isFocused : false);
    this.isMinimized = sinon
      .stub()
      .returns(options.isMinimized !== undefined ? options.isMinimized : false);
    this.isMaximized = sinon
      .stub()
      .returns(options.isMaximized !== undefined ? options.isMaximized : false);

    this.sendURIMessage = sinon.spy();
    this.didChangeUserSettings = sinon.spy();
    this.didFailToReadUserSettings = sinon.spy();

    this.isSpec = loadSettings.isSpec !== undefined ? loadSettings.isSpec : false;
    this.devMode = loadSettings.devMode !== undefined ? loadSettings.devMode : false;
    this.safeMode = loadSettings.safeMode !== undefined ? loadSettings.safeMode : false;

    this.browserWindow = new EventEmitter();
    this.browserWindow.webContents = new EventEmitter();
    this.browserWindow.webContents.send = sinon.spy();
    // Broadcast handlers such as the scrollbar-style listener identify a window
    // by its `webContents` and then relay through `sendToRenderer`, so a stub
    // window needs both or those handlers throw when they fire against it.
    this.sendToRenderer = sinon.spy();

    const locationsToOpen = this.loadSettings.locationsToOpen || [];
    if (!(locationsToOpen.length === 1 && locationsToOpen[0].pathToOpen == null) && !this.isSpec) {
      this.openLocations(locationsToOpen);
    }
  }

  openPath(pathToOpen, initialLine, initialColumn) {
    return this.openLocations([{ pathToOpen, initialLine, initialColumn }]);
  }

  openLocations(locations) {
    this._locations.push(...locations);
    for (const location of locations) {
      if (location.pathToOpen) {
        if (location.isDirectory) {
          this._rootPaths.add(location.pathToOpen);
        } else if (location.isFile) {
          this._editorPaths.add(location.pathToOpen);
        }
      }
    }

    this.projectRoots = Array.from(this._rootPaths);
    this.projectRoots.sort();

    this.emit("window:locations-opened");
  }

  setSize(x, y) {
    this._dimensions = { x, y };
  }

  setPosition(x, y) {
    this._position = { x, y };
  }

  isSpecWindow() {
    return this.isSpec;
  }

  hasProjectPaths() {
    return this._rootPaths.size > 0;
  }

  containsLocations(locations) {
    return locations.every((location) => this.containsLocation(location));
  }

  containsLocation(location) {
    if (!location.pathToOpen) return false;

    return Array.from(this._rootPaths).some((projectPath) => {
      if (location.pathToOpen === projectPath) return true;
      if (location.pathToOpen.startsWith(path.join(projectPath, path.sep))) {
        if (!location.exists) return true;
        if (!location.isDirectory) return true;
      }
      return false;
    });
  }

  getDimensions() {
    return Object.assign({}, this._dimensions);
  }
}

class LaunchScenario {
  static async create(sandbox) {
    const scenario = new this(sandbox);
    await scenario.init();
    return scenario;
  }

  constructor(sandbox) {
    this.sinon = sandbox;

    this.applications = new Set();
    this.windows = new Set();
    this.root = null;
    this.lumineHome = null;
    this.projectRootPool = new Map();
    this.filePathPool = new Map();

    this.killedPids = [];
    this.originalLumineHome = null;
  }

  async init() {
    if (this.root !== null) {
      return this.root;
    }

    this.root = await new Promise((resolve, reject) => {
      temp.mkdir("launch-", (err, rootPath) => {
        if (err) {
          reject(err);
        } else {
          resolve(rootPath);
        }
      });
    });

    this.lumineHome = path.join(this.root, ".lumine");
    await new Promise((resolve, reject) => {
      fs.makeTree(this.lumineHome, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    this.originalLumineHome = process.env.LUMINE_HOME;
    process.env.LUMINE_HOME = this.lumineHome;

    await Promise.all(
      ["a", "b", "c", "d"].map(
        (dirPath) =>
          new Promise((resolve, reject) => {
            const fullDirPath = path.join(this.root, dirPath);
            fs.makeTree(fullDirPath, (err) => {
              if (err) {
                reject(err);
              } else {
                this.projectRootPool.set(dirPath, fullDirPath);
                resolve();
              }
            });
          }),
      ),
    );

    await Promise.all(
      ["a/1.md", "b/2.md"].map(
        (filePath) =>
          new Promise((resolve, reject) => {
            const fullFilePath = path.join(this.root, filePath);
            fs.writeFile(fullFilePath, `file: ${filePath}\n`, { encoding: "utf8" }, (err) => {
              if (err) {
                reject(err);
              } else {
                this.filePathPool.set(filePath, fullFilePath);
                this.filePathPool.set(path.basename(filePath), fullFilePath);
                resolve();
              }
            });
          }),
      ),
    );

    this.sinon.stub(electron.app, "quit");
  }

  async preconditions(source) {
    const app = this.addApplication();

    for (const windowSpec of this.parseWindowSpecs(source)) {
      // Construct the requested starting layout directly. Using openPaths()
      // here made the fixture depend on the routing behavior its specs verify,
      // and cannot represent an empty window followed by an occupied one now
      // that new-window requests deliberately claim compatible empty windows.
      const locationsToOpen = [
        ...windowSpec.roots.map((pathToOpen) => ({
          pathToOpen,
          initialLine: null,
          initialColumn: null,
          exists: true,
          isDirectory: true,
          isFile: false,
        })),
        ...windowSpec.editors.map((pathToOpen) => ({
          pathToOpen,
          initialLine: null,
          initialColumn: null,
          exists: true,
          isDirectory: false,
          isFile: true,
        })),
      ];
      const window = app.createWindow({ locationsToOpen });
      app.addWindow(window);
    }
  }

  launch(options) {
    const app = options.app || this.addApplication();
    delete options.app;

    if (options.pathsToOpen) {
      options.pathsToOpen = this.convertPaths(options.pathsToOpen);
    }

    return app.launch(options);
  }

  open(options) {
    if (this.applications.size === 0) {
      return this.launch(options);
    }

    let app = options.app;
    if (!app) {
      const apps = Array.from(this.applications);
      app = apps[apps.length - 1];
    } else {
      delete options.app;
    }

    if (options.pathsToOpen) {
      options.pathsToOpen = this.convertPaths(options.pathsToOpen);
    }
    options.preserveFocus = true;

    return app.openWithOptions(options);
  }

  async assert(source) {
    const windowSpecs = this.parseWindowSpecs(source);
    let specIndex = 0;

    const windowPromises = [];
    for (const window of this.windows) {
      windowPromises.push(
        (async (theWindow, theSpec) => {
          const { _rootPaths: rootPaths, _editorPaths: editorPaths } = theWindow;

          const comparison = {
            ok: true,
            extraWindow: false,
            missingWindow: false,
            extraRoots: [],
            missingRoots: [],
            extraEditors: [],
            missingEditors: [],
            roots: rootPaths,
            editors: editorPaths,
          };

          if (!theSpec) {
            comparison.ok = false;
            comparison.extraWindow = true;
            comparison.extraRoots = rootPaths;
            comparison.extraEditors = editorPaths;
          } else {
            const [missingRoots, extraRoots] = this.compareSets(theSpec.roots, rootPaths);
            const [missingEditors, extraEditors] = this.compareSets(theSpec.editors, editorPaths);

            comparison.ok =
              missingRoots.length === 0 &&
              extraRoots.length === 0 &&
              missingEditors.length === 0 &&
              extraEditors.length === 0;
            comparison.extraRoots = extraRoots;
            comparison.missingRoots = missingRoots;
            comparison.extraEditors = extraEditors;
            comparison.missingEditors = missingEditors;
          }

          return comparison;
        })(window, windowSpecs[specIndex++]),
      );
    }

    const comparisons = await Promise.all(windowPromises);
    for (; specIndex < windowSpecs.length; specIndex++) {
      const spec = windowSpecs[specIndex];
      comparisons.push({
        ok: false,
        extraWindow: false,
        missingWindow: true,
        extraRoots: [],
        missingRoots: spec.roots,
        extraEditors: [],
        missingEditors: spec.editors,
        roots: null,
        editors: null,
      });
    }

    const shorthandParts = [];
    const descriptionParts = [];
    for (const comparison of comparisons) {
      if (comparison.roots !== null && comparison.editors !== null) {
        const shortRoots = Array.from(comparison.roots, (r) => path.basename(r)).join(",");
        const shortPaths = Array.from(comparison.editors, (e) => path.basename(e)).join(",");
        shorthandParts.push(`[${shortRoots} ${shortPaths}]`);
      }

      if (comparison.ok) {
        continue;
      }

      let parts = [];
      if (comparison.extraWindow) {
        parts.push("extra window\n");
      } else if (comparison.missingWindow) {
        parts.push("missing window\n");
      } else {
        parts.push("incorrect window\n");
      }

      const shorten = (fullPaths) =>
        fullPaths.map((fullPath) => path.basename(fullPath)).join(", ");

      if (comparison.extraRoots.length > 0) {
        parts.push(`* extra roots ${shorten(comparison.extraRoots)}\n`);
      }
      if (comparison.missingRoots.length > 0) {
        parts.push(`* missing roots ${shorten(comparison.missingRoots)}\n`);
      }
      if (comparison.extraEditors.length > 0) {
        parts.push(`* extra editors ${shorten(comparison.extraEditors)}\n`);
      }
      if (comparison.missingEditors.length > 0) {
        parts.push(`* missing editors ${shorten(comparison.missingEditors)}\n`);
      }

      descriptionParts.push(parts.join(""));
    }

    if (descriptionParts.length !== 0) {
      descriptionParts.unshift(shorthandParts.join(" ") + "\n");
      descriptionParts.unshift("Launched windows did not match spec\n");
    }

    assert.isTrue(descriptionParts.length === 0, descriptionParts.join(""));
  }

  async destroy() {
    await Promise.all(Array.from(this.applications, (app) => app.destroy()));

    if (this.originalLumineHome) {
      process.env.LUMINE_HOME = this.originalLumineHome;
    }
  }

  addApplication(options = {}) {
    const app = new LumineApplication({
      resourcePath: path.resolve(__dirname, "../.."),
      lumineHomeDirPath: this.lumineHome,
      preserveFocus: true,
      killProcess: (pid) => {
        this.killedPids.push(pid);
      },
      ...options,
    });
    this.sinon.stub(app, "createWindow").callsFake((loadSettings) => {
      const newWindow = new StubWindow(this.sinon, loadSettings, options);
      this.windows.add(newWindow);
      return newWindow;
    });
    // A `--test` window normally resolves a real on-disk test runner and calls
    // `process.exit(1)` when it can't find a `package.json` root. The scenario's
    // temp project roots have none, so short-circuit resolution; these tests
    // only care about how spec windows sit alongside regular windows.
    this.sinon.stub(app, "resolveTestRunnerPath").callsFake((testPath) => testPath);
    this.sinon
      .stub(app.storageFolder, "load")
      .callsFake(() => Promise.resolve(options.applicationJson || { version: "1", windows: [] }));
    this.sinon.stub(app.storageFolder, "store").callsFake(() => Promise.resolve());
    this.applications.add(app);
    return app;
  }

  getApplication(index) {
    const app = Array.from(this.applications)[index];
    if (!app) {
      throw new Error(`Application ${index} does not exist`);
    }
    return app;
  }

  getWindow(index) {
    const window = Array.from(this.windows)[index];
    if (!window) {
      throw new Error(`Window ${index} does not exist`);
    }
    return window;
  }

  compareSets(expected, actual) {
    const expectedItems = new Set(expected);
    const extra = [];
    const missing = [];

    for (const actualItem of actual) {
      if (!expectedItems.delete(actualItem)) {
        // actualItem was present, but not expected
        extra.push(actualItem);
      }
    }
    for (const remainingItem of expectedItems) {
      // remainingItem was expected, but not present
      missing.push(remainingItem);
    }
    return [missing, extra];
  }

  convertRootPath(shortRootPath) {
    if (shortRootPath.startsWith("lumine://") || shortRootPath.startsWith("remote://")) {
      return shortRootPath;
    }

    const fullRootPath = this.projectRootPool.get(shortRootPath);
    if (!fullRootPath) {
      throw new Error(`Unexpected short project root path: ${shortRootPath}`);
    }
    return fullRootPath;
  }

  convertEditorPath(shortEditorPath) {
    const [truncatedPath, ...suffix] = shortEditorPath.split(/(?=:)/);
    const fullEditorPath = this.filePathPool.get(truncatedPath);
    if (!fullEditorPath) {
      throw new Error(`Unexpected short editor path: ${shortEditorPath}`);
    }
    return fullEditorPath + suffix.join("");
  }

  convertPaths(paths) {
    return paths.map((shortPath) => {
      if (shortPath.startsWith("lumine://") || shortPath.startsWith("remote://")) {
        return shortPath;
      }

      const fullRoot = this.projectRootPool.get(shortPath);
      if (fullRoot) {
        return fullRoot;
      }

      const [truncatedPath, ...suffix] = shortPath.split(/(?=:)/);
      const fullEditor = this.filePathPool.get(truncatedPath);
      if (fullEditor) {
        return fullEditor + suffix.join("");
      }

      throw new Error(`Unexpected short path: ${shortPath}`);
    });
  }

  parseWindowSpecs(source) {
    const specs = [];

    const rx = /\s*\[(?:_|(\S+)) (?:_|(\S+))\]/g;
    let match = rx.exec(source);

    while (match) {
      const roots = match[1]
        ? match[1].split(",").map((shortPath) => this.convertRootPath(shortPath))
        : [];
      const editors = match[2]
        ? match[2].split(",").map((shortPath) => this.convertEditorPath(shortPath))
        : [];
      specs.push({ roots, editors });

      match = rx.exec(source);
    }

    return specs;
  }
}
