const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const { refreshPaneLayout } = require("./pane-layout");
const { captureLifecycleError, throwLifecycleErrors } = require("./package-lifecycle-errors");

// A pane keeps its model, items and live DOM subtree while its presentation
// leaves the split layout. The slot remains the axis child, preserving its
// flex weight and the pane/resize-handle sequence.
class PanePresentation {
  constructor(container, pane) {
    this.container = container;
    this.pane = pane;
    this.element = pane.getElement();
    this.slot = this.element.ownerDocument.createElement("div");
    this.slot.classList.add("pane-presentation-slot");
    this.slot.model = pane;
    this.disposeCallbacks = new Set();
    this.subscriptions = new CompositeDisposable();
    this.disposed = false;

    // Flex distributes the content space after accounting for each child's
    // outer box. Preserve that contribution so borders, padding and margins
    // cannot shift the original pane's slot or its neighboring splits.
    const styles = this.element.ownerDocument.defaultView.getComputedStyle(this.element);
    for (const property of [
      "box-sizing",
      "flex-basis",
      "flex-shrink",
      "align-self",
      "order",
      "min-width",
      "min-height",
      "max-width",
      "max-height",
    ])
      this.slot.style.setProperty(property, styles.getPropertyValue(property));
    for (const side of ["top", "right", "bottom", "left"]) {
      for (const property of [`margin-${side}`, `padding-${side}`, `border-${side}-width`])
        this.slot.style.setProperty(property, styles.getPropertyValue(property));
      this.slot.style.setProperty(`border-${side}-style`, "solid");
      this.slot.style.setProperty(`border-${side}-color`, "transparent");
    }

    try {
      const parent = this.element.parentNode;
      parent.insertBefore(this.slot, this.element);
      this.element.layoutElement = this.slot;
      this.slot.moveBefore(this.element, null);
      this.subscriptions.add(
        pane.observeFlexScale((scale) => {
          this.slot.style.flexGrow = scale;
        }),
      );
      this.subscriptions.add(pane.onWillDestroy(() => this.dispose()));
    } catch (error) {
      const failures = [error];
      captureLifecycleError(failures, () => this.dispose());
      throwLifecycleErrors(failures, "Unable to create and release a pane presentation.");
    }
  }

  onDidDispose(callback) {
    if (typeof callback !== "function") throw new TypeError("A disposal callback is required.");
    if (!this.disposed) this.disposeCallbacks.add(callback);
    return new Disposable(() => this.disposeCallbacks.delete(callback));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.container.panePresentation === this) this.container.panePresentation = null;
    delete this.element.layoutElement;
    const parent = this.slot.parentNode;
    if (parent && this.element.parentNode === this.slot) {
      if (parent.isConnected && this.element.isConnected)
        parent.moveBefore(this.element, this.slot);
      else parent.insertBefore(this.element, this.slot);
    }
    this.slot.remove();
    const failures = [];
    captureLifecycleError(failures, () => this.subscriptions.dispose());
    // Owners restore their presentation styles before editor measurements.
    const callbacks = [...this.disposeCallbacks];
    this.disposeCallbacks.clear();
    for (const callback of callbacks) captureLifecycleError(failures, callback);
    captureLifecycleError(failures, () => refreshPaneLayout(this.container.getElement()));
    throwLifecycleErrors(failures, "Unable to release all pane presentation resources.");
  }
}

module.exports = PanePresentation;
