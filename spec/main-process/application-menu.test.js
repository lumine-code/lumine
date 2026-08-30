const assert = require("./assert");
const { Menu } = require("electron");
const { EventEmitter } = require("events");

const ApplicationMenu = require("../../src/application-menu");

// Characterization specs. `src/application-menu.js` had no coverage at all, so
// these pin what it does today — including two things it does not do, which are
// called out where they are asserted.
//
// `Menu.buildFromTemplate` stays live: `enableWindowSpecificItems` walks real
// `MenuItem` instances, and stubbing the builder would test nothing. Only the
// install is stubbed, or the suite would replace the menu of the process
// running it.
describe("ApplicationMenu", () => {
  const humanized = (windows) => (process.platform === "darwin" ? windows.darwin : windows.other);

  let applicationMenu;
  let originalSetApplicationMenu;
  let originalBuildFromTemplate;
  let originalLumineApplication;
  let installedMenus;
  let buildCount;
  let sentCommands;

  beforeEach(() => {
    installedMenus = [];
    buildCount = 0;

    originalSetApplicationMenu = Menu.setApplicationMenu;
    Menu.setApplicationMenu = (menu) => installedMenus.push(menu);

    originalBuildFromTemplate = Menu.buildFromTemplate;
    Menu.buildFromTemplate = (template) => {
      buildCount++;
      return originalBuildFromTemplate.call(Menu, template);
    };

    sentCommands = [];
    // `lumine-window.test.js` assigns this global and never restores it, so
    // capture whatever is there rather than assuming it is undefined.
    originalLumineApplication = global.lumineApplication;
    global.lumineApplication = {
      sendCommand: (command, detail) => sentCommands.push([command, detail]),
      getAllWindows: () => [],
    };

    applicationMenu = new ApplicationMenu("1.2.3");
  });

  afterEach(() => {
    Menu.setApplicationMenu = originalSetApplicationMenu;
    Menu.buildFromTemplate = originalBuildFromTemplate;
    global.lumineApplication = originalLumineApplication;
  });

  describe("::translateTemplate(template, keystrokesByCommand)", () => {
    it("sets an Electron accelerator for a single keystroke and leaves the label alone", () => {
      const template = [{ label: "Save", command: "core:save" }];
      applicationMenu.translateTemplate(template, { "core:save": ["ctrl-s"] });

      assert.strictEqual(template[0].label, "Save");
      assert.strictEqual(template[0].accelerator, "Ctrl+S");
    });

    it("appends the keystrokes to the label for a multi-stroke binding, with no accelerator", () => {
      // Electron accelerators cannot express a chord, so the keystrokes go in
      // the label instead. The keymap convention makes chords the norm for a
      // whole domain (`alt-j` Jupyter, `alt-g` git), so this is a common path.
      const template = [{ label: "Run Cell", command: "jupyter-repl:run" }];
      applicationMenu.translateTemplate(template, { "jupyter-repl:run": ["ctrl-a ctrl-b"] });

      assert.strictEqual(
        template[0].label,
        `Run Cell [${humanized({ darwin: "⌃A ⌃B", other: "Ctrl+A Ctrl+B" })}]`,
      );
      assert.isUndefined(template[0].accelerator);
    });

    it("shows paste as label text rather than an accelerator", () => {
      // Deliberate, and the reason is in the source: paste must reach the
      // renderer as a keyboard event so Chromium can expose custom clipboard
      // formats. An accelerator would make Electron's menu a second command
      // source and swallow the key. `ContextMenuManager::addAccelerators` has
      // no matching case — a popped menu holds no global accelerator.
      for (const command of ["core:paste", "editor:paste-without-reformatting"]) {
        const template = [{ label: "Paste", command }];
        applicationMenu.translateTemplate(template, { [command]: ["ctrl-v"] });

        assert.strictEqual(
          template[0].label,
          `Paste [${humanized({ darwin: "⌃V", other: "Ctrl+V" })}]`,
        );
        assert.isUndefined(template[0].accelerator);
      }
    });

    it("leaves an item alone when its command has no binding", () => {
      const template = [{ label: "Save", command: "core:save" }];
      applicationMenu.translateTemplate(template, {});

      assert.strictEqual(template[0].label, "Save");
      assert.isUndefined(template[0].accelerator);
    });

    it("leaves an unbound command that names something on Object.prototype alone", () => {
      // The renderer builds the map with a null prototype, but the structured
      // clone that carries it here does not preserve one. Without an own-key
      // check this reads `Object`, whose `length` of 1 passes the guard and
      // whose `[0]` is undefined, so `keystroke.includes` throws.
      for (const command of ["constructor", "hasOwnProperty", "isPrototypeOf"]) {
        const template = [{ label: "Break", command }];
        applicationMenu.translateTemplate(template, {});

        assert.strictEqual(template[0].label, "Break");
        assert.isUndefined(template[0].accelerator);
      }
    });

    it("still resolves a real binding for such a command once the map has crossed IPC", () => {
      const template = [{ label: "Break", command: "constructor" }];
      const clone = structuredClone(
        Object.assign(Object.create(null), { constructor: ["ctrl-b"] }),
      );
      // The own key is what survives; the prototype is not.
      assert.isNotNull(Object.getPrototypeOf(clone));

      applicationMenu.translateTemplate(template, clone);
      assert.strictEqual(template[0].accelerator, "Ctrl+B");
    });

    it("gives every item a metadata object, and marks the window-specific ones", () => {
      const template = [
        { label: "Save", command: "core:save" },
        { label: "About", command: "application:about" },
        { type: "separator" },
      ];
      applicationMenu.translateTemplate(template, {});

      assert.isTrue(template[0].metadata.windowSpecific);
      assert.isUndefined(template[1].metadata.windowSpecific);
      assert.isDefined(template[2].metadata);
    });

    it("routes a click to the application with the item's own commandDetail", () => {
      const commandDetail = { source: "menu" };
      const template = [{ label: "Save", command: "core:save", commandDetail }];
      applicationMenu.translateTemplate(template, {});
      template[0].click();

      assert.deepStrictEqual(sentCommands, [["core:save", commandDetail]]);
    });

    it("recurses into submenus", () => {
      const template = [{ label: "File", submenu: [{ label: "Save", command: "core:save" }] }];
      applicationMenu.translateTemplate(template, { "core:save": ["ctrl-s"] });

      assert.strictEqual(template[0].submenu[0].accelerator, "Ctrl+S");
    });

    it("returns the same template it mutated", () => {
      const template = [{ label: "Save", command: "core:save" }];
      assert.strictEqual(applicationMenu.translateTemplate(template, {}), template);
    });
  });

  describe("::substituteVersion(template)", () => {
    it("replaces the VERSION placeholder with the version it was constructed with", () => {
      const template = [{ label: "VERSION" }];
      applicationMenu.substituteVersion(template);

      assert.strictEqual(template[0].label, "Version 1.2.3");
    });

    it("substitutes only the first placeholder, at any depth", () => {
      // `find`, not `filter` — a second VERSION item would be left as-is.
      const template = [{ label: "Lumine", submenu: [{ label: "VERSION" }] }, { label: "VERSION" }];
      applicationMenu.substituteVersion(template);

      assert.strictEqual(template[0].submenu[0].label, "Version 1.2.3");
      assert.strictEqual(template[1].label, "VERSION");
    });

    it("does nothing when there is no placeholder", () => {
      const template = [{ label: "Save", command: "core:save" }];
      applicationMenu.substituteVersion(template);

      assert.strictEqual(template[0].label, "Save");
    });
  });

  describe("::setActiveTemplate(template)", () => {
    it("rebuilds and installs when the template differs", () => {
      // The constructor has already installed the default template, so both
      // counts are measured from wherever `beforeEach` left them.
      const builtBefore = buildCount;
      const installedBefore = installedMenus.length;
      applicationMenu.setActiveTemplate([{ label: "One" }]);

      assert.strictEqual(buildCount, builtBefore + 1);
      assert.strictEqual(installedMenus.length, installedBefore + 1);
    });

    it("skips the rebuild when handed a deeply equal template", () => {
      applicationMenu.setActiveTemplate([{ label: "One" }]);
      const after = buildCount;
      applicationMenu.setActiveTemplate([{ label: "One" }]);

      assert.strictEqual(buildCount, after);
    });

    it("cannot skip anything on the update path, because click closures never compare equal", () => {
      // Not a saving to rely on: `_.isEqual` compares functions by reference and
      // `translateTemplate` mints a fresh `click` per item on every call, so an
      // otherwise identical menu is rebuilt and reinstalled on every renderer
      // update. Pinned so the guard is not mistaken for a fast path.
      const templateFor = () => {
        const template = [{ label: "Save", command: "core:save" }];
        applicationMenu.translateTemplate(template, {});
        return template;
      };

      applicationMenu.setActiveTemplate(templateFor());
      const after = buildCount;
      applicationMenu.setActiveTemplate(templateFor());

      assert.strictEqual(buildCount, after + 1);
    });
  });

  describe("::update(window, template, keystrokesByCommand)", () => {
    it("remembers the template per window without installing it", () => {
      const window = new EventEmitter();
      const installedBefore = installedMenus.length;
      applicationMenu.update(window, [{ label: "Save", command: "core:save" }], {});

      assert.isDefined(applicationMenu.windowTemplates.get(window));
      assert.strictEqual(installedMenus.length, installedBefore);
    });

    it("installs the template when the window is the focused one", () => {
      const window = new EventEmitter();
      applicationMenu.addWindow(window);
      const installedBefore = installedMenus.length;
      applicationMenu.update(window, [{ label: "Save", command: "core:save" }], {});

      assert.strictEqual(installedMenus.length, installedBefore + 1);
    });

    it("translates and substitutes on the way through", () => {
      const window = new EventEmitter();
      const template = [{ label: "VERSION" }, { label: "Save", command: "core:save" }];
      applicationMenu.update(window, template, { "core:save": ["ctrl-s"] });

      assert.strictEqual(template[0].label, "Version 1.2.3");
      assert.strictEqual(template[1].accelerator, "Ctrl+S");
    });
  });

  describe("::showPopup(window, request)", () => {
    const createFakeMenu = (template) => {
      const menu = {
        items: template.map((item) => ({
          ...item,
          submenu: Array.isArray(item.submenu) ? createFakeMenu(item.submenu) : undefined,
        })),
        popupCalls: [],
        closePopupCalls: [],
        popup(options) {
          this.popupCalls.push(options);
        },
        closePopup(window) {
          this.closePopupCalls.push(window);
          this.popupCalls.at(-1)?.callback();
        },
      };
      return menu;
    };

    const useFakeMenuBuilder = () => {
      const builds = [];
      Menu.buildFromTemplate = (template) => {
        buildCount++;
        const menu = createFakeMenu(template);
        builds.push({ template, menu });
        return menu;
      };
      return builds;
    };

    const submenuHoverTarget = (id, x = 0) => ({
      key: `submenu:${id}`,
      kind: "submenu",
      id,
      bounds: { x, y: 0, width: 40, height: 24 },
    });
    const overflowHoverTarget = (ids, x = 40) => ({
      key: "overflow",
      kind: "overflow",
      ids,
      bounds: { x, y: 0, width: 30, height: 24 },
    });
    const popupRequest = (overrides = {}) => ({
      kind: "submenu",
      id: "file",
      x: 12,
      y: 34,
      sourceType: "mouse",
      activeHoverTarget: "submenu:file",
      hoverTargets: [submenuHoverTarget("file")],
      ...overrides,
    });
    const overflowPopupRequest = (ids, overrides = {}) => ({
      kind: "overflow",
      ids,
      x: 20,
      y: 40,
      sourceType: "mouse",
      activeHoverTarget: "overflow",
      hoverTargets: [overflowHoverTarget(ids)],
      ...overrides,
    });

    it("enables hover polling outside Linux Wayland sessions", () => {
      assert.isTrue(
        ApplicationMenu.supportsPopupHover("win32", {
          XDG_SESSION_TYPE: "wayland",
          WAYLAND_DISPLAY: "wayland-0",
        }),
      );
      assert.isTrue(ApplicationMenu.supportsPopupHover("darwin", {}, []));
      assert.isTrue(ApplicationMenu.supportsPopupHover("linux", {}, []));
      assert.isTrue(
        ApplicationMenu.supportsPopupHover(
          "linux",
          { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "" },
          [],
        ),
      );
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", { XDG_SESSION_TYPE: "wayland" }, []),
      );
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", { XDG_SESSION_TYPE: "WAYLAND" }, []),
      );
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", { WAYLAND_DISPLAY: "wayland-1" }, []),
      );
    });

    it("honors an explicitly forced Ozone display server", () => {
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", {}, ["lumine", "--ozone-platform=wayland"]),
      );
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", { XDG_SESSION_TYPE: "x11" }, [
          "lumine",
          "--OZONE-PLATFORM=WAYLAND",
        ]),
      );
      assert.isTrue(
        ApplicationMenu.supportsPopupHover(
          "linux",
          { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
          ["lumine", "--ozone-platform=x11"],
        ),
      );
      assert.isTrue(
        ApplicationMenu.supportsPopupHover("linux", { XDG_SESSION_TYPE: "wayland" }, [
          "lumine",
          "--ozone-platform=wayland",
          "--ozone-platform=x11",
        ]),
      );
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", { XDG_SESSION_TYPE: "wayland" }, [
          "lumine",
          "--ozone-platform=x11",
          "--ozone-platform=wayland",
        ]),
      );
      assert.isFalse(
        ApplicationMenu.supportsPopupHover("linux", { XDG_SESSION_TYPE: "wayland" }, [
          "lumine",
          "--",
          "--ozone-platform=x11",
        ]),
      );
    });

    it("opens only a top-level item's native submenu with the requested options", async () => {
      const window = new EventEmitter();
      const nested = { label: "Nested", id: "nested", submenu: [] };
      applicationMenu.update(
        window,
        [{ label: "File", id: "file", submenu: [{ label: "Save", submenu: [nested] }] }],
        {},
      );
      const builds = useFakeMenuBuilder();

      const result = applicationMenu.showPopup(window, popupRequest({ sourceType: "keyboard" }));
      const submenu = builds[0].menu.items[0].submenu;
      assert.lengthOf(submenu.popupCalls, 1);
      assert.strictEqual(submenu.popupCalls[0].window, window);
      assert.strictEqual(submenu.popupCalls[0].x, 12);
      assert.strictEqual(submenu.popupCalls[0].y, 34);
      assert.strictEqual(submenu.popupCalls[0].sourceType, "keyboard");

      submenu.popupCalls[0].callback();
      assert.isTrue(await result);
      assert.isFalse(applicationMenu.closePopup(window));

      assert.isFalse(await applicationMenu.showPopup(window, popupRequest({ id: "nested" })));
    });

    it("reuses the installed native submenu and its current item state", async () => {
      const window = new EventEmitter();
      const builds = useFakeMenuBuilder();
      applicationMenu.addWindow(window);
      applicationMenu.update(
        window,
        [
          {
            label: "File",
            id: "file",
            submenu: [{ label: "Save", command: "core:save", enabled: true }],
          },
        ],
        {},
      );
      const nativeSubmenu = builds[0].menu.items[0].submenu;
      nativeSubmenu.items[0].enabled = false;

      const result = applicationMenu.showPopup(window, popupRequest());
      assert.lengthOf(builds, 1);
      assert.isFalse(nativeSubmenu.items[0].enabled);
      nativeSubmenu.popupCalls[0].callback();
      assert.isTrue(await result);
    });

    it("builds overflow items in canonical order from the exact window template", async () => {
      const first = new EventEmitter();
      const second = new EventEmitter();
      applicationMenu.update(first, [{ label: "Wrong", id: "wrong", submenu: [] }], {});
      applicationMenu.update(
        second,
        [
          {
            label: "File",
            id: "file",
            submenu: [{ label: "Save", command: "core:save", enabled: false }],
          },
          { label: "Edit", id: "edit", submenu: [] },
          { label: "View", id: "view", visible: false, submenu: [] },
        ],
        { "core:save": ["ctrl-s"] },
      );
      const builds = useFakeMenuBuilder();

      const result = applicationMenu.showPopup(second, overflowPopupRequest(["view", "file"]));
      assert.deepEqual(
        builds[0].template.map(({ id }) => id),
        ["file", "view"],
      );
      assert.strictEqual(builds[0].template[0].submenu[0].accelerator, "Ctrl+S");
      assert.isFalse(builds[0].template[0].submenu[0].enabled);
      assert.isFalse(builds[0].template[1].visible);
      builds[0].template[0].submenu[0].click();
      assert.deepStrictEqual(sentCommands, [["core:save", undefined]]);

      builds[0].menu.popupCalls[0].callback();
      assert.isTrue(await result);

      const oneItemResult = applicationMenu.showPopup(
        second,
        overflowPopupRequest(["edit"], { sourceType: "keyboard" }),
      );
      assert.deepEqual(
        builds[1].template.map(({ id }) => id),
        ["edit"],
      );
      builds[1].menu.popupCalls[0].callback();
      assert.isTrue(await oneItemResult);
    });

    it("requests one renderer-local switch after the pointer moves over another anchor", async () => {
      const sent = [];
      const window = Object.assign(new EventEmitter(), {
        getContentBounds: () => ({ x: 100, y: 200, width: 800, height: 600 }),
        webContents: {
          send: (...args) => sent.push(args),
          isDestroyed: () => false,
        },
      });
      applicationMenu.update(
        window,
        [
          { label: "File", id: "file", submenu: [] },
          { label: "Edit", id: "edit", submenu: [] },
        ],
        {},
      );
      const builds = useFakeMenuBuilder();
      applicationMenu.supportsPopupHover = () => true;
      const cursorPoints = [
        { x: 110, y: 210 },
        { x: 110, y: 210 },
        { x: 115, y: 210 },
        { x: 155, y: 210 },
        { x: 160, y: 210 },
      ];
      applicationMenu.getCursorScreenPoint = () => cursorPoints.shift();
      let poll;
      const timer = { unref() {} };
      applicationMenu.setPopupHoverInterval = (callback) => {
        poll = callback;
        return timer;
      };
      const cleared = [];
      applicationMenu.clearPopupHoverInterval = (value) => cleared.push(value);

      const result = applicationMenu.showPopup(
        window,
        popupRequest({
          hoverTargets: [submenuHoverTarget("file"), submenuHoverTarget("edit", 40)],
        }),
      );
      assert.isFalse(poll());
      assert.isFalse(poll());
      assert.isTrue(poll());
      assert.deepEqual(sent, [
        [
          "application-menu-popup-switch",
          {
            from: "submenu:file",
            target: { key: "submenu:edit", kind: "submenu", id: "edit" },
          },
        ],
      ]);
      assert.deepEqual(cleared, [timer]);
      assert.isFalse(poll());
      assert.lengthOf(sent, 1);

      builds[0].menu.items[0].submenu.popupCalls[0].callback();
      assert.isTrue(await result);
    });

    it("uses the visual overflow anchor when a hidden submenu was opened by mnemonic", async () => {
      const sent = [];
      const window = Object.assign(new EventEmitter(), {
        getContentBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
        webContents: {
          send: (...args) => sent.push(args),
          isDestroyed: () => false,
        },
      });
      applicationMenu.update(
        window,
        [
          { label: "File", id: "file", submenu: [] },
          { label: "Edit", id: "edit", submenu: [] },
          { label: "Help", id: "help", submenu: [] },
        ],
        {},
      );
      const builds = useFakeMenuBuilder();
      applicationMenu.supportsPopupHover = () => true;
      const cursorPoints = [
        { x: 95, y: 30 },
        { x: 20, y: 30 },
      ];
      applicationMenu.getCursorScreenPoint = () => cursorPoints.shift();
      let poll;
      applicationMenu.setPopupHoverInterval = (callback) => {
        poll = callback;
        return { unref() {} };
      };
      applicationMenu.clearPopupHoverInterval = () => {};

      const result = applicationMenu.showPopup(
        window,
        popupRequest({
          id: "help",
          activeHoverTarget: "overflow",
          hoverTargets: [submenuHoverTarget("file"), overflowHoverTarget(["edit", "help"], 70)],
        }),
      );
      assert.isTrue(poll());
      assert.deepEqual(sent, [
        [
          "application-menu-popup-switch",
          {
            from: "overflow",
            target: { key: "submenu:file", kind: "submenu", id: "file" },
          },
        ],
      ]);

      builds[0].menu.items[2].submenu.popupCalls[0].callback();
      assert.isTrue(await result);
    });

    it("stops hover polling when a popup finishes, fails, updates, closes, or loses its window", async () => {
      let timerId = 0;
      const cleared = [];
      applicationMenu.supportsPopupHover = () => true;
      applicationMenu.getCursorScreenPoint = () => ({ x: 0, y: 0 });
      applicationMenu.setPopupHoverInterval = () => ({ id: ++timerId, unref() {} });
      applicationMenu.clearPopupHoverInterval = (timer) => cleared.push(timer.id);
      useFakeMenuBuilder();

      const createWindow = () =>
        Object.assign(new EventEmitter(), {
          getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
          webContents: { send() {}, isDestroyed: () => false },
        });
      const open = (window) => {
        applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
        const promise = applicationMenu.showPopup(window, popupRequest());
        return { promise, record: applicationMenu.windowPopups.get(window) };
      };

      const finishedWindow = createWindow();
      const finished = open(finishedWindow);
      finished.record.menu.popupCalls.at(-1).callback();
      assert.isTrue(await finished.promise);

      const closedWindow = createWindow();
      const closed = open(closedWindow);
      assert.isTrue(applicationMenu.closePopup(closedWindow));
      assert.isTrue(await closed.promise);

      const updatedWindow = createWindow();
      const updated = open(updatedWindow);
      applicationMenu.update(updatedWindow, [{ label: "Edit", id: "edit", submenu: [] }], {});
      assert.isTrue(await updated.promise);

      const lostWindow = createWindow();
      applicationMenu.addWindow(lostWindow);
      const lost = open(lostWindow);
      lostWindow.emit("closed");
      assert.isTrue(await lost.promise);

      const failedWindow = createWindow();
      const failed = open(failedWindow);
      const error = new Error("close failed");
      failed.record.menu.closePopup = () => {
        throw error;
      };
      const rejection = failed.promise.then(
        () => assert.fail("close failure was accepted"),
        (actualError) => actualError,
      );
      assert.throws(() => applicationMenu.closePopup(failedWindow), /close failed/);
      assert.strictEqual(await rejection, error);

      assert.deepEqual(cleared, [1, 2, 3, 4, 5]);
    });

    it("returns false instead of opening a missing or stale menu", async () => {
      const window = new EventEmitter();
      const builds = useFakeMenuBuilder();

      assert.isFalse(await applicationMenu.showPopup(window, popupRequest()));
      applicationMenu.update(window, [{ label: "File", id: "file" }], {});
      assert.isFalse(await applicationMenu.showPopup(window, popupRequest()));
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
      assert.isFalse(
        await applicationMenu.showPopup(
          window,
          overflowPopupRequest(["file", "missing"], { x: 1, y: 2 }),
        ),
      );
      assert.lengthOf(builds, 0);
    });

    it("keeps one popup per window and closes it explicitly or before an update", async () => {
      const window = new EventEmitter();
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
      const builds = useFakeMenuBuilder();

      const firstResult = applicationMenu.showPopup(window, popupRequest());
      const firstSubmenu = builds[0].menu.items[0].submenu;
      assert.isTrue(applicationMenu.closePopup(window));
      assert.deepEqual(firstSubmenu.closePopupCalls, [window]);
      assert.isTrue(await firstResult);
      assert.isFalse(applicationMenu.closePopup(window));

      const secondResult = applicationMenu.showPopup(window, popupRequest());
      applicationMenu.update(window, [{ label: "Edit", id: "edit", submenu: [] }], {});
      assert.deepEqual(firstSubmenu.closePopupCalls, [window, window]);
      assert.isTrue(await secondResult);
    });

    it("waits for the close callback before resolving or opening a replacement", async () => {
      const window = new EventEmitter();
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
      const builds = useFakeMenuBuilder();

      const firstResult = applicationMenu.showPopup(window, popupRequest());
      const submenu = builds[0].menu.items[0].submenu;
      submenu.closePopup = function (closedWindow) {
        this.closePopupCalls.push(closedWindow);
      };
      let firstSettled = false;
      firstResult.then(() => {
        firstSettled = true;
      });

      assert.isTrue(applicationMenu.closePopup(window));
      assert.isFalse(applicationMenu.closePopup(window));
      const secondResult = applicationMenu.showPopup(
        window,
        popupRequest({ sourceType: "keyboard" }),
      );
      await Promise.resolve();
      assert.isFalse(firstSettled);
      assert.lengthOf(submenu.popupCalls, 1);

      submenu.popupCalls[0].callback();
      assert.isTrue(await firstResult);
      assert.lengthOf(submenu.popupCalls, 2);
      submenu.popupCalls[1].callback();
      assert.isTrue(await secondResult);
    });

    it("closes a popup when its window closes", async () => {
      const window = new EventEmitter();
      const builds = useFakeMenuBuilder();
      applicationMenu.addWindow(window);
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});

      const result = applicationMenu.showPopup(window, popupRequest());
      const submenu = builds[0].menu.items[0].submenu;
      window.emit("closed");

      assert.deepEqual(submenu.closePopupCalls, [window]);
      assert.isTrue(await result);
    });

    it("rejects Electron popup failures and clears the popup record", async () => {
      const window = new EventEmitter();
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
      const error = new Error("native popup failed");

      Menu.buildFromTemplate = (template) => {
        const menu = createFakeMenu(template);
        menu.items[0].submenu.popup = () => {
          throw error;
        };
        return menu;
      };
      await applicationMenu.showPopup(window, popupRequest()).then(
        () => assert.fail("popup failure was accepted"),
        (actualError) => assert.strictEqual(actualError, error),
      );
      assert.isFalse(applicationMenu.closePopup(window));
    });

    it("keeps menu updates safe when Electron refuses to close a popup", async () => {
      const window = new EventEmitter();
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
      const builds = useFakeMenuBuilder();
      const result = applicationMenu.showPopup(window, popupRequest());
      const error = new Error("update close failed");
      builds[0].menu.items[0].submenu.closePopup = () => {
        throw error;
      };
      const rejection = result.then(
        () => assert.fail("update close failure was accepted"),
        (actualError) => actualError,
      );

      assert.doesNotThrow(() =>
        applicationMenu.update(window, [{ label: "Edit", id: "edit", submenu: [] }], {}),
      );
      assert.strictEqual(await rejection, error);
    });

    it("keeps the window closed handler safe when Electron refuses to close a popup", async () => {
      const window = new EventEmitter();
      const builds = useFakeMenuBuilder();
      applicationMenu.addWindow(window);
      applicationMenu.update(window, [{ label: "File", id: "file", submenu: [] }], {});
      const result = applicationMenu.showPopup(window, popupRequest());
      const error = new Error("window close failed");
      builds[0].menu.items[0].submenu.closePopup = () => {
        throw error;
      };
      const rejection = result.then(
        () => assert.fail("window close failure was accepted"),
        (actualError) => actualError,
      );

      assert.doesNotThrow(() => window.emit("closed"));
      assert.strictEqual(await rejection, error);
    });
  });

  describe("::addWindow(window)", () => {
    it("adopts the first window as the focused one", () => {
      const window = new EventEmitter();
      applicationMenu.addWindow(window);

      assert.strictEqual(applicationMenu.lastFocusedWindow, window);
    });

    it("reinstalls a window's remembered template when it takes focus", () => {
      const first = new EventEmitter();
      const second = new EventEmitter();
      applicationMenu.addWindow(first);
      applicationMenu.addWindow(second);
      applicationMenu.update(second, [{ label: "Second" }], {});

      const installedBefore = installedMenus.length;
      second.emit("focus");

      assert.strictEqual(applicationMenu.lastFocusedWindow, second);
      assert.strictEqual(installedMenus.length, installedBefore + 1);
    });

    it("forgets a window when it closes", () => {
      const window = new EventEmitter();
      applicationMenu.addWindow(window);
      applicationMenu.update(window, [{ label: "One" }], {});
      window.emit("closed");

      assert.isNull(applicationMenu.lastFocusedWindow);
      assert.isUndefined(applicationMenu.windowTemplates.get(window));
    });

    it("uses the owner window's template while a detached surface is focused", () => {
      const owner = new EventEmitter();
      const surface = new EventEmitter();
      applicationMenu.addWindow(owner);
      applicationMenu.update(owner, [{ label: "Owner" }], {});

      applicationMenu.focusSurfaceWindow(surface, owner);
      assert.strictEqual(applicationMenu.lastFocusedWindow, surface);
      assert.strictEqual(applicationMenu.activeTemplate[0].label, "Owner");

      applicationMenu.update(owner, [{ label: "Updated Owner" }], {});
      assert.strictEqual(applicationMenu.activeTemplate[0].label, "Updated Owner");
    });
  });

  describe("::enableWindowSpecificItems(enable)", () => {
    it("disables the window-specific items and leaves the application ones alone", () => {
      const template = [
        {
          label: "File",
          submenu: [
            { label: "Save", command: "core:save" },
            { label: "About", command: "application:about" },
          ],
        },
      ];
      applicationMenu.translateTemplate(template, {});
      applicationMenu.setActiveTemplate(template);

      applicationMenu.enableWindowSpecificItems(false);
      const items = applicationMenu.flattenMenuItems(applicationMenu.menu);
      const save = items.find((item) => item.label === "Save");
      const about = items.find((item) => item.label === "About");

      assert.isFalse(save.enabled);
      assert.isTrue(about.enabled);
    });
  });
});
