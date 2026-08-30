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
      throw new Error("A panel cannot belong to more than one container");
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

  removePanel(panel) {
    const index = this.panels.indexOf(panel);
    if (index === -1) return false;

    this.detachPanelState(panel);
    this.emitter.emit("did-remove-panel", { panel, index });
    return true;
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

  detachPanelState(panel) {
    const index = this.panels.indexOf(panel);
    if (index === -1) return -1;
    this.panels.splice(index, 1);
    const destroySubscription = this.panelSubscriptions.get(panel);
    if (destroySubscription) {
      this.panelSubscriptions.delete(panel);
      this.subscriptions.remove(destroySubscription);
      destroySubscription.dispose();
    }
    if (panel.getContainer() === this) {
      panel.setContainer(null);
      if (this.isModal()) panel.flowKeeper = null;
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
