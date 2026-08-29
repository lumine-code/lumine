const { CompositeDisposable } = require("@lumine-code/event-kit");
const { classFactory } = require("./realm-custom-element");

function initializePaneContainerElement() {
  this.subscriptions = new CompositeDisposable();
}

class PaneContainerElement extends HTMLElement {
  constructor() {
    super();
    initializePaneContainerElement.call(this);
  }

  initialize(model, { views }) {
    this.model = model;
    this.views = views;
    if (this.views == null) {
      throw new Error("Must pass a views parameter when initializing PaneContainerElements");
    }
    this.subscriptions.add(this.model.observeRoot(this.rootChanged.bind(this)));
    return this;
  }

  connectedCallback() {
    this.classList.add("panes");
  }

  rootChanged(root) {
    const focusedElement = this.hasFocus() ? this.ownerDocument.activeElement : null;
    if (this.firstChild != null) {
      this.firstChild.remove();
    }
    if (root != null) {
      const view = this.views.getView(root);
      this.appendChild(view);
      if (focusedElement != null) {
        focusedElement.focus();
      }
    }
  }

  hasFocus() {
    const activeElement = this.ownerDocument.activeElement;
    return this === activeElement || this.contains(activeElement);
  }
}

function createPaneContainerElement(document = globalThis.document) {
  return document.createElement("lumine-pane-container");
}

module.exports = {
  createPaneContainerElement,
  elementDefinition: {
    name: "lumine-pane-container",
    factory: classFactory(PaneContainerElement, initializePaneContainerElement),
  },
};
