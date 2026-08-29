/* globals assert */

const path = require("path");
const nodeFs = require("fs");
const os = require("os");
const fs = require("@lumine-code/fs-plus");
const url = require("url");
const { EventEmitter } = require("events");
const sandbox = require("sinon").createSandbox();
const dedent = require("dedent");
const { BrowserWindow, dialog, webContents } = require("electron");

const LumineWindow = require("../../src/lumine-window");
const { emitterEventPromise, conditionPromise } = require("../helpers/async-spec-helpers");

describe("LumineWindow", function () {
  let sinon, app, service;

  beforeEach(function () {
    sinon = sandbox;
    app = new StubApplication(sinon);
    service = new StubRecoveryService(sinon);
  });

  afterEach(function () {
    sinon.restore();
  });

  describe("creating a real window", function () {
    let resourcePath, windowInitializationScript, lumineHome, browserWindow;
    let original;

    beforeEach(async function () {
      original = {
        LUMINE_HOME: process.env.LUMINE_HOME,
        LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT:
          process.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT,
      };

      resourcePath = path.resolve(__dirname, "../..");

      windowInitializationScript = require.resolve(
        path.join(resourcePath, "src/initialize-application-window"),
      );

      lumineHome = await nodeFs.promises.mkdtemp(path.join(os.tmpdir(), "launch-"));

      await new Promise((resolve, reject) => {
        const config = dedent`
          '*':
            about:
              showOnStartup: false
        `;

        fs.writeFile(path.join(lumineHome, "config.cson"), config, { encoding: "utf8" }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      process.env.LUMINE_HOME = lumineHome;
      process.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT = "true";
    });

    afterEach(async function () {
      // Unload the editor first — it flushes state to LUMINE_HOME — then take
      // the renderer down, so the watcher and storage handles it holds under
      // that directory are released before the rm below has to fight them.
      // Destroying the runner's last window is safe: the main-process test
      // bootstrap subscribes `window-all-closed`, so Electron's default
      // quit-on-last-window cannot take the runner down mid-suite.
      if (browserWindow && !browserWindow.isDestroyed()) {
        await browserWindow.webContents.executeJavaScript("lumine.prepareToUnloadEditorWindow()");
        browserWindow.destroy();
      }
      process.env.LUMINE_HOME = original.LUMINE_HOME;
      process.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT =
        original.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT;
      if (lumineHome) {
        // The renderer is gone, but the OS releases a dead process's handles
        // asynchronously — on Windows especially — so retry rather than wait
        // a fixed grace.
        await nodeFs.promises.rm(lumineHome, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      }
    });

    it("creates a real, properly configured BrowserWindow", async function () {
      const w = new LumineWindow(app, service, {
        resourcePath,
        windowInitializationScript,
        headless: true,
        extra: "extra-load-setting",
      });
      ({ browserWindow } = w);

      assert.isFalse(browserWindow.isVisible());
      assert.isTrue(browserWindow.getTitle().startsWith("Lumine"));

      const settings = w.getLoadSettingsForRenderer();
      assert.strictEqual(settings.userSettings, "stub-config");
      assert.strictEqual(settings.extra, "extra-load-setting");
      assert.strictEqual(settings.resourcePath, resourcePath);
      assert.strictEqual(settings.lumineHome, lumineHome);
      assert.isFalse(settings.devMode);
      assert.isFalse(settings.safeMode);
      assert.isFalse(settings.clearWindowState);

      await emitterEventPromise(browserWindow, "ready-to-show");
      await w.getLoadedPromise();

      assert.strictEqual(
        browserWindow.webContents.getURL(),
        url.format({
          protocol: "file",
          pathname: `${resourcePath.replace(/\\/g, "/")}/static/index.html`,
          slashes: true,
        }),
      );
    });

    it("moves one pane item into a same-renderer detached window and attaches it back", async function () {
      const w = new LumineWindow(app, service, {
        resourcePath,
        windowInitializationScript,
        headless: true,
      });
      ({ browserWindow } = w);
      await w.getLoadedPromise();

      const detached = await browserWindow.webContents.executeJavaScript(
        `
        (async () => {
          lumine.initializeDetachedPaneSurfaces({force: true});
          const item = await lumine.workspace.open(null);
          const tiledPane = lumine.workspace.paneForItem(item);
          const pane = await lumine.workspace.detachPaneItem(item, {show: false});
          const surface = lumine.workspace.getWindowSurface(pane);
          const realmScriptLoads = await lumine.dom.loadScript(
            surface.document,
            ${JSON.stringify(path.join(resourcePath, "spec", "fixtures", "realm-script.js"))},
            {global: "__realmScriptLoads"},
          );
          const modalItem = document.createElement("div");
          const modal = lumine.workspace.addModalPanel({item: modalItem, owner: item});
          const modalInChild = modal.getElement().ownerDocument === surface.document;
          modal.destroy();
          const list = lumine.workspace.buildSelectList({
            owner: item,
            items: [{name: "One"}],
            filterKeyForItem: ({name}) => name,
            elementForItem: ({name}) => ({primary: name}),
          });
          list.show();
          const selectListInChild = list.getPanel().getElement().ownerDocument === surface.document;
          list.destroy();
          window.__detachedPaneIntegration = {item, pane, tiledPane};
          return {
            surfaceId: surface.id,
            sameItem: pane.getActiveItem() === item,
            belongsToCenter: pane.getContainer().getLocation() === "center",
            outsideTiledTree: !lumine.workspace.getCenter().getTiledPanes().includes(pane),
            otherDocument: surface.document !== document,
            mountedInChild: surface.document.contains(lumine.views.getView(item)),
            modalInChild,
            selectListInChild,
            stylesMounted: surface.document.head.querySelectorAll("style").length > 0,
            realmScriptLoads,
          };
        })()
      `,
        true,
      );

      assert.isTrue(detached.sameItem);
      assert.isTrue(detached.belongsToCenter);
      assert.isTrue(detached.outsideTiledTree);
      assert.isTrue(detached.otherDocument);
      assert.isTrue(detached.mountedInChild);
      assert.isTrue(detached.modalInChild);
      assert.isTrue(detached.selectListInChild);
      assert.isTrue(detached.stylesMounted);
      assert.strictEqual(detached.realmScriptLoads, 1);
      const nativeSurface = w.detachedPaneWindows.surfaces.get(detached.surfaceId);
      assert.isDefined(nativeSurface);
      assert.isFalse(nativeSurface.browserWindow.isVisible());
      assert.strictEqual(
        nativeSurface.browserWindow.webContents.getOSProcessId(),
        browserWindow.webContents.getOSProcessId(),
      );

      const attached = await browserWindow.webContents.executeJavaScript(`
        (async () => {
          const {item, pane, tiledPane} = window.__detachedPaneIntegration;
          const targetPromise = new Promise((resolve) => {
            const subscription = lumine.workspace.getCenter().onDidAttachPane(({targetPane}) => {
              subscription.dispose();
              resolve(targetPane);
            });
          });
          lumine.workspace.getWindowSurface(pane).attachButton.click();
          const target = await targetPromise;
          delete window.__detachedPaneIntegration;
          return {
            targetRestored: target === tiledPane,
            sameItem: target.getActiveItem() === item,
            primaryDocument: lumine.views.getView(item).ownerDocument === document,
          };
        })()
      `);
      assert.deepEqual(attached, {
        targetRestored: true,
        sameItem: true,
        primaryDocument: true,
      });
      await conditionPromise(() => w.detachedPaneWindows.surfaces.size === 0);

      const webgl = await browserWindow.webContents.executeJavaScript(`
        (async () => {
          const element = document.createElement("div");
          const canvas = document.createElement("canvas");
          element.appendChild(canvas);
          const context = canvas.getContext("webgl2");
          if (!context) return {supported: false};
          const item = {
            element,
            getTitle: () => "Detached WebGL test",
          };
          await lumine.workspace.open(item);
          const pane = await lumine.workspace.detachPaneItem(item, {show: false});
          const contextInChild = canvas.getContext("webgl2");
          const preservedInChild = contextInChild === context && !context.isContextLost();
          await lumine.workspace.attachDetachedPane(pane);
          return {
            supported: true,
            preservedInChild,
            preservedAfterAttach: canvas.getContext("webgl2") === context && !context.isContextLost(),
          };
        })()
      `);
      if (webgl.supported) {
        assert.isTrue(webgl.preservedInChild);
        assert.isTrue(webgl.preservedAfterAttach);
      }
      await conditionPromise(() => w.detachedPaneWindows.surfaces.size === 0);

      const recoverySurfaceId = await browserWindow.webContents.executeJavaScript(`
        (async () => {
          let resolveRecovery;
          const recovered = new Promise((resolve) => { resolveRecovery = resolve; });
          const order = [];
          let commitResult;
          const item = {
            element: document.createElement("div"),
            getTitle: () => "Recovery transition test",
            beginWindowSurfaceTransition(context) {
              if (context.reason !== "recovery") return;
              return {
                commit() {
                  order.push("commit");
                  commitResult = {
                    reason: context.reason,
                    primaryDocument: item.element.ownerDocument === document,
                    connected: item.element.isConnected,
                  };
                },
              };
            },
          };
          await lumine.workspace.open(item);
          const pane = await lumine.workspace.detachPaneItem(item, {show: false});
          const surface = lumine.workspace.getWindowSurface(item);
          let subscription;
          subscription = lumine.workspace.observePaneItemSurface(item, (nextSurface) => {
            if (nextSurface?.kind !== "primary") return;
            order.push("change");
            resolveRecovery({...commitResult, order});
            subscription?.dispose();
          });
          window.__recoveryTransition = {item, pane, recovered, subscription};
          return surface.id;
        })()
      `);
      w.detachedPaneWindows.surfaces.get(recoverySurfaceId).browserWindow.destroy();
      const recovered = await browserWindow.webContents.executeJavaScript(`
        (async () => {
          const {item, recovered} = window.__recoveryTransition;
          const result = await recovered;
          result.detached = lumine.workspace.paneForItem(item).isDetached();
          delete window.__recoveryTransition;
          return result;
        })()
      `);
      assert.deepEqual(recovered, {
        reason: "recovery",
        primaryDocument: true,
        connected: true,
        order: ["commit", "change"],
        detached: false,
      });
      await conditionPromise(() => w.detachedPaneWindows.surfaces.size === 0);
    });
  });

  describe("launch behavior", function () {
    it("sets the Lumine window icon for source launches on Windows", function () {
      const { browserWindow } = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });

      if (process.platform === "win32" && process.defaultApp) {
        assert.isDefined(browserWindow.options.icon);
        assert.isFalse(browserWindow.options.icon.isEmpty());
      }
    });

    it('sets frame to "false" for a hidden title bar on non-spec windows', function () {
      app.config["core.titleBar"] = "hidden";

      const { browserWindow: w0 } = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      assert.isFalse(w0.options.frame);

      const { browserWindow: w1 } = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        isSpec: true,
      });
      assert.isUndefined(w1.options.frame);
    });

    it("opens initial locations", async function () {
      const locationsToOpen = [
        {
          pathToOpen: "file.txt",
          initialLine: 1,
          initialColumn: 2,
          isDirectory: false,
          hasWaitSession: false,
        },
        {
          pathToOpen: "/directory",
          initialLine: null,
          initialColumn: null,
          isDirectory: true,
          hasWaitSession: false,
        },
      ];

      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });
      assert.deepEqual(w.projectRoots, ["/directory"]);

      const loadPromise = emitterEventPromise(w, "window:loaded");
      w.browserWindow.emit("window:loaded");
      await loadPromise;

      assert.deepEqual(w.browserWindow.sent, [["message", "open-locations", locationsToOpen]]);
    });

    it("does not open an initial null location", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen: [{ pathToOpen: null }],
      });

      const loadPromise = emitterEventPromise(w, "window:loaded");
      w.browserWindow.emit("window:loaded");
      await loadPromise;

      assert.lengthOf(w.browserWindow.sent, 0);
    });

    it("does not open initial locations in spec mode", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen: [{ pathToOpen: "file.txt" }],
        isSpec: true,
      });

      const loadPromise = emitterEventPromise(w, "window:loaded");
      w.browserWindow.emit("window:loaded");
      await loadPromise;

      assert.lengthOf(w.browserWindow.sent, 0);
    });

    it("focuses the webView for specs", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        isSpec: true,
      });

      assert.isTrue(w.browserWindow.behavior.focusOnWebView);
    });
  });

  describe("sendToRenderer", function () {
    it("relays window state events to the renderer", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });

      w.browserWindow.emit("focus");
      w.browserWindow.emit("blur");

      assert.deepEqual(w.browserWindow.sent, [["did-focus-window"], ["did-blur-window"]]);
    });

    it("drops messages once the window or its renderer is gone", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.browserWindow.destroy();

      w.browserWindow.emit("focus");
      w.browserWindow.emit("blur");
      w.sendMessage("some-message");

      assert.lengthOf(w.browserWindow.sent, 0);
    });

    // The window and its webContents both outlive the renderer's main frame, so
    // these two are the only signal that there is nothing left to send to.
    it("drops messages once the main frame is disposed", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.browserWindow.webContents.mainFrame.destroyed = true;

      w.browserWindow.emit("blur");
      w.sendMessage("some-message");

      assert.lengthOf(w.browserWindow.sent, 0);
    });

    // A crashed-then-reloaded renderer (Windows hibernation resume does this)
    // can leave the live page's main-frame wrapper flagged `detached` for the
    // rest of the session. That flag must never gate sending: trusting it
    // silently voids every main→renderer message for an otherwise healthy
    // window — the whole File menu, drag-and-drop, and the Open dialog.
    it("still delivers messages when the main frame is merely detached", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.browserWindow.webContents.mainFrame.detached = true;

      w.sendMessage("some-message");

      assert.deepEqual(w.browserWindow.sent, [["message", "some-message", undefined]]);
    });
  });

  describe("render-process-gone", function () {
    let showMessageBox;

    beforeEach(function () {
      showMessageBox = sinon.stub(dialog, "showMessageBox").resolves({ response: 2 });
    });

    function goneWith(w, reason, exitCode = 0) {
      w.browserWindow.webContents.emit("render-process-gone", {}, { reason, exitCode });
      // The handler is async; let its first awaits settle.
      return new Promise((resolve) => setImmediate(resolve));
    }

    // Electron reports an ordinary renderer exit here too. Treating those as
    // crashes is what makes "The editor has crashed" appear on a normal quit
    // or restart.
    it("stays quiet when the renderer merely exited or was killed", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });

      await goneWith(w, "clean-exit");
      await goneWith(w, "killed");

      assert.isFalse(showMessageBox.called);
      assert.isFalse(service.didCrashWindow.called);
    });

    it("does not fail a headless run for an ordinary renderer departure", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        headless: true,
      });

      await goneWith(w, "clean-exit");
      await goneWith(w, "killed");

      assert.isFalse(app.exit.called);
      assert.isFalse(showMessageBox.called);
      assert.isFalse(service.didCrashWindow.called);
    });

    it("fails a headless run when its renderer crashes", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        headless: true,
      });

      await goneWith(w, "crashed", 133);

      assert.isTrue(app.exit.calledOnceWithExactly(100));
      assert.isFalse(showMessageBox.called);
      assert.isFalse(service.didCrashWindow.called);
    });

    it("reports a real crash", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });

      await goneWith(w, "crashed", 133);

      assert.isTrue(service.didCrashWindow.calledWith(w));
      assert.isTrue(showMessageBox.calledOnce);
      const { message, detail } = showMessageBox.firstCall.args[1];
      assert.strictEqual(message, "The editor has crashed");
      // The reason and exit code are the whole diagnosis for a crash that
      // leaves no dump, so they belong in front of the user.
      assert.include(detail, "crashed");
      assert.include(detail, "133");
    });

    it("does not interrupt a window that is already unloading", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        headless: true,
      });
      w.unloading = true;

      await goneWith(w, "crashed", 1);

      assert.isFalse(app.exit.called);
      assert.isFalse(showMessageBox.called);
    });

    it("does not interrupt a quit in progress", async function () {
      app.quitting = true;
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        headless: true,
      });

      await goneWith(w, "crashed", 1);

      assert.isFalse(app.exit.called);
      assert.isFalse(showMessageBox.called);
    });
  });

  describe("reload", function () {
    // A reload unloads exactly like a close does, deactivation included, so a
    // package tears down while the environment it is tearing down from is still
    // whole. `Environment` bounds the wait so one that never finishes
    // cannot hold the reload.
    it("prepares to unload the same way a close does", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.prepareToUnload = sinon.stub().resolves(true);

      w.reload();
      await Promise.resolve();

      assert.isTrue(w.prepareToUnload.calledOnceWithExactly());
      assert.isTrue(w.browserWindow.behavior.reloaded);
    });

    it("can reload directly when a replacement window failed after unloading", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.prepareToUnload = sinon.stub().resolves(true);

      w.reload({ skipPrepareToUnload: true });
      await Promise.resolve();

      assert.isFalse(w.prepareToUnload.called);
      assert.isTrue(w.browserWindow.behavior.reloaded);
    });

    it("leaves paths openable when the renderer refuses to unload", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.resolveLoadedPromise();
      w.prepareToUnload = sinon.stub().resolves(false);

      await w.reload();
      assert.isFalse(w.browserWindow.behavior.reloaded);

      // A refused reload must not swap in a fresh loaded promise: nothing but a
      // `window:loaded` event can settle one, so leaving it pending wedges every
      // path that opens a location in this window.
      const outcome = await Promise.race([
        w.openPath(path.join("/", "some", "file")).then(() => "opened"),
        new Promise((resolve) => setImmediate(() => resolve("hung"))),
      ]);

      assert.equal(outcome, "opened");
      assert.equal(w.browserWindow.sent.at(-1)[1], "open-locations");
    });
  });

  describe("isWebViewFocused", function () {
    it("returns false when no web contents are focused", function () {
      sinon.stub(webContents, "getFocusedWebContents").returns(null);

      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });

      assert.isFalse(w.isWebViewFocused());
    });

    it("returns true when this window's web contents are focused", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      sinon.stub(webContents, "getFocusedWebContents").returns(w.browserWindow.webContents);

      assert.isTrue(w.isWebViewFocused());
    });

    it("returns true when a webview owned by this window is focused", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      const focusedWebContents = {
        hostWebContents: w.browserWindow.webContents,
      };
      sinon.stub(webContents, "getFocusedWebContents").returns(focusedWebContents);

      assert.isTrue(w.isWebViewFocused());
    });

    it("returns false when another window owns the focused web contents", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      const otherWindow = new StubBrowserWindow({});
      const focusedWebContents = otherWindow.webContents;
      sinon.stub(webContents, "getFocusedWebContents").returns(focusedWebContents);
      sinon.stub(BrowserWindow, "fromWebContents").returns(otherWindow);

      assert.isFalse(w.isWebViewFocused());
    });
  });

  describe("project root tracking", function () {
    it("knows when it has no roots", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      assert.isFalse(w.hasProjectPaths());
    });

    it("is initialized from directories in the initial locationsToOpen", function () {
      const locationsToOpen = [
        { pathToOpen: "file.txt", exists: true, isFile: true },
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
        { pathToOpen: "new-file.txt" },
        { pathToOpen: null },
      ];

      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });

      assert.deepEqual(w.projectRoots, ["directory0", "directory1"]);
      assert.isTrue(w.loadSettings.hasOpenFiles);
      assert.deepEqual(w.loadSettings.initialProjectRoots, ["directory0", "directory1"]);
      assert.isTrue(w.hasProjectPaths());
    });

    it("is updated synchronously by openLocations", async function () {
      const locationsToOpen = [
        { pathToOpen: "file.txt", isFile: true },
        { pathToOpen: "directory1", isDirectory: true },
        { pathToOpen: "directory0", isDirectory: true },
        { pathToOpen: "directory0", isDirectory: true },
        { pathToOpen: "new-file.txt" },
      ];

      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      assert.deepEqual(w.projectRoots, []);

      const promise = w.openLocations(locationsToOpen);
      assert.deepEqual(w.projectRoots, ["directory0", "directory1"]);
      w.resolveLoadedPromise();
      await promise;
    });

    it("is updated by setProjectRoots", function () {
      const locationsToOpen = [{ pathToOpen: "directory0", exists: true, isDirectory: true }];

      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });
      assert.deepEqual(w.projectRoots, ["directory0"]);
      assert.deepEqual(w.loadSettings.initialProjectRoots, ["directory0"]);

      w.setProjectRoots(["directory1", "directory0", "directory2"]);
      assert.deepEqual(w.projectRoots, ["directory0", "directory1", "directory2"]);
      assert.deepEqual(w.loadSettings.initialProjectRoots, [
        "directory0",
        "directory1",
        "directory2",
      ]);
    });

    it("never reports that it owns the empty path", function () {
      const locationsToOpen = [
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
        { pathToOpen: null },
      ];

      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });
      assert.isFalse(w.containsLocation({ pathToOpen: null }));
    });

    it("discovers an exact path match", function () {
      const locationsToOpen = [
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
      ];
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });

      assert.isTrue(w.containsLocation({ pathToOpen: "directory0" }));
      assert.isFalse(w.containsLocation({ pathToOpen: "directory2" }));
    });

    it("discovers the path of a file within any project root", function () {
      const locationsToOpen = [
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
      ];
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });

      assert.isTrue(
        w.containsLocation({
          pathToOpen: path.join("directory0/file-0.txt"),
          exists: true,
          isFile: true,
        }),
      );
      assert.isTrue(
        w.containsLocation({
          pathToOpen: path.join("directory0/deep/file-0.txt"),
          exists: true,
          isFile: true,
        }),
      );
      assert.isFalse(
        w.containsLocation({
          pathToOpen: path.join("directory2/file-9.txt"),
          exists: true,
          isFile: true,
        }),
      );
      assert.isFalse(
        w.containsLocation({
          pathToOpen: path.join("directory2/deep/file-9.txt"),
          exists: true,
          isFile: true,
        }),
      );
    });

    it("reports that it owns nonexistent paths within a project root", function () {
      const locationsToOpen = [
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
      ];
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });

      assert.isTrue(
        w.containsLocation({
          pathToOpen: path.join("directory0/file-1.txt"),
          exists: false,
        }),
      );
      assert.isTrue(
        w.containsLocation({
          pathToOpen: path.join("directory1/subdir/file-0.txt"),
          exists: false,
        }),
      );
    });

    it("never reports that it owns directories within a project root", function () {
      const locationsToOpen = [
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
      ];
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });

      assert.isFalse(
        w.containsLocation({
          pathToOpen: path.join("directory0/subdir-0"),
          exists: true,
          isDirectory: true,
        }),
      );
    });

    it("checks a full list of paths and reports if it owns all of them", function () {
      const locationsToOpen = [
        { pathToOpen: "directory0", exists: true, isDirectory: true },
        { pathToOpen: "directory1", exists: true, isDirectory: true },
      ];
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen,
      });

      assert.isTrue(
        w.containsLocations([
          { pathToOpen: "directory0" },
          {
            pathToOpen: path.join("directory1/file-0.txt"),
            exists: true,
            isFile: true,
          },
        ]),
      );
      assert.isFalse(
        w.containsLocations([{ pathToOpen: "directory2" }, { pathToOpen: "directory0" }]),
      );
      assert.isFalse(
        w.containsLocations([{ pathToOpen: "directory2" }, { pathToOpen: "directory1" }]),
      );
    });
  });
});

