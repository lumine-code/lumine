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
  let sentCommandOptions;

  const buildFakeMenu = (template) => {
    const menu = new EventEmitter();
    menu.items = template.map(({ metadata: _metadata, ...item }) => ({
      ...item,
      enabled: item.enabled !== false,
      submenu: Array.isArray(item.submenu) ? buildFakeMenu(item.submenu) : undefined,
    }));
    return menu;
  };

  const createWindow = (focused = false) => {
    const window = new EventEmitter();
    window.isFocused = () => focused;
    window.messages = [];
    window.webContents = {
      isDestroyed: () => false,
      send: (...args) => window.messages.push(args),
    };
    return window;
  };

  beforeEach(() => {
    builtTemplates = [];
    installedMenus = [];
    sentCommands = [];
    sentCommandOptions = [];

    originalBuildFromTemplate = Menu.buildFromTemplate;
    originalSetApplicationMenu = Menu.setApplicationMenu;
    Menu.buildFromTemplate = (template) => {
      builtTemplates.push(template);
      return buildFakeMenu(template);
    };
    Menu.setApplicationMenu = (menu) => installedMenus.push(menu);

    originalLumineApplication = global.lumineApplication;
    global.lumineApplication = {
      sendCommand: (command, detail, options) => {
        sentCommands.push([command, detail]);
        sentCommandOptions.push(options);
      },
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
        { label: "Save", command: "core:save", keystrokes: ["ctrl-s"] },
        { label: "Run", command: "run", metadata: {}, keystrokes: ["ctrl-a ctrl-b"] },
        { label: "Paste", command: "core:paste", keystrokes: ["ctrl-v"] },
      ];

      applicationMenu.translateTemplate(template);

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

      applicationMenu.translateTemplate(template);
      template[0].click();

      assert.isTrue(template[0].metadata.windowSpecific);
      assert.isUndefined(template[1].metadata.windowSpecific);
      assert.strictEqual(template[2].role, "services");
      assert.deepStrictEqual(sentCommands, [["core:save", detail]]);
    });

    it("uses each row's prepared shortcut without inferring variants from another row", () => {
      const details = [{ redistribute: true }, {}, false, 0, "alternate"];
      const template = [
        { label: "Plain", command: "layout", keystrokes: ["ctrl-s"] },
        { label: "Null Detail", command: "layout", commandDetail: null, keystrokes: ["ctrl-s"] },
        ...details.map((commandDetail, index) => ({
          label: `Variant ${index}`,
          command: "layout",
          commandDetail,
        })),
        {
          label: "Nested",
          submenu: [
            { label: "Plain", command: "layout", keystrokes: ["ctrl-s"] },
            { label: "Variant", command: "layout", commandDetail: { sequentize: true } },
          ],
        },
      ];

      applicationMenu.translateTemplate(template);
      assert.strictEqual(template[0].accelerator, "Ctrl+S");
      assert.strictEqual(template[1].accelerator, "Ctrl+S");
      for (const [index, detail] of details.entries()) {
        const variant = template[index + 2];
        assert.isUndefined(variant.accelerator);
        assert.strictEqual(variant.label, `Variant ${index}`);
        variant.click();
        assert.deepStrictEqual(sentCommands.at(-1), ["layout", detail]);
      }
      const nested = template.at(-1).submenu;
      assert.strictEqual(nested[0].accelerator, "Ctrl+S");
      assert.isUndefined(nested[1].accelerator);
      nested[1].click();
      assert.deepStrictEqual(sentCommands.at(-1), ["layout", { sequentize: true }]);
    });

    it("does not infer a shortcut from a command's name", () => {
      const template = [{ label: "Break", command: "constructor" }];
      applicationMenu.translateTemplate(template);
      assert.isUndefined(template[0].accelerator);
    });

    it("preserves prepared availability and sends scope separately from command details", () => {
      const detail = { alternate: true };
      const template = [
        { label: "Scoped", command: "editor:action", commandDetail: detail, scope: ".editing" },
        { label: "Disabled", command: "editor:action", enabled: false },
      ];
      applicationMenu.translateTemplate(template);
      template[0].click();
      template[1].click();
      assert.deepStrictEqual(sentCommands, [["editor:action", detail]]);
      assert.deepStrictEqual(sentCommandOptions, [{ applicationMenu: true, scope: ".editing" }]);
      assert.isFalse(template[1].enabled);
      assert.isUndefined(template[0].scope);
      assert.isUndefined(template[0].keystrokes);
    });

    it("routes a prepared menu through the window that supplied its template", () => {
      const browserWindow = createWindow();
      const owner = {};
      const routed = [];
      global.lumineApplication.lumineWindowForBrowserWindow = (window) => {
        assert.strictEqual(window, browserWindow);
        return owner;
      };
      global.lumineApplication.sendCommandToWindow = (...args) => routed.push(args);
      const template = [{ label: "Save", command: "core:save" }];
      applicationMenu.translateTemplate(template, browserWindow);
      template[0].click();
      assert.deepStrictEqual(routed, [
        ["core:save", owner, undefined, { applicationMenu: true, scope: undefined }],
      ]);
      assert.deepStrictEqual(sentCommands, []);
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

  describe("native menu visibility", () => {
    const visibilityMessage = (visible, windowId) => [
      "message",
      "did-change-application-menu-visibility",
      { visible, windowId },
    ];

    it("suppresses the menu's window until the whole menu closes, including submenus", () => {
      const first = createWindow();
      const second = createWindow();
      applicationMenu.addWindow(first);
      applicationMenu.addWindow(second);
      const menu = applicationMenu.menu;

      menu.emit("menu-will-show");
      menu.emit("menu-will-show");
      assert.deepStrictEqual(first.messages, [visibilityMessage(true)]);
      assert.deepStrictEqual(second.messages, []);

      menu.emit("menu-will-close");
      assert.deepStrictEqual(first.messages, [visibilityMessage(true), visibilityMessage(false)]);
      assert.isFalse(applicationMenu.menuOpen);
    });

    it("keeps the open menu observed and applies only the newest replacement after close", () => {
      const first = createWindow();
      const second = createWindow();
      applicationMenu.addWindow(first);
      applicationMenu.addWindow(second);
      applicationMenu.update(first, [{ label: "First" }], {});
      applicationMenu.update(second, [{ label: "Second" }], {});
      const menu = applicationMenu.menu;
      menu.emit("menu-will-show");

      second.emit("focus");
      applicationMenu.update(second, [{ label: "Latest" }], {});
      assert.strictEqual(applicationMenu.menu, menu);
      assert.strictEqual(applicationMenu.activeTemplate[0].label, "First");

      menu.emit("menu-will-close");
      assert.deepStrictEqual(first.messages, [visibilityMessage(true), visibilityMessage(false)]);
      assert.deepStrictEqual(second.messages, []);
      assert.strictEqual(applicationMenu.activeTemplate[0].label, "Latest");
      applicationMenu.menu.emit("menu-will-show");
      applicationMenu.menu.emit("menu-will-close");
      assert.deepStrictEqual(second.messages, [visibilityMessage(true), visibilityMessage(false)]);
    });

    it("still observes the previous menu while Cocoa defers installing its replacement", () => {
      const window = createWindow();
      applicationMenu.addWindow(window);
      const previousMenu = applicationMenu.menu;
      previousMenu.emit("menu-will-show");
      applicationMenu.update(window, [{ label: "Replacement" }], {});
      previousMenu.emit("menu-will-close");
      const replacementMenu = applicationMenu.menu;
      assert.notStrictEqual(replacementMenu, previousMenu);

      // Crossing from one top-level menu to the next can still use the old
      // native menu before Cocoa returns to the default run loop mode.
      previousMenu.emit("menu-will-show");
      assert.isTrue(applicationMenu.menuOpen);
      previousMenu.emit("menu-will-close");
      replacementMenu.emit("menu-will-show");
      previousMenu.emit("menu-will-close");
      assert.isTrue(applicationMenu.menuOpen);
      assert.strictEqual(applicationMenu.menuSource, replacementMenu);
      replacementMenu.emit("menu-will-close");

      assert.deepStrictEqual(window.messages, [
        visibilityMessage(true),
        visibilityMessage(false),
        visibilityMessage(true),
        visibilityMessage(false),
        visibilityMessage(true),
        visibilityMessage(false),
      ]);
      assert.isFalse(applicationMenu.menuOpen);
    });

    it("lets a replacement return to the currently installed template while open", () => {
      const window = createWindow();
      applicationMenu.addWindow(window);
      applicationMenu.update(window, [{ label: "Original" }], {});
      const menu = applicationMenu.menu;
      menu.emit("menu-will-show");
      applicationMenu.update(window, [{ label: "Temporary" }], {});
      applicationMenu.update(window, [{ label: "Original" }], {});
      menu.emit("menu-will-close");

      assert.strictEqual(applicationMenu.menu, menu);
      assert.isNull(applicationMenu.pendingTemplate);
      assert.deepStrictEqual(window.messages, [visibilityMessage(true), visibilityMessage(false)]);
    });

    it("addresses an auxiliary presentation through its owning renderer", () => {
      const window = createWindow();
      applicationMenu.addWindow(window);
      global.lumineApplication.lumineWindowForBrowserWindow = (browserWindow) => {
        assert.strictEqual(browserWindow, window);
        return {
          id: 7,
          auxiliaryWindowBroker: { getFocusedRecord: () => ({ id: -23 }) },
        };
      };
      applicationMenu.menu.emit("menu-will-show");
      global.lumineApplication.lumineWindowForBrowserWindow = () => ({ id: 7 });
      applicationMenu.menu.emit("menu-will-close");

      assert.deepStrictEqual(window.messages, [
        visibilityMessage(true, -23),
        visibilityMessage(false, -23),
      ]);
    });

    it("clears the session when its window closes and never sends to destroyed contents", () => {
      const first = createWindow();
      const second = createWindow();
      applicationMenu.addWindow(first);
      applicationMenu.addWindow(second);
      applicationMenu.update(first, [{ label: "First" }], {});
      applicationMenu.update(second, [{ label: "Second" }], {});
      const oldMenu = applicationMenu.menu;
      oldMenu.emit("menu-will-show");
      first.webContents.isDestroyed = () => true;
      first.emit("closed");

      assert.isFalse(applicationMenu.menuOpen);
      assert.isNull(applicationMenu.menuWindow);
      assert.strictEqual(applicationMenu.activeTemplate[0].label, "Second");
      assert.deepStrictEqual(first.messages, [visibilityMessage(true)]);
      oldMenu.emit("menu-will-close");
      applicationMenu.menu.emit("menu-will-show");
      assert.deepStrictEqual(second.messages, [visibilityMessage(true)]);
    });
  });
});
