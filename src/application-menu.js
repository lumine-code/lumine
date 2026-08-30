const { app, Menu, screen } = require("electron");
const _ = require("@lumine-code/underscore-plus");
const MenuHelpers = require("./menu-helpers");

function commandLineSwitchValue(argv, name) {
  const prefix = `--${name}=`;
  const argumentLimit = argv.indexOf("--");
  const lastIndex = argumentLimit === -1 ? argv.length - 1 : argumentLimit - 1;

  for (let index = lastIndex; index >= 0; index--) {
    const argument = argv[index];
    if (typeof argument === "string" && argument.toLowerCase().startsWith(prefix)) {
      return argument.slice(prefix.length).toLowerCase();
    }
  }

  return null;
}

function usesWayland(platform, environment, argv) {
  if (platform !== "linux") return false;

  const ozonePlatform = commandLineSwitchValue(argv, "ozone-platform");
  if (ozonePlatform === "x11") return false;
  if (ozonePlatform === "wayland") return true;

  return (
    environment?.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
    Boolean(environment?.WAYLAND_DISPLAY?.trim())
  );
}

/**
 * Used to manage the global application menu.
 *
 * It's created by `LumineApplication` upon instantiation and used to add, remove
 * and maintain the state of all menu items. It runs in the main process; a
 * package reaches the menu through {@link MenuManager} instead.
 *
 * @private
 */