class StubApplication {
  constructor(sinon) {
    this.config = {
      "core.titleBar": "hidden",
      get: (key) => this.config[key] || null,
    };
    this.configFile = {
      path: "stub-config-path",
      get() {
        return "stub-config";
      },
    };

    this.removeWindow = sinon.spy();
    this.saveCurrentWindowOptions = sinon.spy();
    this.exit = sinon.spy();
    this.windows = [];
  }

  registerLumineWindow(lumineWindow) {
    this.windows.push(lumineWindow);
    global.lumineApplication = this;
  }

  lumineWindowForSender(sender) {
    const lumineWindow = this.windows.find((window) => window.browserWindow.webContents === sender);
    if (!lumineWindow) throw new Error("IPC sender is not a registered Lumine window");
    return lumineWindow;
  }

  getAllWindows() {
    return this.windows.slice();
  }
}

class StubRecoveryService {
  constructor(sinon) {
    this.didCloseWindow = sinon.spy();
    this.didCrashWindow = sinon.spy();
  }
}

class StubBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.destroyed = false;
    this.behavior = {
      focusOnWebView: false,
      reloaded: false,
    };

    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = (handler) => {
      this.webContents.windowOpenHandler = handler;
    };
    this.webContents.setVisualZoomLevelLimits = () => {};
    this.webContents.isDestroyed = () => this.destroyed;
    this.webContents.send = (...args) => {
      this.sent.push(args);
    };
    // IPC is gated on the main frame's liveness even though it leaves through
    // `webContents.send`: a disposed render frame outlives both `isDestroyed()`
    // checks above, so `mainFrame.isDestroyed()` is the only place LumineWindow
    // can tell there is no renderer left to send to. Its `detached` flag is
    // NOT part of that gate — it can stay stale-true on a healthy window after
    // a crash-and-reload.
    this.webContents.mainFrame = {
      detached: false,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
    };
  }

  loadURL() {}

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }

  reload() {
    this.behavior.reloaded = true;
  }

  focusOnWebView() {
    this.behavior.focusOnWebView = true;
  }
}
