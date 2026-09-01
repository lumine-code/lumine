const { Menu } = require("electron");
const _ = require("@lumine-code/underscore-plus");
const MenuHelpers = require("./menu-helpers");

/**
 * Presents Lumine's application menu in the macOS system menu bar.
 *
 * Windows and Linux render the same logical template in the editor window. The
 * main-process presenter exists only for macOS integration such as Services,
 * Window, Help, Hide, and Quit.
 *
 * @private
 */
module.exports = class MacApplicationMenu {
  constructor(version) {
    this.version = version;
    this.windows = new Set();
    this.windowTemplates = new WeakMap();
    this.setActiveTemplate(this.getDefaultTemplate());
  }

  /**
   * Replace the system menu template associated with a BrowserWindow.
   */
  update(window, template, keystrokesByCommand) {
    this.translateTemplate(template, keystrokesByCommand);
    this.substituteVersion(template);
    this.windowTemplates.set(window, template);
    if (window === this.lastFocusedWindow) this.setActiveTemplate(template);
  }

  setActiveTemplate(template) {
    if (_.isEqual(template, this.activeTemplate)) return;

    this.activeTemplate = template;
    this.menu = Menu.buildFromTemplate(_.deepClone(template));
    Menu.setApplicationMenu(this.menu);
  }

  addWindow(window) {
    this.windows.add(window);
    if (this.lastFocusedWindow == null) this.lastFocusedWindow = window;

    const focusHandler = () => {
      this.lastFocusedWindow = window;
      const template = this.windowTemplates.get(window);
      if (template) this.setActiveTemplate(template);
    };

    window.on("focus", focusHandler);
    window.once("closed", () => {
      this.windows.delete(window);
      this.windowTemplates.delete(window);
      window.removeListener("focus", focusHandler);

      if (window === this.lastFocusedWindow) {
        this.lastFocusedWindow =
          [...this.windows].find((candidate) => candidate.isFocused?.()) ||
          this.windows.values().next().value ||
          null;
        const template = this.windowTemplates.get(this.lastFocusedWindow);
        if (template) this.setActiveTemplate(template);
      }

      if (this.windows.size === 0) this.enableWindowSpecificItems(false);
    });

    this.enableWindowSpecificItems(true);
  }

  flattenMenuTemplate(template) {
    const items = [];
    for (const item of template) {
      items.push(item);
      if (item.submenu) items.push(...this.flattenMenuTemplate(item.submenu));
    }
    return items;
  }

  enableWindowSpecificItems(enable) {
    const visit = (menu, template) => {
      for (let index = 0; index < template.length; index++) {
        const menuItem = menu.items[index];
        const templateItem = template[index];
        if (!menuItem) continue;

        if (templateItem.metadata?.windowSpecific) {
          menuItem.enabled = enable && templateItem.enabled !== false;
        }
        if (menuItem.submenu && Array.isArray(templateItem.submenu)) {
          visit(menuItem.submenu, templateItem.submenu);
        }
      }
    };

    if (this.menu && this.activeTemplate) {
      visit(this.menu, this.activeTemplate);
    }
  }

  substituteVersion(template) {
    const item = this.flattenMenuTemplate(template).find(({ label }) => label === "VERSION");
    if (item) item.label = `Version ${this.version}`;
  }

  // This menu is installed before the first renderer has supplied the complete
  // template, and remains usable after the final window closes.
  getDefaultTemplate() {
    return [
      {
        label: "Lumine",
        submenu: [
          {
            label: "New Window",
            click: () => global.lumineApplication?.sendCommand("application:new-window"),
          },
          { type: "separator" },
          { label: "Services", role: "services", submenu: [] },
          { type: "separator" },
          { label: "Hide Lumine", role: "hide" },
          { label: "Hide Others", role: "hideOthers" },
          { label: "Show All", role: "unhide" },
          { type: "separator" },
          { label: "Quit Lumine", role: "quit" },
        ],
      },
    ];
  }

  /**
   * Add native accelerators and main-process command handlers to a renderer
   * template.
   */
  translateTemplate(template, keystrokesByCommand) {
    template.forEach((item) => {
      if (item.metadata == null) item.metadata = {};
      if (item.command) {
        // Structured clone does not preserve the renderer's null prototype, so
        // inherited Object keys must never masquerade as real bindings.
        const keystrokes = Object.hasOwn(keystrokesByCommand, item.command)
          ? keystrokesByCommand[item.command]
          : null;
        if (keystrokes && keystrokes.length > 0) {
          const keystroke = keystrokes[0];
          if (keystroke.includes(" ")) {
            item.label += ` [${_.humanizeKeystroke(keystroke)}]`;
          } else if (
            item.command === "core:paste" ||
            item.command === "editor:paste-without-reformatting"
          ) {
            // Paste must reach Chromium as a keyboard event so ClipboardEvent
            // can expose custom formats.
            item.label += ` [${_.humanizeKeystroke(keystroke)}]`;
          } else {
            item.accelerator = MenuHelpers.acceleratorForKeystroke(keystroke);
          }
        }
        item.click = () => global.lumineApplication.sendCommand(item.command, item.commandDetail);
        if (!/^application:/.test(item.command)) item.metadata.windowSpecific = true;
      }
      if (item.submenu) this.translateTemplate(item.submenu, keystrokesByCommand);
    });
    return template;
  }
};
