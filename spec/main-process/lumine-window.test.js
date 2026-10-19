/* globals assert */

const path = require("path");
const nodeFs = require("fs");
const os = require("os");
const fs = require("@lumine-code/fs-plus");
const url = require("url");
const { EventEmitter } = require("events");
const sandbox = require("sinon").createSandbox();
const dedent = require("dedent");
const { BrowserWindow, dialog, webContents, ipcMain } = require("electron");

const LumineWindow = require("../../src/lumine-window");
const LumineApplication = require("../../src/lumine-application");
const FileWatchService = require("../../src/file-watch-service");
const { scanBundledPackageNames } = require("../../src/bundled-packages");
const { emitterEventPromise, conditionPromise } = require("../helpers/async-spec-helpers");

describe("LumineWindow", function () {
  let sinon, app, service;

  beforeEach(function () {
    sinon = sandbox;
    app = new StubApplication(sinon);
    service = new StubRecoveryService(sinon);
  });

  afterEach(async function () {
    await app.fileWatchService.close();
    sinon.restore();
  });

  it("retires native frame keyboard listeners when its window closes", async function () {
    const window = new LumineWindow(app, service, {
      browserWindowConstructor: StubBrowserWindow,
      resourcePath: path.resolve(__dirname, "../.."),
    });
    assert.strictEqual(window.browserWindow.webContents.listenerCount("before-input-event"), 1);
    window.browserWindow.emit("closed");
    await window.closedPromise;
    assert.strictEqual(window.browserWindow.webContents.listenerCount("before-input-event"), 0);
  });

  if (process.platform === "win32") {
    it("forwards native caption presses without consuming the window message", async function () {
      class NativeBrowserWindow extends StubBrowserWindow {
        constructor(options) {
          super(options);
          this.hooks = new Map();
        }
        isWindowMessageHooked(message) {
          return this.hooks.has(message);
        }
        hookWindowMessage(message, callback) {
          this.hooks.set(message, callback);
        }
        unhookWindowMessage(message) {
          this.hooks.delete(message);
        }
      }
      const window = new LumineWindow(app, service, {
        browserWindowConstructor: NativeBrowserWindow,
        resourcePath: path.resolve(__dirname, "../.."),
      });
      const caption = Buffer.alloc(8);
      caption.writeUInt32LE(2);
      const callback = window.browserWindow.hooks.get(0x00a1);
      assert.isUndefined(callback(caption, Buffer.alloc(8)));
      assert.deepEqual(window.browserWindow.sent.at(-1), [
        "did-mouse-down-in-window",
        { windowId: window.id },
      ]);
      const mouseDown = Buffer.alloc(8);
      mouseDown.writeUInt32LE(0x0201);
      const point = Buffer.alloc(8);
      point.writeInt16LE(640, 0);
      point.writeInt16LE(24, 2);
      // Chromium can forward the child's caption input without invoking the
      // top-level WM_NCLBUTTONDOWN hook at all.
      assert.isUndefined(window.browserWindow.hooks.get(0x0210)(mouseDown, point));
      assert.deepEqual(window.browserWindow.sent.at(-1), [
        "did-mouse-down-in-window",
        { windowId: window.id, position: { x: 640, y: 24 } },
      ]);
      window.browserWindow.emit("closed");
      await window.closedPromise;
      const count = window.browserWindow.sent.length;
      callback(caption, Buffer.alloc(8));
      assert.strictEqual(window.browserWindow.sent.length, count);
      assert.strictEqual(window.browserWindow.hooks.size, 0);
    });
  }

  describe("committed unload handshake", function () {
    let window;
    const reply = (
      result,
      id = window.unloadRequest.id,
      sender = window.browserWindow.webContents,
    ) => ipcMain.emit("did-prepare-to-unload", { sender }, { id, approved: result });

    beforeEach(() => {
      window = new LumineWindow(app, service, { browserWindowConstructor: StubBrowserWindow });
      window.browserWindow.hide = sinon.spy();
      window.browserWindow.close = sinon.spy();
    });
    afterEach(() => window.browserWindow.emit("closed"));

    it("shares one request and lets close supersede a pending reload", async () => {
      const preparing = window.prepareToUnload({ reason: "reload" });
      const id = window.unloadRequest.id;
      assert.isFalse(window.isClosing());
      assert.strictEqual(window.prepareToUnload({ reason: "close" }), preparing);
      assert.strictEqual(window.prepareToUnload({ reason: "close" }), preparing);
      assert.isTrue(window.isClosing());
      assert.deepEqual(window.browserWindow.sent, [
        ["prepare-to-unload", { id, reason: "reload" }],
      ]);
      assert.isFalse(window.browserWindow.hide.called);
      reply(false);
      assert.isFalse(await preparing);
      assert.isFalse(window.isClosing());
      const retry = window.prepareToUnload({ reason: "close" });
      assert.notEqual(window.unloadRequest.id, id);
      reply(true);
      assert.isTrue(await retry);
    });

    it("ignores stale or foreign replies and hides all presentations only after commit", async () => {
      const preparing = window.prepareToUnload({ reason: "close" });
      const id = window.unloadRequest.id;
      const hideChildren = sinon.spy(window.auxiliaryWindowBroker, "hide");
      reply(true, "stale");
      reply(true, id, {});
      assert.isFalse(window.unloadApproved);
      assert.throws(() => window.commitUnload("stale"), /no longer active/);
      window.commitUnload(id);
      assert.isTrue(window.closeCommitted);
      assert.isTrue(window.browserWindow.hide.calledOnce);
      assert.isTrue(hideChildren.calledOnce);
      reply(false);
      assert.isTrue(await preparing);
    });

    for (const reason of ["reload", "replace"]) {
      it(`keeps the native window present for ${reason}`, async () => {
        const preparing = window.prepareToUnload({ reason });
        window.commitUnload(window.unloadRequest.id);
        assert.isFalse(window.browserWindow.hide.called);
        assert.isFalse(window.isClosing());
        reply(true);
        assert.isTrue(await preparing);
      });
    }

    it("vetoes repeated native close events until preparation approves them", async () => {
      const first = { preventDefault: sinon.spy() };
      const second = { preventDefault: sinon.spy() };
      window.browserWindow.emit("close", first);
      window.commitUnload(window.unloadRequest.id);
      window.browserWindow.emit("close", second);
      assert.isTrue(first.preventDefault.calledOnce);
      assert.isTrue(second.preventDefault.calledOnce);
      assert.equal(window.browserWindow.sent.length, 1);
      assert.isFalse(window.unloadApproved);
      assert.isFalse(window.browserWindow.close.called);
      reply(true);
      await window.lastPrepareToUnloadPromise;
      await Promise.resolve();
      assert.isTrue(window.browserWindow.close.calledOnce);
    });

    it("releases the handshake when the native window closes before its reply", async () => {
      const listeners = ipcMain.listenerCount("did-prepare-to-unload");
      const preparing = window.prepareToUnload({ reason: "close" });
      window.browserWindow.emit("closed");
      assert.isTrue(await preparing);
      assert.equal(ipcMain.listenerCount("did-prepare-to-unload"), listeners);
    });

    it("settles an obsolete preparation when a fresh renderer generation loads", async () => {
      const listeners = ipcMain.listenerCount("did-prepare-to-unload");
      const preparing = window.prepareToUnload({ reason: "close" });
      window.browserWindow.emit("window:loaded");
      assert.isFalse(await preparing);
      assert.isFalse(window.isClosing());
      assert.isFalse(window.unloadApproved);
      assert.equal(ipcMain.listenerCount("did-prepare-to-unload"), listeners);
    });

    it("does not revive a committed close when a fresh renderer reports loaded", async () => {
      const preparing = window.prepareToUnload({ reason: "close" });
      const loaded = sinon.spy();
      window.on("window:loaded", loaded);
      window.commitUnload(window.unloadRequest.id);
      window.browserWindow.emit("window:loaded");
      assert.isFalse(window.browserWindow.close.called);
      assert.isFalse(window.unloadApproved);
      reply(true);
      assert.isTrue(await preparing);
      await window.getLoadedPromise();
      assert.isTrue(window.isClosing());
      assert.isTrue(window.unloadApproved);
      assert.isTrue(window.browserWindow.close.calledOnce);
      assert.isFalse(loaded.called);
      for (const action of ["focus", "maximize", "restore"]) {
        window.browserWindow[action] = sinon.spy();
        window[action]();
        assert.isFalse(window.browserWindow[action].called);
      }
    });

    it("delivers queued files and URIs only to the ready replacement renderer after reload", async () => {
      window.resolveLoadedPromise();
      const reload = sinon.spy(window.browserWindow, "reload");
      const reloading = window.reload();
      const repeatedReload = window.reload();
      const locations = [{ pathToOpen: "new-project", isDirectory: true }];
      const opening = window.openLocations(locations);
      const sendingURI = window.sendURIMessage("lumine://settings");
      assert.deepEqual(window.projectRoots, []);
      reply(true);
      await conditionPromise(() => reload.called, "reload navigation");
      assert.deepEqual(window.projectRoots, []);
      assert.isFalse(
        window.browserWindow.sent.some(
          ([channel]) => channel === "message" || channel === "uri-message",
        ),
      );
      window.browserWindow.emit("window:loaded");
      assert.isTrue(await opening);
      assert.isTrue(await sendingURI);
      await Promise.all([reloading, repeatedReload]);
      assert.isTrue(reload.calledOnce);
      assert.deepEqual(window.projectRoots, ["new-project"]);
      assert.deepEqual(
        window.browserWindow.sent.filter(
          ([channel, command, detail]) =>
            channel === "message" && command === "open-locations" && detail === locations,
        ),
        [["message", "open-locations", locations]],
      );
      assert.deepEqual(
        window.browserWindow.sent.filter(([channel]) => channel === "uri-message"),
        [["uri-message", "lumine://settings"]],
      );
    });

    it("refuses queued files and URIs when close supersedes their pending reload", async () => {
      window.resolveLoadedPromise();
      const reloading = window.reload();
      const opening = window.openLocations([{ pathToOpen: "new-project", isDirectory: true }]);
      const sendingURI = window.sendURIMessage("lumine://settings");
      window.prepareToUnload({ reason: "close" });
      reply(true);
      assert.isFalse(await opening);
      assert.isFalse(await sendingURI);
      await reloading;
      assert.deepEqual(window.projectRoots, []);
      assert.isFalse(window.browserWindow.behavior.reloaded);
    });

    it("refuses queued files and URIs after accepting replacement by another window", async () => {
      window.resolveLoadedPromise();
      const preparation = window.prepareToUnload({ reason: "replace" });
      const opening = window.openLocations([{ pathToOpen: "new-project", isDirectory: true }]);
      const sendingURI = window.sendURIMessage("lumine://settings");
      reply(true);
      assert.isTrue(await preparation);
      assert.isFalse(await opening);
      assert.isFalse(await sendingURI);
      assert.deepEqual(window.projectRoots, []);
      assert.isFalse(
        window.browserWindow.sent.some(
          ([channel]) => channel === "message" || channel === "uri-message",
        ),
      );
    });

    it("delivers queued requests to the existing generation when reload is refused", async () => {
      window.resolveLoadedPromise();
      const preparation = window.prepareToUnload({ reason: "reload" });
      const opening = window.openLocations([{ pathToOpen: "file.js" }]);
      const sendingURI = window.sendURIMessage("lumine://settings");
      reply(false);
      assert.isFalse(await preparation);
      assert.isTrue(await opening);
      assert.isTrue(await sendingURI);
      assert.isFalse(window.browserWindow.behavior.reloaded);
    });

    it("settles queued opens and reload when its new renderer closes before becoming ready", async () => {
      window.resolveLoadedPromise();
      const reloading = window.reload();
      const opening = window.openLocations([{ pathToOpen: "file.js" }]);
      const sendingURI = window.sendURIMessage("lumine://settings");
      reply(true);
      await conditionPromise(() => window.browserWindow.behavior.reloaded, "reload navigation");
      window.browserWindow.destroyed = true;
      window.browserWindow.emit("closed");
      assert.isTrue(window.isClosing());
      assert.isFalse(await opening);
      assert.isFalse(await sendingURI);
      await reloading;
    });

    it("falls back to beforeunload and then destroys a renderer that remains wedged after commit", async () => {
      const clock = sinon.useFakeTimers();
      const preparing = window.prepareToUnload({ reason: "close" });
      sinon.stub(console, "warn");
      sinon.stub(window.browserWindow, "destroy").callsFake(() => {
        window.browserWindow.destroyed = true;
        window.browserWindow.emit("closed");
      });
      window.commitUnload(window.unloadRequest.id);
      clock.tick(7999);
      assert.isFalse(window.unloadApproved);
      assert.isFalse(window.browserWindow.close.called);
      clock.tick(1);
      assert.isTrue(window.unloadApproved);
      assert.isTrue(window.browserWindow.close.calledOnce);
      assert.isFalse(window.browserWindow.destroy.called);
      clock.tick(2000);
      assert.isTrue(window.browserWindow.destroy.calledOnce);
      assert.isTrue(await preparing);
    });

    it("acknowledges a durable commit and retains its watchdog when hiding presentations fails", async () => {
      const preparing = window.prepareToUnload({ reason: "close" });
      window.browserWindow.hide = sinon.stub().throws(new Error("Native hide failed"));
      sinon.stub(window.auxiliaryWindowBroker, "hide").throws(new Error("Auxiliary hide failed"));
      const report = sinon.stub(console, "error");
      assert.doesNotThrow(() => window.commitUnload(window.unloadRequest.id));
      assert.isTrue(window.unloadRequest.committed);
      assert.isDefined(window.unloadRequest.closeTimer);
      assert.isFalse(window.unloadApproved);
      assert.equal(report.callCount, 2);
      reply(true);
      assert.isTrue(await preparing);
    });

    it("does not reload when a close supersedes its pending preparation", async () => {
      window.resolveLoadedPromise();
      const reloading = window.reload();
      window.prepareToUnload({ reason: "close" });
      reply(true);
      await reloading;
      assert.isFalse(window.browserWindow.behavior.reloaded);
      assert.isFalse(
        window.browserWindow.sent.some(([channel]) => channel === "will-reload-window"),
      );
    });

    it("refuses locations before and after waiting for its renderer when closing", async () => {
      const opening = window.openLocations([{ pathToOpen: "first.js" }]);
      window.prepareToUnload({ reason: "close" });
      assert.isFalse(await window.openLocations([{ pathToOpen: "second.js" }]));
      window.resolveLoadedPromise();
      assert.isFalse(await opening);
      assert.isFalse(window.browserWindow.sent.some(([channel]) => channel === "message"));
    });
  });

  describe("creating a real window", function () {
    let resourcePath, windowInitializationScript, lumineHome, browserWindow;
    let original, extraWindows, devPackageLinks;

    beforeEach(async function () {
      browserWindow = null;
      extraWindows = new Set();
      devPackageLinks = [];
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
      const packagesDevPath = path.join(lumineHome, "packages-dev");
      nodeFs.mkdirSync(packagesDevPath);
      for (const packageName of scanBundledPackageNames(resourcePath)) {
        const workspacePackagePath = path.resolve(resourcePath, "..", packageName);
        if (!nodeFs.existsSync(path.join(workspacePackagePath, "package.json"))) continue;

        const linkPath = path.join(packagesDevPath, packageName);
        nodeFs.symlinkSync(
          workspacePackagePath,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        devPackageLinks.push(linkPath);
      }

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
      const testWindows = new Set([browserWindow, ...extraWindows]);
      for (const testWindow of testWindows) {
        if (!testWindow || testWindow.isDestroyed()) continue;
        if (!testWindow.webContents.isCrashed()) {
          const owner = app.windows.find((window) => window.browserWindow === testWindow);
          if (owner) await owner.prepareToUnload({ reason: "close" });
        }
        testWindow.destroy();
      }
      await Promise.all(app.windows.map((window) => app.releaseFileWatchSession(window)));
      process.env.LUMINE_HOME = original.LUMINE_HOME;
      process.env.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT =
        original.LUMINE_DISABLE_SHELLING_OUT_FOR_ENVIRONMENT;
      if (lumineHome) {
        // Never let a recursive cleanup traverse a package-dev junction into
        // its working tree. Remove every reparse point explicitly first.
        for (const linkPath of devPackageLinks) removeDirectoryLink(linkPath);
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
        devMode: true,
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
      assert.isTrue(settings.devMode);
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

    it("does not hide the focused renderer during a main-process reload", async function () {
      const w = new LumineWindow(app, service, {
        resourcePath,
        windowInitializationScript,
        devMode: true,
        headless: true,
      });
      ({ browserWindow } = w);
      await w.getLoadedPromise();
      sinon.spy(browserWindow, "hide");
      // Exercise the focused beforeunload branch without taking native focus
      // from another application or changing the runner's hidden-window policy.
      await browserWindow.webContents.executeJavaScript(`
        document.hasFocus = () => true;
        void 0;
      `);

      await w.reload();

      assert.isFalse(browserWindow.hide.called);
      assert.isFalse(browserWindow.isDestroyed());
    });

    it("moves an unsaved editor through new-window startup and real commit acknowledgement", async function () {
      const source = new LumineWindow(app, service, {
        resourcePath,
        windowInitializationScript,
        devMode: true,
        headless: true,
        clearWindowState: true,
      });
      browserWindow = source.browserWindow;
      await source.getLoadedPromise();
      let destination;
      app.openPaths = async (options) => {
        destination = new LumineWindow(app, service, {
          resourcePath,
          windowInitializationScript,
          devMode: options.devMode,
          safeMode: options.safeMode,
          headless: true,
          clearWindowState: options.clearWindowState,
          paneItemTransfer: options.paneItemTransfer,
        });
        extraWindows.add(destination.browserWindow);
        return destination;
      };
      const result = await source.browserWindow.webContents.executeJavaScript(`
        (async () => {
          globalThis.transferSourceItem = await lumine.workspace.open("");
          transferSourceItem.setText("unsaved source draft\\nsecond line");
          transferSourceItem.setSelectedBufferRange([[0, 2], [1, 4]], {reversed: true});
          const scope = lumine.paneItemTransfers.createScope();
          try {
            return await scope.openInNewWindow(
              lumine.workspace.paneForItem(transferSourceItem), transferSourceItem
            );
          } finally {
            scope.dispose();
          }
        })()
      `);
      await destination.getLoadedPromise();
      assert.strictEqual(result.windowId, destination.id);
      assert.isTrue(
        await source.browserWindow.webContents.executeJavaScript(
          "transferSourceItem.isDestroyed()",
        ),
      );
      const staged = await destination.browserWindow.webContents.executeJavaScript(`
        (() => {
          const item = lumine.workspace.getActivePaneItem();
          return {
            text: item.getText(),
            modified: item.getFileState(),
            selections: item.serializeViewState().selections
          };
        })()
      `);
      assert.strictEqual(staged.text, "unsaved source draft\nsecond line");
      assert.strictEqual(staged.modified, "modified");
      assert.deepEqual(staged.selections, [
        {
          range: [
            [0, 2],
            [1, 4],
          ],
          reversed: true,
        },
      ]);
      // This assertion leaves an unsaved untitled buffer. Avoid a native save
      // prompt when the fixture unloads its isolated destination window.
      await destination.browserWindow.webContents.executeJavaScript(
        "lumine.workspace.confirmClose = () => true; void 0;",
      );
    });

    it("shares one watcher worker across main and two renderers through veto, reload, close and crash", async function () {
      const sharedFile = path.join(lumineHome, "shared-observation.txt");
      const privateFile = path.join(lumineHome, "second-window-observation.txt");
      nodeFs.writeFileSync(sharedFile, "initial shared contents");
      nodeFs.writeFileSync(privateFile, "initial private contents");
      const mainClient = app.fileWatchService.createClient("main-process-observer");
      const mainWatch = mainClient.watchFile(sharedFile);
      const mainEvents = [];
      mainWatch.onDidChange((events) => mainEvents.push(...events));
      await mainWatch.ready;

      const createWindow = async () => {
        const window = new LumineWindow(app, service, {
          resourcePath,
          windowInitializationScript,
          devMode: true,
          headless: true,
        });
        extraWindows.add(window.browserWindow);
        await window.getLoadedPromise();
        return window;
      };
      const attach = (window, paths) =>
        window.browserWindow.webContents.executeJavaScript(`
        (async () => {
          globalThis.fileWatchProbe = { events: [], handles: [] };
          for (const filePath of ${JSON.stringify(paths)}) {
            const handle = require("lumine").watchFile(filePath);
            fileWatchProbe.handles.push(handle);
            handle.onDidChange(events => fileWatchProbe.events.push(...events));
            await handle.ready;
          }
        })()
      `);
      const count = (window, targetPath) =>
        window.browserWindow.webContents.executeJavaScript(
          `fileWatchProbe.events.filter(event => event.path === ${JSON.stringify(targetPath)}).length`,
        );
      const expectWrite = async (windows, text) => {
        const before = await Promise.all(windows.map((window) => count(window, sharedFile)));
        const mainBefore = mainEvents.length;
        nodeFs.writeFileSync(sharedFile, text);
        await conditionPromise(async () => {
          const after = await Promise.all(windows.map((window) => count(window, sharedFile)));
          return (
            mainEvents.length > mainBefore && after.every((value, index) => value > before[index])
          );
        }, `all remaining owners observing ${text}`);
      };
      const ownsSession = (session) =>
        [...app.fileWatchService.owners.keys()].some((owner) => owner.startsWith(`${session}:`));

      try {
        const first = await createWindow();
        const second = await createWindow();
        await attach(first, [sharedFile]);
        await attach(second, [sharedFile, privateFile]);
        const workerPid = app.fileWatchService.worker.pid;
        await expectWrite([first, second], "both renderer sessions are watching");

        nodeFs.writeFileSync(privateFile, "only the second window watches this file");
        await conditionPromise(
          async () => (await count(second, privateFile)) > 0,
          "private observation",
        );
        assert.strictEqual(await count(first, privateFile), 0);
        assert.isFalse(mainEvents.some((event) => event.path === privateFile));

        // Exercise the real renderer-to-main unload veto, without displaying a
        // user dialog or touching windows other than these two test windows.
        const firstSession = first.fileWatchSession;
        await first.browserWindow.webContents.executeJavaScript(`
          globalThis.originalConfirmClose = lumine.workspace.confirmClose;
          lumine.workspace.confirmClose = () => false;
          void 0;
        `);
        first.close();
        await conditionPromise(() => Boolean(first.lastPrepareToUnloadPromise), "close handshake");
        assert.isFalse(await first.lastPrepareToUnloadPromise);
        assert.isFalse(first.browserWindow.isDestroyed());
        assert.strictEqual(first.fileWatchSession, firstSession);
        assert.isTrue(ownsSession(firstSession));
        await expectWrite([first, second], "watching survives a cancelled close");
        await first.browserWindow.webContents.executeJavaScript(`
          lumine.workspace.confirmClose = originalConfirmClose;
          delete globalThis.originalConfirmClose;
          void 0;
        `);

        await first.reload();
        assert.notStrictEqual(first.fileWatchSession, firstSession);
        await conditionPromise(() => !ownsSession(firstSession), "old renderer owner cleanup");
        const staleReply = await first.browserWindow.webContents.executeJavaScript(`
          require("electron").ipcRenderer.invoke("lumine:file-watch", {
            session: ${JSON.stringify(firstSession)}, clientId: "stale-session-probe",
            request: { type: "subscribe", id: 1, kind: "file", recursive: false,
              path: ${JSON.stringify(sharedFile)} }
          })
        `);
        assert.strictEqual(staleReply.error.code, "ABORT_ERR");
        await attach(first, [sharedFile]);
        await expectWrite([first, second], "watching survives another window reloading");
        assert.strictEqual(app.fileWatchService.worker.pid, workerPid);

        const reloadedSession = first.fileWatchSession;
        first.close();
        await first.closedPromise;
        await conditionPromise(
          () => !ownsSession(reloadedSession),
          "closed renderer owner cleanup",
        );
        await expectWrite([second], "watching survives another window closing");

        const secondSession = second.fileWatchSession;
        const crashed = emitterEventPromise(
          second.browserWindow.webContents,
          "render-process-gone",
        );
        second.browserWindow.webContents.forcefullyCrashRenderer();
        await crashed;
        await conditionPromise(() => !ownsSession(secondSession), "crashed renderer owner cleanup");
        await expectWrite([], "main configuration observation survives the last renderer crash");
        assert.strictEqual(app.fileWatchService.worker.pid, workerPid);
        assert.deepEqual([...app.fileWatchService.owners.keys()], ["main-process-observer"]);
      } finally {
        await mainClient.close();
      }
      assert.strictEqual(app.fileWatchService.owners.size, 0);
      assert.deepEqual(app.fileWatchService.diagnostics().subscriptions, []);
      const diagnostics = await app.fileWatchService.requestWorker("diagnostics");
      assert.deepEqual(diagnostics.sources, []);
      assert.strictEqual(diagnostics.subscriptions, 0);
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

    it("creates every editor and spec window without a native frame", function () {
      const { browserWindow: w0 } = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      assert.isFalse(w0.options.frame);
      assert.isTrue(w0.options.disableAutoHideCursor);
      assert.isFalse(w0.options.webPreferences.webviewTag);

      const { browserWindow: w1 } = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        isSpec: true,
      });
      assert.isFalse(w1.options.frame);
      assert.isTrue(w1.options.disableAutoHideCursor);
      assert.isFalse(w1.options.webPreferences.webviewTag);
    });

    it("drives offscreen spec windows at a normal animation frame rate", function () {
      const { browserWindow } = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        isSpec: true,
        headless: true,
        offscreen: true,
      });

      assert.isTrue(browserWindow.options.webPreferences.offscreen);
      assert.isTrue(browserWindow.webContents.setFrameRate.calledOnceWith(60));
      assert.isTrue(browserWindow.webContents.startPainting.calledOnce);
    });

    it("never reveals offscreen windows through native presentation operations", function () {
      const window = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        isSpec: true,
        headless: true,
        offscreen: true,
      });
      for (const method of [
        "focus",
        "minimize",
        "maximize",
        "unmaximize",
        "restore",
        "setFullScreen",
      ]) {
        const nativeOperation = (window.browserWindow[method] = sinon.spy());
        window[method](true);
        assert.isFalse(nativeOperation.called, `${method} must not reveal the offscreen host`);
      }
      assert.isTrue(window.browserWindow.webContents.startPainting.calledOnce);
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
      await conditionPromise(() => w.browserWindow.sent.length > 0, "initial locations delivery");

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
      const reload = sinon.spy(w.browserWindow, "reload");
      const send = sinon.spy(w.browserWindow.webContents, "send");

      w.reload();
      await Promise.resolve();

      assert.isTrue(w.prepareToUnload.calledOnceWithExactly({ reason: "reload" }));
      assert.isTrue(w.browserWindow.behavior.reloaded);
      assert.isTrue(send.calledOnceWithExactly("will-reload-window"));
      assert.isTrue(send.calledBefore(reload));
    });

    it("does not mark a reload while the renderer is still deciding whether to unload", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      let resolveUnload;
      w.prepareToUnload = () => new Promise((resolve) => (resolveUnload = resolve));

      w.reload();
      await Promise.resolve();

      assert.deepEqual(w.browserWindow.sent, []);
      assert.isFalse(w.browserWindow.behavior.reloaded);

      resolveUnload(true);
      await Promise.resolve();
      assert.deepEqual(w.browserWindow.sent, [["will-reload-window"]]);
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
      assert.deepEqual(w.browserWindow.sent, [["will-reload-window"]]);
    });

    it("leaves paths openable when the renderer refuses to unload", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });
      w.resolveLoadedPromise();
      w.prepareToUnload = sinon.stub().resolves(false);

      await w.reload();
      assert.isFalse(w.browserWindow.behavior.reloaded);
      assert.isFalse(w.browserWindow.sent.some(([channel]) => channel === "will-reload-window"));

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

  describe("persistent state identity", function () {
    it("generates a UUID and exposes it to the renderer", function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
      });

      assert.match(w.windowStateId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-/);
      assert.strictEqual(w.loadSettings.windowStateId, w.windowStateId);
    });

    it("preserves a restored state identity", function () {
      const windowStateId = "11111111-1111-4111-8111-111111111111";
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        windowStateId,
      });

      assert.strictEqual(w.windowStateId, windowStateId);
      assert.strictEqual(w.getLoadSettingsForRenderer().windowStateId, windowStateId);
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
      assert.deepEqual(w.loadSettings.initialProjectRoots, ["directory0", "directory1"]);
      assert.isTrue(w.loadSettings.hasOpenFiles);
      w.resolveLoadedPromise();
      await promise;
    });

    it("retains pending files when another launch adds only project roots", async function () {
      const w = new LumineWindow(app, service, {
        browserWindowConstructor: StubBrowserWindow,
        locationsToOpen: [{ pathToOpen: "file.txt", isFile: true }],
      });

      const promise = w.openLocations([{ pathToOpen: "directory0", isDirectory: true }]);

      assert.deepEqual(w.loadSettings.initialProjectRoots, ["directory0"]);
      assert.isTrue(w.loadSettings.hasOpenFiles);
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

function removeDirectoryLink(linkPath) {
  try {
    nodeFs.unlinkSync(linkPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    if (error.code !== "EPERM" && error.code !== "EISDIR") throw error;
    nodeFs.rmdirSync(linkPath);
  }
}

class StubApplication {
  createFileWatchSession(window) {
    return LumineApplication.prototype.createFileWatchSession.call(this, window);
  }
  releaseFileWatchSession(window) {
    return LumineApplication.prototype.releaseFileWatchSession.call(this, window);
  }
  constructor(sinon) {
    this.fileWatchService = new FileWatchService();
    this.config = { get: (key) => this.config[key] || null };
    this.configFile = {
      path: "stub-config-path",
      get() {
        return "stub-config";
      },
    };

    this.removeWindow = sinon.spy((window) => {
      this.windows = this.windows.filter((candidate) => candidate !== window);
    });
    this.saveCurrentWindowOptions = sinon.spy();
    this.exit = sinon.spy();
    this.windows = [];
    this.lumineWindowsByWebContentsId = new Map();
  }

  registerLumineWindow(lumineWindow) {
    this.windows.push(lumineWindow);
    this.lumineWindowsByWebContentsId.set(lumineWindow.browserWindow.webContents.id, lumineWindow);
    global.lumineApplication = this;
  }

  lumineWindowForSender(sender) {
    const lumineWindow = this.windows.find(
      (window) =>
        !window.browserWindow.isDestroyed() && window.browserWindow.webContents === sender,
    );
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
    this.webContents.setVisualZoomLevelLimits = () => {};
    this.webContents.setFrameRate = sandbox.spy();
    this.webContents.startPainting = sandbox.spy();
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
