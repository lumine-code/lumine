const assert = require("./assert");
const { Menu } = require("electron");
const { EventEmitter } = require("events");

const MacApplicationMenu = require("../../src/application-menu");

describe("MacApplicationMenu", () => {
  const humanized = (windows) => (process.platform === "darwin" ? windows.darwin : windows.other);

  let applicationMenu;
  let builtTemplates;
  let installedMenus;
  let originalBuildFromTemplate;
  let originalSetApplicationMenu;
  let originalLumineApplication;
  let sentCommands;

  const buildFakeMenu = (template) => ({
    items: template.map(({ metadata: _metadata, ...item }) => ({
      ...item,
      enabled: item.enabled !== false,
      submenu: Array.isArray(item.submenu) ? buildFakeMenu(item.submenu) : undefined,
    })),
  });

  const createWindow = (focused = false) => {
    const window = new EventEmitter();
    window.isFocused = () => focused;
    return window;
  };

  beforeEach(() => {
    builtTemplates = [];
    installedMenus = [];
    sentCommands = [];

    originalBuildFromTemplate = Menu.buildFromTemplate;
    originalSetApplicationMenu = Menu.setApplicationMenu;
    Menu.buildFromTemplate = (template) => {
      builtTemplates.push(template);
      return buildFakeMenu(template);
    };
    Menu.setApplicationMenu = (menu) => installedMenus.push(menu);

    originalLumineApplication = global.lumineApplication;
    global.lumineApplication = {
      sendCommand: (command, detail) => sentCommands.push([command, detail]),
    };

    applicationMenu = new MacApplicationMenu("1.2.3");
  });

  afterEach(() => {
    Menu.buildFromTemplate = originalBuildFromTemplate;
    Menu.setApplicationMenu = originalSetApplicationMenu;
    global.lumineApplication = originalLumineApplication;
  });

  it("installs a minimal system menu before a renderer supplies its template", () => {
    assert.strictEqual(installedMenus.length, 1);
    const items = builtTemplates[0][0].submenu;
    assert.deepStrictEqual(
      items.filter(({ role }) => role).map(({ role }) => role),
      ["services", "hide", "hideOthers", "unhide", "quit"],
    );

    items.find(({ label }) => label === "New Window").click();
    assert.deepStrictEqual(sentCommands, [["application:new-window", undefined]]);
  });

  describe("::translateTemplate", () => {
    it("adds accelerators and displays chords and paste bindings in labels", () => {
      const template = [
        { label: "Save", command: "core:save" },
        { label: "Run", command: "run", metadata: {} },
        { label: "Paste", command: "core:paste" },
      ];

      applicationMenu.translateTemplate(template, {
        "core:save": ["ctrl-s"],
        run: ["ctrl-a ctrl-b"],
        "core:paste": ["ctrl-v"],
      });

      assert.strictEqual(template[0].accelerator, "Ctrl+S");
      assert.strictEqual(
        template[1].label,
        `Run [${humanized({ darwin: "⌃A ⌃B", other: "Ctrl+A Ctrl+B" })}]`,
      );
      assert.strictEqual(
        template[2].label,
        `Paste [${humanized({ darwin: "⌃V", other: "Ctrl+V" })}]`,
      );
      assert.isUndefined(template[2].accelerator);
    });

    it("marks window commands, preserves roles, and routes clicks through the application", () => {
      const detail = { source: "menu" };
      const template = [
        { label: "Save", command: "core:save", commandDetail: detail },
        { label: "About", command: "application:about" },
        { label: "Services", role: "services", submenu: [] },
      ];

      applicationMenu.translateTemplate(template, {});
      template[0].click();

      assert.isTrue(template[0].metadata.windowSpecific);
      assert.isUndefined(template[1].metadata.windowSpecific);
      assert.strictEqual(template[2].role, "services");
      assert.deepStrictEqual(sentCommands, [["core:save", detail]]);
    });

    it("ignores inherited binding-map keys after structured clone", () => {
      const template = [{ label: "Break", command: "constructor" }];
      applicationMenu.translateTemplate(template, {});
      assert.isUndefined(template[0].accelerator);
    });
  });

  it("substitutes the first VERSION placeholder at any depth", () => {
    const template = [{ label: "Lumine", submenu: [{ label: "VERSION" }] }, { label: "VERSION" }];
    applicationMenu.substituteVersion(template);
    assert.strictEqual(template[0].submenu[0].label, "Version 1.2.3");
    assert.strictEqual(template[1].label, "VERSION");
  });

  it("keeps templates per window and installs the focused window's menu", () => {
    const first = createWindow();
    const second = createWindow();
    applicationMenu.addWindow(first);
    applicationMenu.addWindow(second);

    applicationMenu.update(first, [{ label: "First" }], {});
    applicationMenu.update(second, [{ label: "Second" }], {});
    assert.strictEqual(applicationMenu.activeTemplate[0].label, "First");

    second.emit("focus");
    assert.strictEqual(applicationMenu.activeTemplate[0].label, "Second");
  });

  it("falls back to another window's remembered menu when the active window closes", () => {
    const first = createWindow();
    const second = createWindow();
    applicationMenu.addWindow(first);
    applicationMenu.addWindow(second);
    applicationMenu.update(first, [{ label: "First" }], {});
    applicationMenu.update(second, [{ label: "Second" }], {});
    second.emit("focus");

    second.emit("closed");

    assert.strictEqual(applicationMenu.lastFocusedWindow, first);
    assert.strictEqual(applicationMenu.activeTemplate[0].label, "First");
  });

  it("keeps the last complete menu but disables window commands after the final window closes", () => {
    const window = createWindow();
    applicationMenu.addWindow(window);
    applicationMenu.update(
      window,
      [
        { label: "Save", command: "core:save" },
        { label: "Unavailable", command: "core:unavailable", enabled: false },
        { label: "About", command: "application:about" },
      ],
      {},
    );

    window.emit("closed");

    assert.strictEqual(applicationMenu.activeTemplate[0].label, "Save");
    assert.isFalse(applicationMenu.menu.items[0].enabled);
    assert.isFalse(applicationMenu.menu.items[1].enabled);
    assert.isTrue(applicationMenu.menu.items[2].enabled);

    applicationMenu.addWindow(createWindow());
    assert.isTrue(applicationMenu.menu.items[0].enabled);
    assert.isFalse(applicationMenu.menu.items[1].enabled);
    assert.isTrue(applicationMenu.menu.items[2].enabled);
  });

  it("has no native popup backend", () => {
    assert.isUndefined(applicationMenu.showPopup);
    assert.isUndefined(applicationMenu.closePopup);
  });
});
