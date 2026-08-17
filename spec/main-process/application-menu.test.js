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