module.exports = class ApplicationMenu {
  constructor(version) {
    this.version = version;
    this.windowTemplates = new WeakMap();
    this.windowPopups = new WeakMap();
    this.setActiveTemplate(this.getDefaultTemplate());
  }

  static supportsPopupHover(
    platform = process.platform,
    environment = process.env,
    argv = process.argv,
  ) {
    return !usesWayland(platform, environment, argv);
  }

  supportsPopupHover() {
    return this.constructor.supportsPopupHover();
  }

  getCursorScreenPoint() {
    return screen.getCursorScreenPoint();
  }

  setPopupHoverInterval(callback) {
    return setInterval(callback, 30);
  }

  clearPopupHoverInterval(timer) {
    clearInterval(timer);
  }

  /**
   * @public
   * @status public
   *
   * Updates the entire menu with the given keybindings.
   *
   * window - The BrowserWindow this menu template is associated with.
   * template - The Object which describes the menu to display.
   * keystrokesByCommand - An Object where the keys are commands and the values
   *                       are Arrays containing the keystroke.
   */
  update(window, template, keystrokesByCommand) {
    this.closePopupSafely(window);
    this.translateTemplate(template, keystrokesByCommand);
    this.substituteVersion(template);
    this.windowTemplates.set(window, template);
    if (window === this.lastFocusedWindow) return this.setActiveTemplate(template);
  }

  setActiveTemplate(template) {
    if (!_.isEqual(template, this.activeTemplate)) {
      this.activeTemplate = template;
      this.menu = Menu.buildFromTemplate(_.deepClone(template));
      Menu.setApplicationMenu(this.menu);
    }

    return;
  }

  // Register a BrowserWindow with this application menu.
  addWindow(window) {
    if (this.lastFocusedWindow == null) this.lastFocusedWindow = window;

    const focusHandler = () => {
      this.lastFocusedWindow = window;
      const template = this.windowTemplates.get(window);
      if (template) this.setActiveTemplate(template);
    };

    window.on("focus", focusHandler);
    window.once("closed", () => {
      this.closePopupSafely(window);
      if (window === this.lastFocusedWindow) this.lastFocusedWindow = null;
      this.windowTemplates.delete(window);
      window.removeListener("focus", focusHandler);
    });

    this.enableWindowSpecificItems(true);
  }

  /**
   * Opens a native popup backed by the application-menu template associated
   * with `window`.
   *
   * A submenu request opens one top-level item's existing native submenu. An
   * overflow request builds a temporary menu from the requested top-level
   * items in their canonical template order.
   *
   * Returns a Promise resolving to true after the popup closes, or false when
   * the window has no current template matching the request.
   */
  async showPopup(window, request) {
    const template = this.windowTemplates.get(window);
    if (!template || window.isDestroyed?.()) return false;

    if (request.kind === "submenu") {
      const item = template.find(({ id }) => id === request.id);
      if (!item || !Array.isArray(item.submenu)) return false;
    } else {
      const ids = new Set(request.ids);
      const items = template.filter(({ id }) => ids.has(id));
      if (items.length !== ids.size) return false;
    }
    if (!request.hoverTargets.every((target) => this.popupTargetExists(template, target))) {
      return false;
    }

    let previousPopup;
    while ((previousPopup = this.windowPopups.get(window))) {
      this.closePopup(window);
      await previousPopup.promise;
      if (this.windowTemplates.get(window) !== template || window.isDestroyed?.()) return false;
    }

    let menu;
    if (request.kind === "submenu") {
      this.setActiveTemplate(template);
      const nativeItem = this.menu.items.find(({ id }) => id === request.id);
      if (!nativeItem?.submenu) return false;
      menu = nativeItem.submenu;
    } else {
      const ids = new Set(request.ids);
      const items = template.filter(({ id }) => ids.has(id));
      menu = Menu.buildFromTemplate(_.deepClone(items));
    }

    let resolvePopup, rejectPopup;
    const popupPromise = new Promise((resolve, reject) => {
      resolvePopup = resolve;
      rejectPopup = reject;
    });
    const record = {
      menu,
      promise: popupPromise,
      resolve: resolvePopup,
      reject: rejectPopup,
      settled: false,
      closing: false,
      activeHoverTarget: request.activeHoverTarget,
      hoverTargets: request.hoverTargets,
      hoverTimer: null,
      lastCursorPoint: null,
      switchRequested: false,
    };
    this.windowPopups.set(window, record);

    const callback = () => this.finishPopup(window, record);
    try {
      menu.popup({
        window,
        x: request.x,
        y: request.y,
        sourceType: request.sourceType,
        callback,
      });
      this.startPopupHoverMonitor(window, record);
    } catch (error) {
      this.failPopup(window, record, error);
    }
    return popupPromise;
  }

  /**
   * Closes the native application-menu popup owned by `window`.
   *
   * Returns true when a popup was closed and false when there was none.
   */
  closePopup(window) {
    const record = this.windowPopups.get(window);
    if (!record || record.closing) return false;

    this.stopPopupHoverMonitor(record);

    if (window.isDestroyed?.()) {
      this.finishPopup(window, record);
      return true;
    }

    record.closing = true;
    try {
      record.menu.closePopup(window);
    } catch (error) {
      this.failPopup(window, record, error);
      throw error;
    }
    return true;
  }

  closePopupSafely(window) {
    try {
      return this.closePopup(window);
    } catch {
      return false;
    }
  }

  finishPopup(window, record) {
    if (record.settled) return;
    record.settled = true;
    this.stopPopupHoverMonitor(record);
    if (this.windowPopups.get(window) === record) this.windowPopups.delete(window);
    record.resolve(true);
  }

  failPopup(window, record, error) {
    if (record.settled) return;
    record.settled = true;
    this.stopPopupHoverMonitor(record);
    if (this.windowPopups.get(window) === record) this.windowPopups.delete(window);
    record.reject(error);
  }

  popupTargetExists(template, target) {
    if (target.kind === "submenu") {
      const item = template.find(({ id }) => id === target.id);
      return Array.isArray(item?.submenu);
    }

    const ids = new Set(target.ids);
    return template.filter(({ id }) => ids.has(id)).length === ids.size;
  }

  startPopupHoverMonitor(window, record) {
    if (
      record.settled ||
      !this.supportsPopupHover() ||
      typeof window.getContentBounds !== "function" ||
      typeof window.webContents?.send !== "function" ||
      window.webContents.isDestroyed?.()
    ) {
      return;
    }

    try {
      record.lastCursorPoint = this.getCursorScreenPoint();
    } catch {
      return;
    }

    try {
      record.hoverTimer = this.setPopupHoverInterval(() => this.pollPopupHover(window, record));
      record.hoverTimer.unref?.();
    } catch {
      record.hoverTimer = null;
    }
  }

  stopPopupHoverMonitor(record) {
    if (record.hoverTimer == null) return;
    this.clearPopupHoverInterval(record.hoverTimer);
    record.hoverTimer = null;
  }

  pollPopupHover(window, record) {
    if (
      record !== this.windowPopups.get(window) ||
      record.settled ||
      record.closing ||
      record.switchRequested
    ) {
      this.stopPopupHoverMonitor(record);
      return false;
    }

    let cursorPoint, contentBounds;
    try {
      cursorPoint = this.getCursorScreenPoint();
      contentBounds = window.getContentBounds();
    } catch {
      this.stopPopupHoverMonitor(record);
      return false;
    }

    if (
      cursorPoint.x === record.lastCursorPoint?.x &&
      cursorPoint.y === record.lastCursorPoint?.y
    ) {
      return false;
    }
    record.lastCursorPoint = cursorPoint;

    const x = cursorPoint.x - contentBounds.x;
    const y = cursorPoint.y - contentBounds.y;
    const target = record.hoverTargets.find(
      ({ bounds }) =>
        x >= bounds.x &&
        x < bounds.x + bounds.width &&
        y >= bounds.y &&
        y < bounds.y + bounds.height,
    );
    if (!target || target.key === record.activeHoverTarget) return false;

    record.switchRequested = true;
    this.stopPopupHoverMonitor(record);
    if (window.webContents.isDestroyed?.()) return false;

    const { bounds: _bounds, ...eventTarget } = target;
    try {
      window.webContents.send("application-menu-popup-switch", {
        from: record.activeHoverTarget,
        target: eventTarget,
      });
    } catch {
      return false;
    }
    return true;
  }

  // Flattens the given menu and submenu items into a single Array.
  //
  // menu - A complete menu configuration object for Electron's menu API.
  //
  // Returns an Array of native menu items.
  flattenMenuItems(menu) {
    const object = menu.items || {};
    let items = [];
    for (let index in object) {
      const item = object[index];
      items.push(item);
      if (item.submenu) items = items.concat(this.flattenMenuItems(item.submenu));
    }
    return items;
  }

  // Flattens the given menu template into a single Array.
  //
  // template - An object describing the menu item.
  //
  // Returns an Array of native menu items.
  flattenMenuTemplate(template) {
    let items = [];
    for (let item of template) {
      items.push(item);
      if (item.submenu) items = items.concat(this.flattenMenuTemplate(item.submenu));
    }
    return items;
  }

  /**
   * @public
   * @status public
   *
   * Used to make all window related menu items are active.
   *
   * enable - If true enables all window specific items, if false disables all
   *          window specific items.
   */
  enableWindowSpecificItems(enable) {
    for (let item of this.flattenMenuItems(this.menu)) {
      if (item.metadata && item.metadata.windowSpecific) item.enabled = enable;
    }
  }

  // Replaces VERSION with the current version.
  substituteVersion(template) {
    let item = this.flattenMenuTemplate(template).find(({ label }) => label === "VERSION");
    if (item) item.label = `Version ${this.version}`;
  }

  // Default list of menu items.
  //
  // Returns an Array of menu item Objects.
  getDefaultTemplate() {
    return [
      {
        label: "Lumine",
        id: "Lumine",
        submenu: [
          {
            label: "Reload",
            id: "Reload",
            accelerator: "Command+R",
            click: () => {
              const window = this.focusedWindow();
              if (window) window.reload();
            },
          },
          {
            label: "Close Window",
            id: "Close Window",
            accelerator: "Command+Shift+W",
            click: () => {
              const window = this.focusedWindow();
              if (window) window.close();
            },
          },
          {
            label: "Toggle Dev Tools",
            id: "Toggle Dev Tools",
            accelerator: "Command+Alt+I",
            click: () => {
              const window = this.focusedWindow();
              if (window) window.toggleDevTools();
            },
          },
          {
            label: "Quit",
            id: "Quit",
            accelerator: "Command+Q",
            click: () => app.quit(),
          },
        ],
      },
    ];
  }

  focusedWindow() {
    return global.lumineApplication.getAllWindows().find((window) => window.isFocused());
  }

  // Combines a menu template with the appropriate keystroke.
  //
  // template - An Object conforming to Electron's menu API but lacking
  //            accelerator and click properties.
  // keystrokesByCommand - An Object where the keys are commands and the values
  //                       are Arrays containing the keystroke.
  //
  // Returns a complete menu configuration object for Electron's menu API.
  translateTemplate(template, keystrokesByCommand) {
    template.forEach((item) => {
      if (item.metadata == null) item.metadata = {};
      if (item.command) {
        // The renderer builds this map with a null prototype, but the
        // structured clone that carries it across IPC does not preserve one:
        // what arrives here is an ordinary object again. Own keys survive, so
        // a real binding still resolves — but an *unbound* command named
        // `constructor` would otherwise resolve to `Object`, whose `length` of
        // 1 passes the guard below and whose `[0]` is undefined.
        const keystrokes = Object.hasOwn(keystrokesByCommand, item.command)
          ? keystrokesByCommand[item.command]
          : null;
        if (keystrokes && keystrokes.length > 0) {
          const keystroke = keystrokes[0];
          // Electron does not support multi-keystroke accelerators. Therefore,
          // when the command maps to a multi-stroke key binding, show the
          // keystrokes next to the item's label.
          if (keystroke.includes(" ")) {
            item.label += ` [${_.humanizeKeystroke(keystroke)}]`;
          } else if (
            item.command === "core:paste" ||
            item.command === "editor:paste-without-reformatting"
          ) {
            // Paste must reach the renderer as a keyboard event so Chromium can
            // expose custom formats through ClipboardEvent. Show the shortcut
            // without creating a second command source in Electron's menu.
            item.label += ` [${_.humanizeKeystroke(keystroke)}]`;
          } else {
            item.accelerator = MenuHelpers.acceleratorForKeystroke(keystroke);
          }
        }
        item.click = () => global.lumineApplication.sendCommand(item.command, item.commandDetail);
        if (!/^application:/.test(item.command)) {
          item.metadata.windowSpecific = true;
        }
      }
      if (item.submenu) this.translateTemplate(item.submenu, keystrokesByCommand);
    });
    return template;
  }
};
