const { CompositeDisposable } = require("@lumine-code/event-kit");
const { refreshPaneLayout } = require("./pane-layout");

class PaneContainerElement extends HTMLElement {
  constructor() {
    super();
    this.subscriptions = new CompositeDisposable();
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

  connectedMoveCallback() {}

  rootChanged(root) {
    const focusedElement = this.hasFocus() ? this.ownerDocument.activeElement : null;
    const oldView = this.firstChild;
    if (root != null) {
      const view = this.views.getView(root);
      if (view !== oldView) {
        const reference = oldView?.parentNode === this ? oldView : null;
        if (view.isConnected && this.isConnected && view.ownerDocument === this.ownerDocument)
          this.moveBefore(view, reference);
        else this.insertBefore(view, reference);
      }
      if (oldView && oldView !== view && oldView.parentNode === this) oldView.remove();
      refreshPaneLayout(this);
      if (focusedElement != null) {
        focusedElement.focus();
      }
    } else {
      oldView?.remove();
    }
  }

  hasFocus() {
    return (
      this === this.ownerDocument.activeElement || this.contains(this.ownerDocument.activeElement)
    );
  }
}

window.customElements.define("lumine-pane-container", PaneContainerElement);

function createPaneContainerElement() {
  return document.createElement("lumine-pane-container");
}

module.exports = {
  createPaneContainerElement,
};
