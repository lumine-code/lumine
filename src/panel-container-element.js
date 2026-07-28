"use strict";

const { createFocusTrap } = require("focus-trap");
const { CompositeDisposable } = require("event-kit");

class PanelContainerElement extends HTMLElement {
  constructor() {
    super();
    this.subscriptions = new CompositeDisposable();
    this.panelSubscriptions = new Map();
  }

  connectedCallback() {
    if (this.model.dock) {
      this.model.dock.elementAttached();
    }
  }

  initialize(model, viewRegistry) {
    this.model = model;
    this.viewRegistry = viewRegistry;

    this.subscriptions.add(this.model.onDidAddPanel(this.panelAdded.bind(this)));
    this.subscriptions.add(this.model.onDidDestroy(this.destroyed.bind(this)));
    this.classList.add(this.model.getLocation());

    // Add the dock.
    if (this.model.dock != null) {
      this.appendChild(this.model.dock.getElement());
    }

    return this;
  }

  getModel() {
    return this.model;
  }

  panelAdded({ panel, index }) {
    const panelElement = panel.getElement();
    panelElement.classList.add(this.model.getLocation());
    if (this.model.isModal()) {
      panelElement.classList.add("overlay", "from-top");
    } else {
      panelElement.classList.add("tool-panel", `panel-${this.model.getLocation()}`);
    }

    if (index >= this.childNodes.length) {
      this.appendChild(panelElement);
    } else {
      const referenceItem = this.childNodes[index];
      this.insertBefore(panelElement, referenceItem);
    }

    if (this.model.isModal()) {
      // Per-panel subscriptions live in their own composite so destroying a
      // panel prunes them. Adding them to the container's composite leaked for
      // the window's lifetime, three per panel, however often panels churned.
      const panelSubscriptions = new CompositeDisposable();
      this.panelSubscriptions.set(panel, panelSubscriptions);
      this.subscriptions.add(
        panel.onDidDestroy(() => {
          panelSubscriptions.dispose();
          this.panelSubscriptions.delete(panel);
        }),
      );

      // Only a *visible* panel displaces the others. A panel added hidden (the
      // usual `{visible: false}` construction) used to force-hide whatever was
      // on screen the moment it was created, with no callback to the owner.
      if (panel.isVisible()) this.hideAllPanelsExcept(panel);
      panelSubscriptions.add(
        panel.onDidChangeVisible((visible) => {
          if (visible) {
            this.hideAllPanelsExcept(panel);
          }
        }),
      );

      if (panel.restoreFocus) {
        if (panel.isVisible()) this.capturePriorFocus();
        panelSubscriptions.add(
          panel.onDidChangeVisible((visible) => {
            if (visible) {
              this.capturePriorFocus();
            } else {
              this.restorePriorFocus(panelElement);
            }
          }),
        );
      }

      if (panel.autoFocus) {
        const focusOptions = {
          // focus-trap will attempt to give focus to the first tabbable element
          // on activation. If there aren't any tabbable elements,
          // give focus to the panel element itself
          fallbackFocus: panelElement,
          // closing is handled by core Lumine commands and this already deactivates
          // on visibility changes
          escapeDeactivates: false,
          delayInitialFocus: false,
          // focus restoration is handled centrally by the container, which
          // tracks focus across chained modals instead of per activation
          returnFocusOnDeactivate: false,
        };

        if (panel.autoFocus !== true) {
          focusOptions.initialFocus = panel.autoFocus;
        }
        const modalFocusTrap = createFocusTrap(panelElement, focusOptions);

        panelSubscriptions.add(
          panel.onDidChangeVisible((visible) => {
            if (visible) {
              modalFocusTrap.activate();
            } else {
              modalFocusTrap.deactivate();
            }
          }),
        );
      }
    }
  }

  destroyed() {
    for (const subscriptions of this.panelSubscriptions.values()) subscriptions.dispose();
    this.panelSubscriptions.clear();
    this.subscriptions.dispose();
    if (this.parentNode != null) {
      this.parentNode.removeChild(this);
    }
  }

  // Remembers where focus was before a modal opened. When modals open on top
  // of each other, only the element focused before the first modal is kept.
  capturePriorFocus() {
    const active = document.activeElement;
    if (active && active !== document.body && !this.contains(active)) {
      this.priorFocus = active;
    }
  }

  restorePriorFocus(panelElement) {
    if (!this.priorFocus) return;

    // another modal took over — keep the prior focus for when it closes
    if (this.model.getPanels().some((panel) => panel.isVisible())) return;

    // the user moved focus elsewhere themselves — don't steal it back
    const active = document.activeElement;
    if (active && active !== document.body && !panelElement.contains(active)) return;

    if (this.priorFocus.isConnected) {
      this.priorFocus.focus();
    } else if (typeof atom !== "undefined") {
      const pane = atom.workspace.getActivePane();
      if (pane && !pane.isDestroyed()) pane.activate();
    }
    this.priorFocus = null;
  }

  hideAllPanelsExcept(excludedPanel) {
    for (let panel of this.model.getPanels()) {
      if (panel !== excludedPanel) {
        panel.hide();
      }
    }
  }
}

window.customElements.define("atom-panel-container", PanelContainerElement);

function createPanelContainerElement() {
  return document.createElement("atom-panel-container");
}

module.exports = {
  createPanelContainerElement,
};
