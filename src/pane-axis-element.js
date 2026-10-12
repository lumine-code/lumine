const { CompositeDisposable } = require("@lumine-code/event-kit");
const { refreshPaneLayout } = require("./pane-layout");
require("./pane-resize-handle-element");

class PaneAxisElement extends HTMLElement {
  connectedCallback() {
    if (this.subscriptions == null) {
      this.subscriptions = this.subscribeToModel();
    }
    this.model.getChildren().map((child, index) => this.childAdded({ child, index }));
  }

  disconnectedCallback() {
    this.subscriptions?.dispose();
    this.subscriptions = null;
    this.model.getChildren().map((child) => this.childRemoved({ child }));
  }

  connectedMoveCallback() {}

  initialize(model, viewRegistry) {
    this.model = model;
    this.viewRegistry = viewRegistry;
    if (this.subscriptions == null) {
      this.subscriptions = this.subscribeToModel();
    }
    // A new axis can wrap an already connected pane. Populate only after this
    // destination is connected, so moving the pane never detaches its subtree.
    this.model.getChildren().forEach((child, index) => this.childAdded({ child, index }));

    switch (this.model.getOrientation()) {
      case "horizontal":
        this.classList.add("horizontal", "pane-row");
        break;
      case "vertical":
        this.classList.add("vertical", "pane-column");
        break;
    }
    return this;
  }

  subscribeToModel() {
    const subscriptions = new CompositeDisposable();
    subscriptions.add(this.model.onDidAddChild(this.childAdded.bind(this)));
    subscriptions.add(this.model.onDidRemoveChild(this.childRemoved.bind(this)));
    subscriptions.add(this.model.onDidReplaceChild(this.childReplaced.bind(this)));
    subscriptions.add(this.model.observeFlexScale(this.flexScaleChanged.bind(this)));
    return subscriptions;
  }

  isPaneResizeHandleElement(element) {
    return (
      (element != null ? element.nodeName.toLowerCase() : undefined) === "lumine-pane-resize-handle"
    );
  }

  childAdded({ child, index }) {
    let resizeHandle;
    const view = this.viewRegistry.getView(child);
    if (!this.isConnected && view.isConnected) return;
    const reference = this.children[index * 2] || null;
    if (view === reference) return;
    if (view.isConnected && view.ownerDocument === this.ownerDocument)
      this.moveBefore(view, reference);
    else this.insertBefore(view, reference);

    const prevElement = view.previousSibling;
    // if previous element is not pane resize element, then insert new resize element
    if (prevElement != null && !this.isPaneResizeHandleElement(prevElement)) {
      resizeHandle = this.ownerDocument.createElement("lumine-pane-resize-handle");
      this.insertBefore(resizeHandle, view);
    }

    const nextElement = view.nextSibling;
    // if next element isnot resize element, then insert new resize element
    if (nextElement != null && !this.isPaneResizeHandleElement(nextElement)) {
      resizeHandle = this.ownerDocument.createElement("lumine-pane-resize-handle");
      this.insertBefore(resizeHandle, nextElement);
    }
    refreshPaneLayout(this);
  }

  childRemoved({ child }) {
    const view = this.viewRegistry.getView(child);
    if (view.parentNode !== this) return;
    const siblingView = view.previousSibling;
    // make sure next sibling view is pane resize view
    if (siblingView != null && this.isPaneResizeHandleElement(siblingView)) {
      siblingView.remove();
    }
    view.remove();
    refreshPaneLayout(this);
  }

  childReplaced({ index, oldChild, newChild }) {
    let focusedElement;
    if (this.hasFocus()) {
      focusedElement = this.ownerDocument.activeElement;
    }
    const oldView = this.viewRegistry.getView(oldChild);
    const newView = this.viewRegistry.getView(newChild);
    if (!this.isConnected && newView.isConnected) return;
    const reference = oldView.parentNode === this ? oldView : this.children[index * 2] || null;
    if (this.isConnected && newView.isConnected && newView.ownerDocument === this.ownerDocument)
      this.moveBefore(newView, reference);
    else this.insertBefore(newView, reference);
    // Connecting a wrapping axis already moved oldView into it. A collapsing
    // axis has its surviving child moved out before the obsolete axis goes.
    if (oldView.parentNode === this) oldView.remove();
    refreshPaneLayout(this);
    if (this.ownerDocument.activeElement === this.ownerDocument.body) {
      return focusedElement != null ? focusedElement.focus() : undefined;
    }
  }

  flexScaleChanged(flexScale) {
    this.style.flexGrow = flexScale;
  }

  hasFocus() {
    return (
      this === this.ownerDocument.activeElement || this.contains(this.ownerDocument.activeElement)
    );
  }
}

window.customElements.define("lumine-pane-axis", PaneAxisElement);

function createPaneAxisElement() {
  return document.createElement("lumine-pane-axis");
}

module.exports = {
  createPaneAxisElement,
};
