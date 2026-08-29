const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const FileState = require("./file-state");
const { WindowSurface } = require("./window-surface");
const PanelContainer = require("./panel-container");
const ModalFlow = require("./modal-flow");
const { applyTextEditorFontConfig } = require("./workspace-element");

const ATTACH_ACTION = Object.freeze({
  id: "attach",
  label: "Attach pane back to the editor",
  iconName: "pin",
  priority: -100,
});

function assertTitleBarFactory(factory) {
  if (factory != null && (typeof factory !== "object" || typeof factory.create !== "function")) {
    throw new TypeError("A surface title-bar factory must expose create(options)");
  }
}

module.exports = class DetachedPaneSurface extends WindowSurface {
  constructor({
    windowService,
    primaryWindow,
    primaryDocument,
    primaryWorkspaceElement,
    styleManager,
    themeManager,
    commandRegistry,
    keymapManager,
    contextMenuManager,
    viewRegistry,
    elementRegistry,
    surfaceManager,
    workspace,
    config,
    onAttach,
    titleBarFactory = null,
    title = "Lumine",
  }) {
    const domWindow = windowService.domWindow;
    super({
      id: windowService.id,
      kind: "detached-pane",
      window: domWindow,
      document: domWindow.document,
      windowService,
    });
    this.primaryWindow = primaryWindow;
    this.primaryDocument = primaryDocument;
    this.primaryWorkspaceElement = primaryWorkspaceElement;
    this.styleManager = styleManager;
    this.themeManager = themeManager;
    this.commandRegistry = commandRegistry;
    this.keymapManager = keymapManager;
    this.contextMenuManager = contextMenuManager;
    this.viewRegistry = viewRegistry;
    this.elementRegistry = elementRegistry;
    this.surfaceManager = surfaceManager;
    this.workspace = workspace;
    this.config = config;
    this.onAttach = onAttach;
    this.initialTitle = title;
    assertTitleBarFactory(titleBarFactory);
    this.initialTitleBarFactory = titleBarFactory;
    this.titleBarFactory = null;
    this.titleBarHandle = null;
    this.pane = null;
    this.item = null;
    this.surfaceSubscriptions = new CompositeDisposable();
    const service = this.windowService;
    this.windowController = Object.freeze({
      getState: () => service.getState(),
      onDidChangeState: (callback) => service.onDidChangeState(callback),
      onDidFocus: (callback) => service.onDidFocus(callback),
      onDidBlur: (callback) => service.onDidBlur(callback),
      focus: () => service.focus(),
      minimize: () => service.minimize(),
      maximize: () => service.maximize(),
      unmaximize: () => service.unmaximize(),
      close: () => service.requestClose(),
      requestClose: () => service.requestClose(),
      setBounds: (bounds) => service.setBounds(bounds),
      getDoubleClickAction: () =>
        this.primaryWindow.lumine?.application?.getUserDefault(
          "AppleActionOnDoubleClick",
          "string",
        ),
    });
  }

  initialize() {
    const { document, window } = this;
    document.documentElement.replaceChildren(document.head, document.body);
    document.head.replaceChildren();
    document.body.replaceChildren();
    if (this.elementRegistry) {
      this.surfaceSubscriptions.add(this.elementRegistry.addWindow(window));
    }

    const base = document.createElement("base");
    base.href = this.primaryDocument.baseURI;
    document.head.appendChild(base);
    for (const source of this.primaryDocument.querySelectorAll(
      'meta[http-equiv="Content-Security-Policy"]',
    )) {
      document.head.appendChild(source.cloneNode(true));
    }

    document.body.className = this.primaryDocument.body.className;
    document.body.classList.add("detached-pane-surface");
    document.body.classList.add("is-blurred");
    this.element = document.createElement("lumine-workspace");
    this.element.className = this.primaryWorkspaceElement.className;
    this.element.classList.add("workspace", "detached-pane-workspace");
    this.element.tabIndex = -1;
    if (this.config) applyTextEditorFontConfig(this.element, this.config);

    // Preserve the normal header-panel theme contract even though this shell
    // does not own a Panel model. UI themes draw the header separator on the
    // panel wrapper rather than on the title-bar package's element.
    this.titlebarHost = document.createElement("lumine-panel");
    this.titlebarHost.className = "detached-pane-titlebar-host header tool-panel panel-header";
    this.titlebar = document.createElement("header");
    this.titlebar.className = "detached-pane-titlebar";
    this.titlebar.setAttribute("role", "toolbar");
    this.titlebar.setAttribute("aria-label", "Detached pane");
    this.attachButton = document.createElement("button");
    this.attachButton.type = "button";
    this.attachButton.className = "detached-pane-attach icon icon-pin";
    this.attachButton.setAttribute("aria-label", "Attach pane back to the editor");
    this.attachButton.title = "Attach pane back to the editor";
    this.attachButton.addEventListener("click", () => {
      void this.activateAttachAction();
    });
    this.titlebar.appendChild(this.attachButton);
    this.titlebarHost.appendChild(this.titlebar);

    this.paneHost = document.createElement("main");
    this.paneHost.className = "detached-pane-host";
    // Keep the normal pane DOM ancestry even though this container is only a
    // surface shell, not a second PaneContainer model. Core pane layout rules
    // are deliberately scoped below lumine-pane-container; mounting the pane
    // directly under <main> leaves it and .item-views as unstyled inline/block
    // content, so real absolutely-positioned item roots paint into a zero-size
    // pane while the detached titlebar remains visible.
    this.paneContainerElement = document.createElement("lumine-pane-container");
    this.paneContainerElement.classList.add("detached-pane-container");
    this.modalHost = document.createElement("div");
    this.modalHost.className = "detached-pane-modal-host";
    this.paneHost.append(this.paneContainerElement, this.modalHost);
    this.element.append(this.titlebarHost, this.paneHost);
    document.body.appendChild(this.element);

    this.modalPanelContainer = new PanelContainer({
      location: "modal",
      viewRegistry: this.viewRegistry,
    });
    const modalElement = this.modalPanelContainer.getElement();
    if (modalElement.ownerDocument !== document) document.adoptNode(modalElement);
    this.modalHost.appendChild(modalElement);
    this.modalFlow = new ModalFlow(this.workspace, {
      panelContainer: this.modalPanelContainer,
      rootElement: this.element,
    });

    // Package code executed by callbacks still resolves the shared Lumine
    // environment. The child owns a Window and Document, not another editor.
    window.lumine = this.primaryWindow.lumine;

    this.surfaceSubscriptions.add(
      this.styleManager.mount(document),
      this.commandRegistry.attach(window),
      this.viewRegistry.registerDocument(document),
      this.commandRegistry.add(window, {
        "window:close": () => this.windowService.requestClose(),
        "window:minimize": () => this.windowService.perform("minimize"),
        "window:maximize": () => this.windowService.perform("maximize"),
        "window:unmaximize": () => this.windowService.perform("unmaximize"),
        "window:toggle-full-screen": async () => {
          const state = await this.windowService.getState();
          return this.windowService.perform("set-full-screen", !state.fullScreen);
        },
        "window:reload": () => this.primaryWindow.lumine?.window?.reload?.(),
        "window:toggle-dev-tools": () => this.primaryWindow.lumine?.window?.toggleDevTools?.(),
      }),
      this.commandRegistry.add(this.element, {
        "pane:attach": {
          description: "Attach this pane back to the editor.",
          didDispatch: () => this.onAttach?.(this.pane),
        },
      }),
    );
    if (this.config) {
      let pixelRatio = window.devicePixelRatio;
      const updateTextEditorFont = () => {
        pixelRatio = window.devicePixelRatio;
        applyTextEditorFontConfig(this.element, this.config);
      };
      const updateTextEditorFontForDisplay = () => {
        if (pixelRatio !== window.devicePixelRatio) updateTextEditorFont();
      };
      this.surfaceSubscriptions.add(
        this.config.onDidChange("editor.fontSize", updateTextEditorFont),
        this.config.onDidChange("editor.fontFamily", updateTextEditorFont),
        this.config.onDidChange("editor.lineHeight", updateTextEditorFont),
        new Disposable(() => window.removeEventListener("resize", updateTextEditorFontForDisplay)),
      );
      window.addEventListener("resize", updateTextEditorFontForDisplay);
    }
    if (this.surfaceManager) this.surfaceManager.add(this);
    if (this.themeManager) {
      this.surfaceSubscriptions.add(
        this.themeManager.onDidChangeActiveThemes(() => this.syncThemeClasses()),
      );
    }
    this.keymapManager.setDefaultTarget(document, this.element);

    const handleKey = (event) => this.keymapManager.handleKeyboardEvent(event);
    document.addEventListener("keydown", handleKey);
    document.addEventListener("keyup", handleKey);
    const handleContextMenu = (event) => {
      event.preventDefault();
      void this.contextMenuManager.showForSurfaceEvent(event, this);
    };
    document.addEventListener("contextmenu", handleContextMenu);
    const rejectWorkspaceDrop = (event) => {
      // A detached pane has capacity one. Package-owned targets may stop the
      // event before it reaches the document; every unclaimed workspace drop
      // is rejected instead of opening a second item or navigating the child.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    document.addEventListener("dragover", rejectWorkspaceDrop);
    document.addEventListener("drop", rejectWorkspaceDrop);
    this.surfaceSubscriptions.add(
      new Disposable(() => {
        document.removeEventListener("keydown", handleKey);
        document.removeEventListener("keyup", handleKey);
        document.removeEventListener("contextmenu", handleContextMenu);
        document.removeEventListener("dragover", rejectWorkspaceDrop);
        document.removeEventListener("drop", rejectWorkspaceDrop);
      }),
    );
    this.setTitleBarFactory(this.initialTitleBarFactory);
    this.initialTitleBarFactory = null;
    return this;
  }

  activateAttachAction() {
    return this.commandRegistry.dispatch(this.element, "pane:attach");
  }

  activateAppIcon() {
    return this.commandRegistry.dispatch(this.element, "application:about");
  }

  setTitleBarFactory(factory) {
    assertTitleBarFactory(factory);
    if (factory === this.titleBarFactory && (factory == null || this.titleBarHandle)) return;

    const oldHandle = this.titleBarHandle;
    const oldElement = oldHandle?.element || this.titlebar;
    if (!factory || !this.titlebarHost) {
      this.titlebarHost?.replaceChildren(this.titlebar);
      this.titleBarFactory = null;
      this.titleBarHandle = null;
      this.destroyTitleBarHandle(oldHandle);
      return;
    }

    let newHandle;
    try {
      const action = Object.assign({}, ATTACH_ACTION, {
        onDidActivate: () => this.activateAttachAction(),
      });
      newHandle = factory.create({
        document: this.document,
        controller: this.windowController,
        title: this.titleForItem(),
        actions: [action],
        onDidActivateAppIcon: () => this.activateAppIcon(),
      });
      if (
        !newHandle ||
        !newHandle.element ||
        newHandle.element.nodeType !== 1 ||
        newHandle.element.ownerDocument !== this.document ||
        typeof newHandle.setTitle !== "function" ||
        typeof newHandle.destroy !== "function"
      ) {
        throw new TypeError(
          "A surface title-bar handle must expose a child-document element, setTitle(), and destroy()",
        );
      }
      if (
        newHandle.element === this.titlebarHost ||
        newHandle.element.contains(this.titlebarHost)
      ) {
        throw new TypeError("A surface title-bar element cannot contain its host");
      }
      newHandle.setTitle(this.titleForItem());
      this.titlebarHost.replaceChildren(newHandle.element);
    } catch (error) {
      if (newHandle && newHandle !== oldHandle) {
        try {
          newHandle.destroy?.();
        } catch (destroyError) {
          console.error(destroyError);
        }
        if (newHandle.element && newHandle.element !== this.titlebarHost) {
          newHandle.element.remove?.();
        }
      }
      if (
        this.titlebarHost.childElementCount !== 1 ||
        this.titlebarHost.firstElementChild !== oldElement
      ) {
        try {
          this.titlebarHost.replaceChildren(oldElement);
        } catch (restoreError) {
          console.error("Unable to restore the previous surface title bar", restoreError);
        }
      }
      console.error("Unable to mount the surface title bar", error);
      return;
    }

    this.titleBarFactory = factory;
    this.titleBarHandle = newHandle;
    if (oldHandle !== newHandle) this.destroyTitleBarHandle(oldHandle);
  }

  destroyTitleBarHandle(handle = this.titleBarHandle) {
    if (!handle) return;
    if (handle === this.titleBarHandle) this.titleBarHandle = null;
    try {
      handle.destroy();
    } catch (error) {
      console.error(error);
    }
    handle.element?.remove?.();
  }

  syncThemeClasses() {
    for (const className of Array.from(this.element.classList)) {
      if (className.startsWith("theme-")) this.element.classList.remove(className);
    }
    for (const className of this.primaryWorkspaceElement.classList) {
      if (className.startsWith("theme-")) this.element.classList.add(className);
    }
  }

  mountPane(pane) {
    if (!pane?.isDetached?.()) throw new TypeError("A detached surface requires a DetachedPane");
    if (pane.getItems().length !== 1) {
      throw new Error("A detached surface requires a pane containing exactly one item");
    }
    const previousItem = this.item;
    this.pane = pane;
    this.item = pane.getActiveItem();
    const paneElement = this.viewRegistry.getView(pane);
    if (paneElement.ownerDocument !== this.document) this.document.adoptNode(paneElement);
    this.paneContainerElement.replaceChildren(paneElement);
    paneElement.classList.add("detached-pane");
    this.updateTitle();
    this.updateDocumentEdited();

    if (previousItem !== this.item) {
      for (const [method, callback] of [
        ["onDidChangeTitle", () => this.updateTitle()],
        ["onDidChangePath", () => this.updateTitle()],
        ["onDidChangeFileState", () => this.updateDocumentEdited()],
      ]) {
        if (typeof this.item[method] === "function") {
          this.surfaceSubscriptions.add(this.item[method](callback));
        }
      }
    }
    this.document.title = this.titleForItem();
    return pane;
  }

  titleForItem() {
    return this.item?.getLongTitle?.() || this.item?.getTitle?.() || this.initialTitle;
  }

  updateTitle() {
    const title = this.titleForItem();
    this.document.title = title;
    if (this.titleBarHandle) {
      try {
        this.titleBarHandle.setTitle(title);
      } catch (error) {
        console.error("Unable to update the surface title bar", error);
        this.setTitleBarFactory(null);
      }
    }
    void this.windowService.setTitle(title);
    void this.windowService.setRepresentedFilename(this.item?.getPath?.() || "");
  }

  updateDocumentEdited() {
    const item = this.item;
    const edited =
      Boolean(item) &&
      typeof item.getFileState === "function" &&
      (typeof item.save === "function" || typeof item.saveAs === "function") &&
      item.getFileState() !== FileState.UNMODIFIED;
    void this.windowService.setDocumentEdited(edited);
  }

  focusPane() {
    this.pane?.activate();
    this.pane?.getElement?.().focus();
  }

  destroy() {
    if (this.isDestroyed()) return;
    this.setTitleBarFactory(null);
    if (this.surfaceManager?.get(this.id) === this) this.surfaceManager.remove(this);
    this.surfaceSubscriptions.dispose();
    this.modalFlow?.destroy();
    this.modalPanelContainer?.destroy();
    this.element?.remove();
    this.pane = null;
    this.item = null;
    super.destroy();
  }
};
