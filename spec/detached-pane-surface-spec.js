const { Disposable } = require("@lumine-code/event-kit");
const { conditionPromise } = require("./helpers/async-spec-helpers");
const fs = require("fs");
const path = require("path");

function contentSecurityPolicy(fileName) {
  const html = fs.readFileSync(path.join(__dirname, "..", "static", fileName), "utf8");
  return new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
}

describe("the detached pane document", () => {
  it("uses the workspace content security policy", () => {
    // The shell policy is applied while detached-pane.html is parsed. Removing
    // its meta element later cannot relax it, and an additional policy only
    // intersects with it, so a detached pane must start with every capability
    // that a normal workspace item may use.
    expect(contentSecurityPolicy("detached-pane.html")).toBe(contentSecurityPolicy("index.html"));
  });
});

describe("DetachedPaneSurface", () => {
  let item, titleBarProvider, titleBarWasActive;

  beforeEach(async () => {
    titleBarWasActive = lumine.packages.isPackageActive("title-bar");
    if (titleBarWasActive) await lumine.packages.deactivatePackage("title-bar");
    titleBarProvider = null;
    lumine.initializeDetachedPaneSurfaces({ force: true });
    jasmine.attachToDOM(lumine.workspace.getElement());
    item = {
      element: document.createElement("div"),
      transitions: [],
      getTitle: () => "Surface item",
      beginWindowSurfaceTransition(context) {
        this.transitions.push([
          "begin",
          context.reason,
          this.element.ownerDocument,
          this.element.isConnected,
        ]);
        return {
          commit: () =>
            this.transitions.push([
              "commit",
              context.reason,
              this.element.ownerDocument,
              this.element.isConnected,
            ]),
          rollback: ({ error }) =>
            this.transitions.push([
              "rollback",
              context.reason,
              this.element.ownerDocument,
              this.element.isConnected,
              error.message,
            ]),
        };
      },
    };
    const pane = lumine.workspace.getCenter().getActiveTiledPane();
    pane.addItem(item);
    pane.activateItem(item);
  });

  afterEach(async () => {
    titleBarProvider?.dispose();
    titleBarProvider = null;
    const pane = lumine.workspace.paneForItem(item);
    if (pane?.isDetached?.()) {
      item.beginWindowSurfaceTransition = null;
      await lumine.workspace.attachDetachedPane(pane);
    }
    pane?.removeItem?.(item, true);
    lumine.initializeDetachedPaneSurfaces();
    const titleBarIsActive = lumine.packages.isPackageActive("title-bar");
    if (titleBarWasActive && !titleBarIsActive) {
      await lumine.packages.activatePackage("title-bar");
    } else if (!titleBarWasActive && titleBarIsActive) {
      await lumine.packages.deactivatePackage("title-bar");
    }
  });

  it("awaits realm rebuild after adoption and before completing detach and attach", async () => {
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    expect(surface.document).not.toBe(document);
    expect(item.transitions.slice(0, 2)).toEqual([
      ["begin", "detach", document, true],
      ["commit", "detach", surface.document, true],
    ]);

    await lumine.workspace.attachDetachedPane(detachedPane);
    expect(item.transitions.slice(2)).toEqual([
      ["begin", "attach", surface.document, true],
      ["commit", "attach", document, true],
    ]);
  });

  it("keeps the fallback attach action when no title-bar provider exists", async () => {
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);

    expect(surface.titlebarHost.localName).toBe("lumine-panel");
    expect(surface.titlebarHost.classList).toContain("header");
    expect(surface.titlebarHost.classList).toContain("tool-panel");
    expect(surface.titlebarHost.classList).toContain("panel-header");
    expect(surface.titlebarHost.children.length).toBe(1);
    expect(surface.titlebarHost.firstElementChild).toBe(surface.titlebar);
    expect(surface.titlebar.contains(surface.attachButton)).toBe(true);
    expect(surface.attachButton.ownerDocument).toBe(surface.document);
    expect(surface.document.defaultView.getComputedStyle(surface.element).display).toBe("flex");
    expect(detachedPane.getActiveItem()).toBe(item);
  });

  it("allows mounted styles to import package stylesheets through the lumine protocol", async () => {
    await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const violations = [];
    const recordViolation = (event) => violations.push(event);
    surface.document.addEventListener("securitypolicyviolation", recordViolation);
    const stylesheet = lumine.styles.addStyleSheet(
      '@import url("lumine://title-bar/styles/main.css");',
      {
        sourcePath: "detached-pane-csp-spec.css",
      },
    );
    const mounted = surface.document.head.querySelector(
      'style[source-path="detached-pane-csp-spec.css"]',
    );
    const importedValue = () =>
      surface.window
        .getComputedStyle(surface.document.documentElement)
        .getPropertyValue("--title-bar-transition-slow")
        .trim();

    try {
      expect(mounted).not.toBeNull();
      expect(mounted.ownerDocument).toBe(surface.document);
      await conditionPromise(
        () => importedValue() === "0.15s",
        "the detached stylesheet import to load",
        4000,
      );
      await Promise.resolve();
      expect(
        violations.filter(
          ({ violatedDirective, blockedURI }) =>
            violatedDirective === "style-src-elem" && blockedURI.startsWith("lumine://"),
        ),
      ).toEqual([]);
    } finally {
      stylesheet.dispose();
      surface.document.removeEventListener("securitypolicyviolation", recordViolation);
    }
  });

  it("attaches only the surface whose attach action was activated", async () => {
    const secondItem = {
      element: document.createElement("div"),
      getTitle: () => "Second surface item",
    };
    const tiledPane = lumine.workspace.getCenter().getActiveTiledPane();
    tiledPane.addItem(secondItem);
    let secondPane;
    try {
      const firstPane = await lumine.workspace.detachPaneItem(item, { show: false });
      secondPane = await lumine.workspace.detachPaneItem(secondItem, { show: false });
      const firstSurface = lumine.workspace.getWindowSurface(item);
      const secondSurface = lumine.workspace.getWindowSurface(secondItem);
      expect(firstSurface).not.toBe(secondSurface);
      expect(firstPane.isDetached()).toBe(true);
      expect(secondPane.isDetached()).toBe(true);

      await firstSurface.activateAttachAction();

      expect(lumine.workspace.paneForItem(item).isDetached()).toBe(false);
      expect(lumine.workspace.paneForItem(secondItem)).toBe(secondPane);
      expect(secondPane.isDetached()).toBe(true);
      expect(lumine.workspace.getWindowSurface(secondItem)).toBe(secondSurface);
    } finally {
      const pane = lumine.workspace.paneForItem(secondItem);
      if (pane?.isDetached?.()) await lumine.workspace.attachDetachedPane(pane);
      lumine.workspace.paneForItem(secondItem)?.removeItem(secondItem, true);
    }
  });

  it("uses the bundled title bar without an application menu and attaches through its tile", async () => {
    await lumine.packages.activatePackage("title-bar");
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const titleBar = surface.titlebarHost.querySelector(":scope > .title-bar.surface-title-bar");

    expect(titleBar).not.toBeNull();
    expect(titleBar.ownerDocument).toBe(surface.document);
    expect(titleBar.querySelector(".custom-title").textContent).toBe("Surface item");
    expect(titleBar.querySelector(".app-menu")).toBeNull();
    expect(surface.document.querySelector(".app-menu-submenu-portal")).toBeNull();
    expect(titleBar.querySelectorAll(".window-buttons button").length).toBe(3);

    const attach = titleBar.querySelector('[data-action="attach"]');
    expect(attach).not.toBeNull();
    expect(attach.classList).toContain("title-bar-item");
    expect(attach.getAttribute("role")).toBe("button");
    expect(attach.getAttribute("aria-label")).toBe("Attach pane back to the editor");
    attach.click();

    await conditionPromise(
      () => !lumine.workspace.paneForItem(item)?.isDetached?.() && surface.isDestroyed(),
    );
    expect(detachedPane.isDestroyed()).toBe(true);
    expect(surface.isDestroyed()).toBe(true);
  });

  it("renders custom context menus and dispatches their commands in the child realm", async () => {
    await lumine.packages.activatePackage("title-bar");
    await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const titleBar = surface.titlebarHost.querySelector(":scope > .title-bar.surface-title-bar");
    const command = "detached-pane-surface-spec:context-action";
    const didDispatch = jasmine.createSpy("didDispatch");
    const commandDisposable = lumine.commands.add(surface.element, { [command]: didDispatch });
    const menuDisposable = lumine.contextMenu.add({
      ".surface-title-bar": [{ label: "Surface Context Action", command }],
    });
    const nativeContextMenu = spyOn(surface.windowService, "showContextMenu").and.resolveTo();

    try {
      const event = new surface.window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      });
      titleBar.dispatchEvent(event);

      const menu = surface.document.querySelector(".context-menu-container");
      expect(event.defaultPrevented).toBe(true);
      expect(menu).not.toBeNull();
      expect(menu.ownerDocument).toBe(surface.document);
      expect(nativeContextMenu).not.toHaveBeenCalled();
      menu.querySelector(".menu-item").click();
      advanceClock(20);
      await Promise.resolve();
      expect(didDispatch).toHaveBeenCalledTimes(1);
      expect(didDispatch.calls.mostRecent().args[0].target).toBe(titleBar);
    } finally {
      menuDisposable.dispose();
      commandDisposable.dispose();
    }
  });

  it("mounts provider chrome in the child realm and routes its controls to that window", async () => {
    let options;
    const handle = {
      element: null,
      setTitle: jasmine.createSpy("setTitle"),
      destroy: jasmine.createSpy("destroy"),
    };
    const factory = {
      create: jasmine.createSpy("create").and.callFake((createOptions) => {
        options = createOptions;
        handle.element = createOptions.document.createElement("div");
        handle.element.className = "provided-title-bar";
        return handle;
      }),
    };
    titleBarProvider = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factory);

    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(options.document).toBe(surface.document);
    expect(options.title).toBe("Surface item");
    expect(options.actions.length).toBe(1);
    expect(options.actions[0]).toEqual(
      jasmine.objectContaining({
        id: "attach",
        label: "Attach pane back to the editor",
        iconName: "pin",
        priority: -100,
      }),
    );
    expect(typeof options.actions[0].onDidActivate).toBe("function");
    expect(typeof options.onDidActivateAppIcon).toBe("function");
    expect(handle.element.ownerDocument).toBe(surface.document);
    expect(surface.titlebarHost.children.length).toBe(1);
    expect(surface.titlebarHost.firstElementChild).toBe(handle.element);

    for (const method of [
      "getState",
      "onDidChangeState",
      "onDidFocus",
      "onDidBlur",
      "focus",
      "minimize",
      "maximize",
      "unmaximize",
      "close",
      "requestClose",
      "setBounds",
      "getDoubleClickAction",
    ]) {
      expect(typeof options.controller[method]).toBe("function");
    }
    const minimize = spyOn(surface.windowService, "minimize").and.resolveTo();
    const maximize = spyOn(surface.windowService, "maximize").and.resolveTo();
    const unmaximize = spyOn(surface.windowService, "unmaximize").and.resolveTo();
    const focus = spyOn(surface.windowService, "focus").and.resolveTo();
    const close = spyOn(surface.windowService, "requestClose").and.resolveTo();
    const setBounds = spyOn(surface.windowService, "setBounds").and.resolveTo();
    const getState = spyOn(surface.windowService, "getState").and.resolveTo({ maximized: false });
    const onDidChangeState = spyOn(surface.windowService, "onDidChangeState").and.returnValue(
      new Disposable(),
    );
    const onDidFocus = spyOn(surface.windowService, "onDidFocus").and.returnValue(new Disposable());
    const onDidBlur = spyOn(surface.windowService, "onDidBlur").and.returnValue(new Disposable());
    const getUserDefault = spyOn(lumine.application, "getUserDefault").and.resolveTo("Minimize");
    await options.controller.minimize();
    await options.controller.maximize();
    await options.controller.unmaximize();
    await options.controller.focus();
    await options.controller.close();
    await options.controller.setBounds({ x: 1, y: 2, width: 700, height: 500 });
    expect(await options.controller.getState()).toEqual({ maximized: false });
    const stateCallback = jasmine.createSpy("state callback");
    const focusCallback = jasmine.createSpy("focus callback");
    const blurCallback = jasmine.createSpy("blur callback");
    options.controller.onDidChangeState(stateCallback);
    options.controller.onDidFocus(focusCallback);
    options.controller.onDidBlur(blurCallback);
    expect(await options.controller.getDoubleClickAction()).toBe("Minimize");
    expect(minimize).toHaveBeenCalled();
    expect(maximize).toHaveBeenCalled();
    expect(unmaximize).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 700, height: 500 });
    expect(getState).toHaveBeenCalled();
    expect(onDidChangeState).toHaveBeenCalledWith(stateCallback);
    expect(onDidFocus).toHaveBeenCalledWith(focusCallback);
    expect(onDidBlur).toHaveBeenCalledWith(blurCallback);
    expect(getUserDefault).toHaveBeenCalledWith("AppleActionOnDoubleClick", "string");

    await options.actions[0].onDidActivate();
    expect(lumine.workspace.paneForItem(item).isDetached()).toBe(false);
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    expect(detachedPane.isDestroyed()).toBe(true);
  });

  it("opens developer tools for its child but reloads the shared editor owner", async () => {
    await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const toggleDevTools = spyOn(surface.windowService, "toggleDevTools").and.resolveTo();
    const ownerToggleDevTools = spyOn(lumine.window, "toggleDevTools").and.resolveTo();
    const ownerReload = spyOn(lumine.window, "reload").and.resolveTo();

    await lumine.commands.dispatch(surface.element, "window:toggle-dev-tools");
    expect(toggleDevTools).toHaveBeenCalledTimes(1);
    expect(ownerToggleDevTools).not.toHaveBeenCalled();

    await lumine.commands.dispatch(surface.element, "window:reload");
    expect(ownerReload).toHaveBeenCalledTimes(1);
  });

  it("upgrades an existing surface, updates its title, and restores fallback on deactivation", async () => {
    let title = "Surface item";
    let didChangeTitle;
    item.getTitle = () => title;
    item.onDidChangeTitle = (callback) => {
      didChangeTitle = callback;
      return new Disposable(() => (didChangeTitle = null));
    };
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    expect(surface.titlebarHost.firstElementChild).toBe(surface.titlebar);

    let options;
    const handle = {
      element: surface.document.createElement("div"),
      setTitle: jasmine.createSpy("setTitle"),
      destroy: jasmine.createSpy("destroy"),
    };
    titleBarProvider = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", {
      create(createOptions) {
        options = createOptions;
        return handle;
      },
    });
    expect(options.title).toBe("Surface item");
    expect(surface.titlebarHost.firstElementChild).toBe(handle.element);

    title = "Renamed surface item";
    didChangeTitle();
    expect(handle.setTitle).toHaveBeenCalledWith("Renamed surface item");

    titleBarProvider.dispose();
    titleBarProvider = null;
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    expect(handle.element.isConnected).toBe(false);
    expect(surface.titlebarHost.firstElementChild).toBe(surface.titlebar);
    expect(detachedPane.getActiveItem()).toBe(item);
  });

  it("keeps the current provider chrome when a replacement throws", async () => {
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const currentHandle = {
      element: surface.document.createElement("div"),
      setTitle() {},
      destroy: jasmine.createSpy("destroy current"),
    };
    const currentFactory = { create: () => currentHandle };
    surface.setTitleBarFactory(currentFactory);
    const error = new Error("replacement failed");
    spyOn(console, "error");

    surface.setTitleBarFactory({
      create() {
        throw error;
      },
    });

    expect(surface.titleBarFactory).toBe(currentFactory);
    expect(surface.titleBarHandle).toBe(currentHandle);
    expect(surface.titlebarHost.firstElementChild).toBe(currentHandle.element);
    expect(currentHandle.destroy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("Unable to mount the surface title bar", error);
    expect(detachedPane.getActiveItem()).toBe(item);
  });

  it("restores the current provider chrome when mounting its replacement throws", async () => {
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const currentHandle = {
      element: surface.document.createElement("div"),
      setTitle() {},
      destroy: jasmine.createSpy("destroy current"),
    };
    const currentFactory = { create: () => currentHandle };
    surface.setTitleBarFactory(currentFactory);

    const replacementHandle = {
      element: surface.document.createElement("div"),
      setTitle() {},
      destroy: jasmine.createSpy("destroy replacement"),
    };
    const replaceChildren = surface.titlebarHost.replaceChildren.bind(surface.titlebarHost);
    const mountError = new Error("mount failed");
    spyOn(surface.titlebarHost, "replaceChildren").and.callFake((element) => {
      if (element === replacementHandle.element) {
        replaceChildren(element);
        throw mountError;
      }
      return replaceChildren(element);
    });
    spyOn(console, "error");

    surface.setTitleBarFactory({ create: () => replacementHandle });

    expect(replacementHandle.destroy).toHaveBeenCalledTimes(1);
    expect(replacementHandle.element.isConnected).toBe(false);
    expect(surface.titleBarFactory).toBe(currentFactory);
    expect(surface.titleBarHandle).toBe(currentHandle);
    expect(surface.titlebarHost.firstElementChild).toBe(currentHandle.element);
    expect(currentHandle.destroy).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("Unable to mount the surface title bar", mountError);
    expect(detachedPane.getActiveItem()).toBe(item);
  });

  it("registers a fresh title-bar consumer whenever the surface manager is recreated", () => {
    const firstManager = lumine.detachedPaneSurfaceManager;
    lumine.initializeDetachedPaneSurfaces({ force: true });
    expect(firstManager.destroying).toBe(true);

    const resetManager = lumine.detachedPaneSurfaceManager;
    const factory = { create: jasmine.createSpy("create") };
    titleBarProvider = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factory);

    expect(resetManager).not.toBe(firstManager);
    expect(resetManager.titleBarFactory).toBe(factory);
  });

  it("restores the previous provider when the active registration is disposed", async () => {
    await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const handlesA = [];
    const handlesB = [];
    const factoryFor = (name, handles) => ({
      create({ document }) {
        const handle = {
          element: document.createElement("div"),
          setTitle() {},
          destroy: jasmine.createSpy(`destroy ${name}`),
        };
        handles.push(handle);
        return handle;
      },
    });
    const factoryA = factoryFor("A", handlesA);
    const factoryB = factoryFor("B", handlesB);
    const providerA = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factoryA);
    const providerB = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factoryB);

    expect(surface.titleBarFactory).toBe(factoryB);
    expect(surface.titleBarHandle).toBe(handlesB[0]);
    expect(handlesA[0].destroy).toHaveBeenCalledTimes(1);

    providerB.dispose();
    expect(surface.titleBarFactory).toBe(factoryA);
    expect(surface.titleBarHandle).toBe(handlesA[1]);
    expect(handlesB[0].destroy).toHaveBeenCalledTimes(1);

    providerA.dispose();
    expect(handlesA[1].destroy).toHaveBeenCalledTimes(1);
    expect(surface.titleBarFactory).toBeNull();
    expect(surface.titlebarHost.firstElementChild).toBe(surface.titlebar);
  });

  it("leaves the active provider untouched when a nonactive registration is disposed", async () => {
    await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const handleA = {
      element: surface.document.createElement("div"),
      setTitle() {},
      destroy: jasmine.createSpy("destroy A"),
    };
    const handleB = {
      element: surface.document.createElement("div"),
      setTitle() {},
      destroy: jasmine.createSpy("destroy B"),
    };
    const factoryA = { create: () => handleA };
    const factoryB = { create: () => handleB };
    const providerA = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factoryA);
    const providerB = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factoryB);

    providerA.dispose();
    expect(surface.titleBarFactory).toBe(factoryB);
    expect(surface.titleBarHandle).toBe(handleB);
    expect(handleB.destroy).not.toHaveBeenCalled();

    providerB.dispose();
    expect(handleB.destroy).toHaveBeenCalledTimes(1);
    expect(surface.titlebarHost.firstElementChild).toBe(surface.titlebar);
  });

  it("tracks duplicate registrations of the same factory independently", async () => {
    await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    const handle = {
      element: surface.document.createElement("div"),
      setTitle() {},
      destroy: jasmine.createSpy("destroy shared"),
    };
    const factory = { create: jasmine.createSpy("create shared").and.returnValue(handle) };
    const first = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factory);
    const second = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factory);

    expect(factory.create).toHaveBeenCalledTimes(1);
    second.dispose();
    expect(surface.titleBarFactory).toBe(factory);
    expect(surface.titleBarHandle).toBe(handle);
    expect(handle.destroy).not.toHaveBeenCalled();

    first.dispose();
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    expect(surface.titleBarFactory).toBeNull();
  });

  it("rolls back its token when a provider cannot be applied", () => {
    const manager = lumine.detachedPaneSurfaceManager;
    const factoryA = { create: jasmine.createSpy("create A") };
    const providerA = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factoryA);
    const registrationsBefore = manager.titleBarFactoryRegistrations.slice();

    expect(() => lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", {})).toThrowError(
      /must expose create/,
    );
    expect(manager.titleBarFactoryRegistrations).toEqual(registrationsBefore);
    expect(manager.titleBarFactory).toBe(factoryA);

    const factoryB = { create: jasmine.createSpy("create B") };
    const providerB = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", factoryB);
    expect(manager.titleBarFactory).toBe(factoryB);

    providerB.dispose();
    expect(manager.titleBarFactory).toBe(factoryA);
    providerA.dispose();
    expect(manager.titleBarFactory).toBeNull();
    expect(manager.titleBarFactoryRegistrations).toEqual([]);
  });

  it("does not remount title bars while manager disposal cascades through providers", () => {
    const manager = lumine.detachedPaneSurfaceManager;
    const setTitleBarFactory = spyOn(manager, "setTitleBarFactory").and.callThrough();
    const providerA = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", {
      create() {},
    });
    const providerB = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", {
      create() {},
    });
    const callsBeforeDestroy = setTitleBarFactory.calls.count();

    manager.destroy();

    expect(setTitleBarFactory.calls.count()).toBe(callsBeforeDestroy);
    providerA.dispose();
    providerB.dispose();
    lumine.initializeDetachedPaneSurfaces({ force: true });
  });

  it("lays out the pane and active item in the visible child window", async () => {
    item.element.classList.add("pane-item");
    item.element.textContent = "Detached surface content";

    const detachedPane = await lumine.workspace.detachPaneItem(item);
    const surface = lumine.workspace.getWindowSurface(item);
    const paneElement = detachedPane.getElement();
    const itemView = lumine.views.getView(item);
    await new Promise((resolve) => surface.window.requestAnimationFrame(resolve));

    expect((await surface.windowService.getState()).visible).toBe(true);
    expect(surface.document.visibilityState).toBe("visible");
    expect(surface.paneHost.contains(paneElement)).toBe(true);
    const paneContainer = surface.paneHost.querySelector(":scope > lumine-pane-container");
    const itemViews = paneElement.querySelector(":scope > .item-views");
    expect(paneContainer).not.toBeNull();
    expect(itemViews).not.toBeNull();
    if (!paneContainer || !itemViews) return;
    expect(paneContainer.contains(paneElement)).toBe(true);
    expect(itemViews.contains(itemView)).toBe(true);

    const hostBounds = surface.paneHost.getBoundingClientRect();
    const containerStyle = surface.window.getComputedStyle(paneContainer);
    const paneStyle = surface.window.getComputedStyle(paneElement);
    const itemViewsStyle = surface.window.getComputedStyle(itemViews);
    const itemStyle = surface.window.getComputedStyle(itemView);
    const paneBounds = paneElement.getBoundingClientRect();
    const itemBounds = itemView.getBoundingClientRect();
    expect(containerStyle.display).toBe("flex");
    expect(paneStyle.display).toBe("flex");
    expect(itemViewsStyle.display).toBe("flex");
    expect(itemStyle.display).not.toBe("none");
    expect(itemStyle.visibility).not.toBe("hidden");
    // A theme may legally add a border or padding, so do not require pixel
    // equality. Requiring almost the whole host still distinguishes the real
    // pane layout from the item's small natural text box that masked the bug.
    expect(paneBounds.width).toBeGreaterThan(hostBounds.width * 0.9);
    expect(paneBounds.height).toBeGreaterThan(hostBounds.height * 0.9);
    expect(itemBounds.width).toBeGreaterThan(paneBounds.width * 0.9);
    expect(itemBounds.height).toBeGreaterThan(paneBounds.height * 0.9);

    const hit = surface.document.elementFromPoint(
      itemBounds.left + itemBounds.width / 2,
      itemBounds.top + itemBounds.height / 2,
    );
    expect(hit === itemView || itemView.contains(hit)).toBe(true);
  });

  it("physically restores the old DOM before invoking rollback", async () => {
    const handle = {
      element: null,
      setTitle() {},
      destroy: jasmine.createSpy("destroy title bar"),
    };
    titleBarProvider = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", {
      create({ document }) {
        handle.element = document.createElement("div");
        return handle;
      },
    });
    item.beginWindowSurfaceTransition = function (context) {
      this.transitions.push(["begin", context.reason, this.element.ownerDocument]);
      return {
        commit: () => {
          throw new Error("realm rebuild failed");
        },
        rollback: ({ error }) =>
          this.transitions.push([
            "rollback",
            this.element.ownerDocument,
            this.element.isConnected,
            error.message,
          ]),
      };
    };

    await expectAsync(lumine.workspace.detachPaneItem(item, { show: false })).toBeRejectedWithError(
      /realm rebuild failed/,
    );
    expect(lumine.workspace.paneForItem(item).isDetached()).toBe(false);
    expect(item.transitions.at(-1)).toEqual(["rollback", document, true, "realm rebuild failed"]);
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    expect(handle.element.isConnected).toBe(false);
  });

  it("re-detaches physically before rolling back a failed attach rebuild", async () => {
    let titleBarOptions;
    const handle = {
      element: null,
      setTitle() {},
      destroy: jasmine.createSpy("destroy title bar"),
    };
    titleBarProvider = lumine.packages.serviceHub.provide("title-bar.surface", "1.0.0", {
      create(options) {
        titleBarOptions = options;
        handle.element = options.document.createElement("div");
        return handle;
      },
    });
    const detachedPane = await lumine.workspace.detachPaneItem(item, { show: false });
    const surface = lumine.workspace.getWindowSurface(item);
    item.transitions = [];
    item.beginWindowSurfaceTransition = function (context) {
      return {
        commit: () => {
          if (context.reason === "attach") throw new Error("primary rebuild failed");
        },
        rollback: ({ error }) =>
          this.transitions.push([
            "rollback",
            this.element.ownerDocument,
            this.element.isConnected,
            error.message,
          ]),
      };
    };

    await expectAsync(lumine.workspace.attachDetachedPane(detachedPane)).toBeRejectedWithError(
      /primary rebuild failed/,
    );
    const restoredPane = lumine.workspace.paneForItem(item);
    expect(restoredPane.isDetached()).toBe(true);
    expect(lumine.workspace.getWindowSurface(item)).toBe(surface);
    expect(item.transitions).toEqual([
      ["rollback", surface.document, true, "primary rebuild failed"],
    ]);
    expect(surface.titleBarHandle).toBe(handle);
    expect(surface.titlebarHost.firstElementChild).toBe(handle.element);
    expect(handle.destroy).not.toHaveBeenCalled();
    expect(titleBarOptions.actions[0].id).toBe("attach");

    item.beginWindowSurfaceTransition = null;
    await titleBarOptions.actions[0].onDidActivate();
    expect(lumine.workspace.paneForItem(item).isDetached()).toBe(false);
    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  it("recreates TextEditor observers in the element's current Window realm", async () => {
    lumine.workspace.paneForItem(item).removeItem(item, true);
    const editor = await lumine.workspace.open(null);
    const element = editor.getElement();
    const detachedPane = await lumine.workspace.detachPaneItem(editor, { show: false });
    const surface = lumine.workspace.getWindowSurface(editor);
    expect(element.ownerDocument).toBe(surface.document);
    expect(
      element.component.intersectionObserver instanceof surface.window.IntersectionObserver,
    ).toBe(true);
    expect(element.component.resizeObserver instanceof surface.window.ResizeObserver).toBe(true);
    await lumine.workspace.attachDetachedPane(detachedPane);
    expect(element.ownerDocument).toBe(document);
    expect(element.component.intersectionObserver instanceof window.IntersectionObserver).toBe(
      true,
    );
    expect(element.component.resizeObserver instanceof window.ResizeObserver).toBe(true);
    lumine.workspace.paneForItem(editor).destroyItem(editor, true);
  });
});
