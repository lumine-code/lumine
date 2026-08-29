const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const DetachedPaneSurface = require("./detached-pane-surface");
const SurfaceWindowService = require("./surface-window-service");

module.exports = class DetachedPaneSurfaceManager {
  constructor({
    workspace,
    config,
    applicationDelegate,
    primaryWindow,
    primaryDocument,
    styleManager,
    themeManager,
    commandRegistry,
    keymapManager,
    contextMenuManager,
    viewRegistry,
    elementRegistry,
    surfaceManager,
    serviceHub,
    titleBarFactory = null,
  }) {
    this.workspace = workspace;
    this.config = config;
    this.center = workspace.getCenter();
    this.applicationDelegate = applicationDelegate;
    this.primaryWindow = primaryWindow;
    this.primaryDocument = primaryDocument;
    this.styleManager = styleManager;
    this.themeManager = themeManager;
    this.commandRegistry = commandRegistry;
    this.keymapManager = keymapManager;
    this.contextMenuManager = contextMenuManager;
    this.viewRegistry = viewRegistry;
    this.elementRegistry = elementRegistry;
    this.surfaceManager = surfaceManager;
    this.serviceHub = serviceHub;
    this.initialTitleBarFactory = titleBarFactory;
    this.titleBarFactoryRegistrations = [];
    this.titleBarFactory = null;
    this.recordsByPane = new Map();
    this.surfacesByItem = new WeakMap();
    this.pendingPanes = new Set();
    this.destroying = false;
    this.emitter = new Emitter();
    this.transitions = workspace.windowSurfaceTransitions;
    this.subscriptions = new CompositeDisposable();
    this.center.paneContainer.detachedPaneAttacher = (pane, options) =>
      this.attachDetachedPane(pane, options);
    this.setTitleBarFactory(titleBarFactory);
    if (this.serviceHub) {
      this.subscriptions.add(
        this.serviceHub.consume("title-bar.surface", "^1.0.0", (factory) => {
          const registration = { factory, disposed: false };
          const previousFactory = this.titleBarFactory;
          this.titleBarFactoryRegistrations.push(registration);
          try {
            this.applyRegisteredTitleBarFactory();
          } catch (error) {
            registration.disposed = true;
            const index = this.titleBarFactoryRegistrations.indexOf(registration);
            if (index !== -1) this.titleBarFactoryRegistrations.splice(index, 1);
            try {
              if (this.titleBarFactory !== previousFactory) {
                this.setTitleBarFactory(previousFactory);
              }
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Registering the surface title-bar provider failed and rollback also failed",
                { cause: rollbackError },
              );
            }
            throw error;
          }
          return {
            dispose: () => {
              if (registration.disposed) return;
              registration.disposed = true;
              const index = this.titleBarFactoryRegistrations.indexOf(registration);
              if (index === -1) return;
              const wasActive = index === this.titleBarFactoryRegistrations.length - 1;
              this.titleBarFactoryRegistrations.splice(index, 1);
              if (wasActive && !this.destroying) this.applyRegisteredTitleBarFactory();
            },
          };
        }),
      );
    }
  }

  applyRegisteredTitleBarFactory() {
    const registration = this.titleBarFactoryRegistrations.at(-1);
    this.setTitleBarFactory(registration?.factory || this.initialTitleBarFactory || null);
  }

  setTitleBarFactory(factory) {
    if (factory != null && (typeof factory !== "object" || typeof factory.create !== "function")) {
      throw new TypeError("A surface title-bar factory must expose create(options)");
    }
    if (factory === this.titleBarFactory) return;
    this.titleBarFactory = factory;
    for (const surface of this.surfaceManager?.getAll?.() || []) {
      if (surface instanceof DetachedPaneSurface) surface.setTitleBarFactory(factory);
    }
  }

  createSurface(service, title) {
    return new DetachedPaneSurface({
      windowService: service,
      primaryWindow: this.primaryWindow,
      primaryDocument: this.primaryDocument,
      primaryWorkspaceElement: this.workspace.getElement(),
      styleManager: this.styleManager,
      themeManager: this.themeManager,
      commandRegistry: this.commandRegistry,
      keymapManager: this.keymapManager,
      contextMenuManager: this.contextMenuManager,
      viewRegistry: this.viewRegistry,
      elementRegistry: this.elementRegistry,
      surfaceManager: this.surfaceManager,
      workspace: this.workspace,
      config: this.config,
      onAttach: (pane) => this.attachDetachedPane(pane),
      titleBarFactory: this.titleBarFactory,
      title,
    }).initialize();
  }

  async detachPaneItem(item, options = {}) {
    const sourcePane = this.workspace.paneForItem(item);
    if (!sourcePane) throw new Error("Cannot detach an item that is not in the workspace");
    if (sourcePane.isDetached()) {
      await this.recordsByPane.get(sourcePane)?.service.focus();
      return sourcePane;
    }
    if (this.workspace.paneContainerForItem(item) !== this.center) {
      throw new Error("Only workspace-center items can be detached");
    }
    if (item.isDetachable?.() === false) {
      throw new Error("This pane item cannot be detached");
    }

    const service = await SurfaceWindowService.reserve(this.applicationDelegate, {
      transactionId: options.transactionId,
      title: item.getLongTitle?.() || item.getTitle?.(),
      bounds: options.bounds,
      show: options.show,
    });
    let surface;
    let detachedPane;
    let record;
    let transition;
    try {
      service.open(this.primaryWindow);
      await service.whenDocumentReady();
      surface = this.createSurface(service, item.getLongTitle?.() || item.getTitle?.());
      await service.ready();

      transition = await this.transitions.begin({
        item,
        from: this.surfaceManager.getPrimary(),
        to: surface,
        reason: "detach",
      });

      detachedPane = this.center.detachPaneItem(item, {
        surfaceState: options.surfaceState,
      });
      this.pendingPanes.add(detachedPane);
      surface.mountPane(detachedPane);
      record = this.register(detachedPane, surface, service);
      this.pendingPanes.delete(detachedPane);
      await transition.commit();
      await service.commit();
      transition.complete();
      detachedPane.setSurfaceState(await service.getState());
      surface.focusPane();
      this.emitSurfaceChange(item, this.surfaceManager.getPrimary(), surface);
      return record.pane;
    } catch (error) {
      if (record) {
        record.state = "rolling-back";
        this.unregister(record);
      }
      if (detachedPane?.isAlive?.() && detachedPane.getItems().length === 1) {
        try {
          this.center.attachDetachedPane(detachedPane);
        } catch (rollbackError) {
          console.error(rollbackError);
        }
      }
      this.pendingPanes.delete(detachedPane);
      if (transition && transition.state !== "committed" && transition.state !== "rolled-back") {
        try {
          await transition.rollback(error);
        } catch (rollbackError) {
          console.error(rollbackError);
        }
      }
      surface?.destroy();
      try {
        if (service.state === "open") await service.attach();
        else await service.cancel();
      } catch {
        // A failed child may already have closed itself.
      }
      service.destroy();
      throw error;
    }
  }

  async restoreDetachedPanes() {
    const restoredRecords = [];
    for (const pane of this.center.getDetachedPanes()) {
      if (this.recordsByPane.has(pane)) continue;
      try {
        await this.openExistingPane(pane);
        restoredRecords.push(this.recordsByPane.get(pane));
      } catch (error) {
        console.error(error);
      }
    }
    for (const record of restoredRecords.filter(Boolean)) await record.service.show();
    const activePane = this.center.getActivePane();
    if (activePane?.isDetached?.()) await this.recordsByPane.get(activePane)?.service.focus();
  }

  async openExistingPane(pane) {
    const item = pane.getActiveItem();
    const state = pane.getSurfaceState() || {};
    const service = await SurfaceWindowService.reserve(this.applicationDelegate, {
      title: item?.getLongTitle?.() || item?.getTitle?.(),
      bounds: state.bounds,
      show: false,
    });
    let surface;
    let record;
    let transition;
    let stagingElement;
    try {
      service.open(this.primaryWindow);
      await service.whenDocumentReady();
      surface = this.createSurface(service, item?.getLongTitle?.() || item?.getTitle?.());
      await service.ready();

      const paneElement = this.viewRegistry.getView(pane);
      if (!paneElement.isConnected) {
        stagingElement = this.primaryDocument.createElement("div");
        stagingElement.hidden = true;
        stagingElement.inert = true;
        this.primaryDocument.body.appendChild(stagingElement);
        stagingElement.appendChild(paneElement);
      }
      transition = await this.transitions.begin({
        item,
        from: this.surfaceManager.getPrimary(),
        to: surface,
        reason: "restore",
      });
      surface.mountPane(pane);
      stagingElement?.remove();
      stagingElement = null;
      record = this.register(pane, surface, service);
      if (state.maximized) await service.perform("maximize");
      if (state.fullScreen) await service.perform("set-full-screen", true);
      await transition.commit();
      await service.commit();
      transition.complete();
      pane.setSurfaceState(await service.getState());
      this.emitSurfaceChange(item, this.surfaceManager.getPrimary(), surface);
      return pane;
    } catch (error) {
      if (record) this.unregister(record);
      if (pane.isAlive?.() && pane.isDetached?.()) {
        try {
          this.center.attachDetachedPane(pane);
        } catch (rollbackError) {
          console.error(rollbackError);
        }
      }
      stagingElement?.remove();
      if (transition && transition.state !== "committed" && transition.state !== "rolled-back") {
        try {
          await transition.rollback(error);
        } catch (rollbackError) {
          console.error(rollbackError);
        }
      }
      surface?.destroy();
      try {
        if (service.state === "open") await service.attach();
        else await service.cancel();
      } catch {
        // The hidden child may already have closed after its setup failure.
      }
      service.destroy();
      throw error;
    }
  }

  register(pane, surface, service) {
    const record = {
      pane,
      item: pane.getActiveItem(),
      surface,
      service,
      subscriptions: new CompositeDisposable(),
      state: "open",
    };
    this.recordsByPane.set(pane, record);
    this.surfacesByItem.set(record.item, surface);
    record.subscriptions.add(
      service.onDidRequestClose(() => void this.closeRequested(record)),
      service.onDidClose(({ unexpected } = {}) => void this.closed(record, unexpected)),
      service.onDidFocus(() => {
        surface.document.body.classList.remove("is-blurred");
        surface.focusPane();
      }),
      service.onDidBlur(() => surface.document.body.classList.add("is-blurred")),
      service.onDidChangeState((state) => pane.setSurfaceState(state)),
      pane.onDidDestroy(() => void this.paneDestroyed(record)),
    );
    return record;
  }

  async attachDetachedPane(pane, options = {}) {
    const record = this.recordsByPane.get(pane);
    if (!record) return this.center.attachDetachedPane(pane, options);
    if (record.state !== "open") return;
    record.state = "attaching";
    this.pendingPanes.add(pane);
    let transition;
    try {
      const item = record.item;
      transition = await this.transitions.begin({
        item,
        from: record.surface,
        to: this.surfaceManager.getPrimary(),
        reason: "attach",
      });
      const targetPane = this.center.attachDetachedPane(pane, options);
      await this.finishAttach(record, item, targetPane, transition);
      return targetPane;
    } catch (error) {
      if (transition && transition.state !== "committed" && transition.state !== "rolled-back") {
        try {
          await transition.rollback(error);
        } catch (rollbackError) {
          console.error(rollbackError);
        }
      }
      if (this.recordsByPane.get(record.pane) === record) record.state = "open";
      throw error;
    } finally {
      this.pendingPanes.delete(pane);
    }
  }

  async finishAttach(record, item, targetPane, transition) {
    if (!this.recordsByPane.has(record.pane)) return targetPane;
    record.state = "attaching";
    const surfaceState = record.pane.getSurfaceState?.();
    this.unregister(record);
    try {
      await transition.commit();
    } catch (error) {
      const detachedPane = this.center.detachPaneItem(item, { surfaceState });
      record.surface.mountPane(detachedPane);
      this.register(detachedPane, record.surface, record.service);
      try {
        await transition.rollback(error);
      } catch (rollbackError) {
        console.error(rollbackError);
      }
      throw error;
    }
    try {
      await record.service.perform("attach");
    } catch {
      // The model and view are already safely back in the primary surface.
    }
    transition.complete();
    this.emitSurfaceChange(item, record.surface, this.surfaceManager.getPrimary());
    record.surface.destroy();
    record.service.destroy();
    return targetPane;
  }

  async closeRequested(record) {
    if (record.state !== "open") return;
    record.state = "closing-item";
    const closed = await record.pane.destroyItem(record.item);
    if (!closed) {
      record.state = "open";
      await record.service.closeCancelled();
      return;
    }
    this.unregister(record);
    await record.service.closeAccepted();
    record.surface.destroy();
    record.service.destroy();
  }

  async paneDestroyed(record) {
    if (!this.recordsByPane.has(record.pane) || record.state !== "open") return;
    record.state = "item-destroyed";
    this.unregister(record);
    try {
      await record.service.perform("attach");
    } catch {
      // The pane is already gone; only best-effort native cleanup remains.
    }
    record.surface.destroy();
    record.service.destroy();
  }

  async closed(record, unexpected) {
    if (!this.recordsByPane.has(record.pane)) return;
    if (unexpected && !this.destroying && record.pane.isAlive()) {
      record.state = "recovering";
      let transition;
      try {
        transition = await this.transitions.begin({
          item: record.item,
          from: record.surface,
          to: this.surfaceManager.getPrimary(),
          reason: "recovery",
        });
      } catch (error) {
        // The source renderer is already gone, so recovery cannot wait for a
        // participant that failed to quiesce it. Preserve the item in primary
        // and report the failed rebuild rather than losing the only live model.
        console.error(error);
      }
      this.unregister(record);
      const target = this.center.attachDetachedPane(record.pane);
      let committed = false;
      if (transition) {
        try {
          await transition.commit();
          transition.complete();
          committed = true;
        } catch (error) {
          transition.abandon();
          console.error(error);
        }
      }
      if (committed) {
        this.emitSurfaceChange(record.item, record.surface, this.surfaceManager.getPrimary());
      }
      record.surface.destroy();
      record.service.destroy();
      target.activate();
      return;
    }
    this.unregister(record);
    record.surface.destroy();
    record.service.destroy();
  }

  unregister(record) {
    if (this.recordsByPane.get(record.pane) !== record) return false;
    this.recordsByPane.delete(record.pane);
    this.surfacesByItem.delete(record.item);
    record.subscriptions.dispose();
    return true;
  }

  surfaceForItem(item) {
    return this.surfacesByItem.get(item) || this.surfaceManager.getPrimary();
  }

  surfaceForPane(pane) {
    return this.recordsByPane.get(pane)?.surface || this.surfaceManager.getPrimary();
  }

  getSurfaces() {
    return Array.from(this.recordsByPane.values(), (record) => record.surface);
  }

  observePaneItemSurface(item, callback) {
    callback(this.surfaceForItem(item));
    return this.emitter.on("did-change-item-surface", (event) => {
      if (event.item === item) callback(event.newSurface, event.oldSurface);
    });
  }

  addWindowSurfaceTransitionObserver(callback) {
    return this.transitions.addObserver(callback);
  }

  emitSurfaceChange(item, oldSurface, newSurface) {
    this.emitter.emit("did-change-item-surface", { item, oldSurface, newSurface });
  }

  destroy() {
    if (this.destroying) return;
    this.destroying = true;
    this.transitions.abortActive();
    if (this.center.paneContainer.detachedPaneAttacher) {
      this.center.paneContainer.detachedPaneAttacher = null;
    }
    this.subscriptions.dispose();
    this.titleBarFactoryRegistrations = [];
    for (const record of Array.from(this.recordsByPane.values())) {
      this.unregister(record);
      record.surface.destroy();
      record.service.destroy();
    }
    this.emitter.dispose();
  }
};
