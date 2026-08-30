"use strict";

const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");
const { createPanelContainerElement } = require("./panel-container-element");

module.exports = class PanelContainer {
  constructor({ location, dock, viewRegistry } = {}) {
    this.location = location;
    this.destroying = false;
    this.destroyed = false;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.panelSubscriptions = new Map();
    this.panels = [];
    this.dock = dock;
    this.viewRegistry = viewRegistry;
  }

  destroy() {
    if (this.destroyed || this.destroying) return;
    this.destroying = true;
    for (const panel of this.getPanels()) panel.destroy();
    this.subscriptions.dispose();
    this.destroyed = true;
    this.destroying = false;
    this.emitter.emit("did-destroy", this);
    this.emitter.dispose();
  }

  isDestroyed() {
    return this.destroyed || this.destroying;
  }

  getElement() {
    if (!this.element) {
      this.element = createPanelContainerElement().initialize(this, this.viewRegistry);
    }
    return this.element;
  }

  /**
   * @category Event Subscription
   */

  onDidAddPanel(callback) {
    return this.emitter.on("did-add-panel", callback);
  }

  onDidRemovePanel(callback) {
    return this.emitter.on("did-remove-panel", callback);
  }

  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @category Panels
   */

  getLocation() {
    return this.location;
  }

  isModal() {
    return this.location === "modal";
  }

  getPanels() {
    return this.panels.slice();
  }

  containsPanel(panel) {
    return this.panels.includes(panel);
  }

  addPanel(panel) {
    if (this.isDestroyed()) throw new Error("Cannot add a panel to a destroyed container");
    if (panel.isDestroyed()) throw new Error("Cannot add a destroyed panel to a container");
    if (panel.getContainer() === this) return panel;
    const previousContainer = panel.getContainer();
    if (previousContainer) {
      return previousContainer.transferPanelTo(panel, this);
    }

    const index = this.attachPanelState(panel);
    try {
      this.emitter.emit("did-add-panel", { panel, index });
    } catch (error) {
      this.detachPanelState(panel);
      panel.destroy();
      throw error;
    }
    return panel;
  }

  // A live surface-relocatable panel is never released into an ownerless
  // state. It moves through transferPanelTo(), which changes both containers'
  // model state before either emits an observable event.
  removePanel(panel) {
    const index = this.panels.indexOf(panel);
    if (index === -1) return false;
    if (panel.isSurfaceRelocatable() && !panel.isDestroyed()) {
      throw new Error("A live surface-relocatable panel must move directly to another container");
    }

    this.detachPanelState(panel);
    this.emitter.emit("did-remove-panel", { panel, index });
    return true;
  }

  transferPanelTo(panel, destination) {
    this.validateTransfer(panel, destination);
    if (destination === this) return panel;

    const sourceIndex = this.panels.indexOf(panel);
    let destinationIndex = -1;
    panel.transferring = true;

    try {
      this.detachPanelState(panel, { keepContainer: true });
      destinationIndex = destination.attachPanelState(panel);
      this.emitter.emit("did-remove-panel", { panel, index: sourceIndex });
      destination.emitter.emit("did-add-panel", { panel, index: destinationIndex });
      return panel;
    } catch (error) {
      const rollbackErrors = [];
      try {
        if (destination.containsPanel(panel)) {
          destination.detachPanelState(panel, { keepContainer: true });
        }
        if (!this.containsPanel(panel)) this.attachPanelState(panel, sourceIndex);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        if (destinationIndex !== -1) {
          destination.emitter.emit("did-remove-panel", { panel, index: destinationIndex });
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        this.emitter.emit("did-add-panel", { panel, index: sourceIndex });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Panel transfer failed and could not be rolled back cleanly",
          { cause: error },
        );
      }
      throw error;
    } finally {
      panel.transferring = false;
      panel.transferFocusTarget = null;
      panel.transferPriorFocus = null;
    }
  }

  validateTransfer(panel, destination) {
    if (!(destination instanceof PanelContainer)) {
      throw new TypeError("A panel destination must be a PanelContainer");
    }
    if (this.isDestroyed() || destination?.isDestroyed?.()) {
      throw new Error("A panel can move only between live containers");
    }
    if (!this.containsPanel(panel) || panel.getContainer() !== this) {
      throw new Error("The source container does not own this panel");
    }
    if (!panel.isSurfaceRelocatable()) {
      throw new Error("Only a surface-relocatable panel can move between containers");
    }
    if (!this.isModal() || !destination?.isModal?.()) {
      throw new Error("A surface-relocatable panel can move only between modal containers");
    }
    if (panel.isVisible() && destination.getPanels().some((candidate) => candidate.isVisible())) {
      throw new Error(
        "A visible modal cannot move onto a surface that already has a visible modal",
      );
    }
  }

  attachPanelState(panel, index = this.getPanelIndex(panel)) {
    if (this.panelSubscriptions.has(panel) || this.panels.includes(panel)) {
      throw new Error("The panel is already present in this container");
    }
    const destroySubscription = panel.onDidDestroy(() => this.removePanel(panel));
    this.panelSubscriptions.set(panel, destroySubscription);
    this.subscriptions.add(destroySubscription);
    panel.setContainer(this);
    this.panels.splice(index, 0, panel);
    return index;
  }

  detachPanelState(panel, { keepContainer = false } = {}) {
    const index = this.panels.indexOf(panel);
    if (index === -1) return -1;
    this.panels.splice(index, 1);
    const destroySubscription = this.panelSubscriptions.get(panel);
    if (destroySubscription) {
      this.panelSubscriptions.delete(panel);
      this.subscriptions.remove(destroySubscription);
      destroySubscription.dispose();
    }
    if (!keepContainer && panel.getContainer() === this) {
      panel.setContainer(null);
      if (this.isModal()) {
        panel.flowKeeper = null;
        panel.surface = null;
      }
    }
    return index;
  }

  panelForItem(item) {
    for (let panel of this.panels) {
      if (panel.getItem() === item) {
        return panel;
      }
    }
    return null;
  }

  getPanelIndex(panel) {
    const priority = panel.getPriority();
    if (["bottom", "right"].includes(this.location)) {
      for (let i = this.panels.length - 1; i >= 0; i--) {
        const p = this.panels[i];
        if (priority < p.getPriority()) {
          return i + 1;
        }
      }
      return 0;
    } else {
      for (let i = 0; i < this.panels.length; i++) {
        const p = this.panels[i];
        if (priority < p.getPriority()) {
          return i;
        }
      }
      return this.panels.length;
    }
  }
};
