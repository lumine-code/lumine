const { ipcRenderer } = require("electron");
const { Disposable } = require("@lumine-code/event-kit");
const ContextViewManager = require("../src/context-view-manager");
const ContextMenuManager = require("../src/context-menu-manager");
const MenuBarView = require("../src/menu-bar-view");
const SelectBoxView = require("../src/select-box-view");
const { showMenuPopup } = require("../src/menu-view");

describe("Context views above window drag regions", () => {
  let contextViews, dragStrip, target, commands;

  beforeEach(() => {
    jasmine.useRealClock();
    commands = null;
    contextViews = new ContextViewManager({ document, window });
    dragStrip = document.createElement("div");
    dragStrip.style.cssText =
      "position:fixed;inset:0 0 auto;height:100px;z-index:90000;app-region:drag";
    target = document.createElement("button");
    target.style.cssText =
      "position:absolute;left:calc(50% - 100px);top:0;width:180px;height:8px;app-region:no-drag";
    dragStrip.appendChild(target);
    jasmine.attachToDOM(dragStrip);
  });

  afterEach(() => {
    commands?.dispose();
    contextViews.destroy();
    dragStrip.remove();
  });

  function manager(template = []) {
    return {
      getTemplate: () => template,
      onDidChange: () => new Disposable(),
      ensureContextViewManager: () => contextViews,
      showPopup: (options) => showMenuPopup(contextViews, options),
    };
  }

  function expectInteractiveSurface(surface, root) {
    // Trusted renderer input bypasses the operating system's caption hit test,
    // so checking the actual base stylesheet's exclusion is essential too.
    expect(getComputedStyle(surface).getPropertyValue("app-region")).toBe("no-drag");
    expect(getComputedStyle(root).getPropertyValue("app-region")).not.toBe("no-drag");
    expect(getComputedStyle(dragStrip).getPropertyValue("app-region")).toBe("drag");
    expect(document.elementFromPoint(16, 20)).toBe(dragStrip);
    expect(surface.getBoundingClientRect().top).toBeLessThan(
      dragStrip.getBoundingClientRect().bottom,
    );
  }

  async function click(element) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const rect = element.getBoundingClientRect();
    const x = Math.floor(rect.left + rect.width / 2);
    const y = Math.floor(rect.top + rect.height / 2);
    expect(y).toBeLessThan(dragStrip.getBoundingClientRect().bottom);
    expect(document.elementFromPoint(x, y)?.closest("[role], button")).toBe(element);
    for (const type of ["mouseMove", "mouseDown", "mouseUp"]) {
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function registerAction() {
    const action = jasmine.createSpy("menu action");
    commands = lumine.commands.add(target, { "context-view-drag-spec:run": action });
    return action;
  }

  it("keeps application menu rows clickable over the title bar", async () => {
    const action = registerAction();
    const menuBar = new MenuBarView(
      manager([
        {
          label: "Actions",
          submenu: [{ label: "Run", command: "context-view-drag-spec:run" }],
        },
      ]),
    );
    menuBar.element.style.cssText =
      "position:absolute;left:calc(50% - 100px);top:0;height:8px;app-region:no-drag";
    dragStrip.appendChild(menuBar.element);
    target.focus();
    try {
      menuBar.openButton(menuBar.buttons[0]);
      const popup = menuBar.popup;
      expect(popup.element.classList.contains("application-menu-popup")).toBe(true);
      expectInteractiveSurface(popup.rootList.element, popup.element);

      await click(popup.rootList.items[0].element);

      expect(action).toHaveBeenCalledTimes(1);
      expect(menuBar.popup).toBeNull();
    } finally {
      menuBar.destroy();
    }
  });

  it("excludes both context menu roots and separately portaled submenus", async () => {
    const action = registerAction();
    const contextMenu = new ContextMenuManager({
      keymapManager: lumine.keymaps,
      menuManager: manager(),
    });
    const popup = contextMenu.show(target, [
      {
        label: "Actions",
        submenu: [{ label: "Run", command: "context-view-drag-spec:run" }],
      },
    ]);
    const submenu = popup.openSubmenu(popup.rootList.items[0]);
    expect(submenu.element.parentElement).toBe(popup.element);
    expect(submenu.element.classList.contains("context-view-surface")).toBe(false);
    expectInteractiveSurface(popup.rootList.element, popup.element);
    expectInteractiveSurface(submenu.element, popup.element);

    await click(submenu.items[0].element);

    expect(action).toHaveBeenCalledTimes(1);
    expect(popup.element.isConnected).toBe(false);
  });

  it("keeps select-box options selectable over the title bar", async () => {
    const select = new SelectBoxView(manager(), {
      popupAnchor: target,
      items: ["First", "Second"],
      value: "First",
    });
    select.element.style.cssText = "position:absolute;left:50%;top:60px";
    dragStrip.appendChild(select.element);
    const changed = jasmine.createSpy("selection changed");
    select.onDidChange(changed);
    try {
      const popup = await select.open();
      expectInteractiveSurface(popup.surface, popup.element);

      await click(select.optionElements[1]);

      expect(select.value).toBe("Second");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(select.popup).toBeNull();
    } finally {
      select.destroy();
    }
  });

  it("protects generic context surfaces without excluding the whole viewport", async () => {
    const clicked = jasmine.createSpy("surface action");
    let button;
    const popup = contextViews.show({
      anchor: target,
      render(surface) {
        button = document.createElement("button");
        button.textContent = "Run";
        button.style.cssText = "width:180px;height:28px";
        button.addEventListener("click", clicked);
        surface.appendChild(button);
      },
    });
    expectInteractiveSurface(popup.surface, popup.element);

    await click(button);

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked.calls.mostRecent().args[0].isTrusted).toBe(true);
    expect(popup.element.isConnected).toBe(true);
  });
});
