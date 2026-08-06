const { Emitter } = require("@lumine-code/event-kit");

// Extended: A container representing a panel on the edges of the editor window.
// You should not create a `Panel` directly, instead use {Workspace::addTopPanel}
// and friends to add panels.
//
// Examples: status-bar and search-panel both use panels.
module.exports = class Panel {
  /*
  Section: Construction and Destruction
  */

  constructor(
    { item, autoFocus, restoreFocus, visible, priority, className, crumb },
    viewRegistry,
  ) {
    this.destroyed = false;
    this.item = item;
    this.autoFocus = autoFocus == null ? false : autoFocus;
    this.restoreFocus = restoreFocus == null ? true : restoreFocus;
    this.visible = visible == null ? true : visible;
    this.priority = priority == null ? 100 : priority;
    this.className = className;
    this.crumb = crumb;
    // Assigned by the workspace for modal panels; the keeper of the window's
    // modal breadcrumb trail (see Workspace::addPanel and src/modal-flow.js).
    this.flowKeeper = null;
    // True only while the modal flow hides this panel to move to another step.
    // Owners that treat an unrequested hide as a cancel consult it to tell a
    // flow transition apart from a dismissal.
    this.flowTransition = false;
    this.viewRegistry = viewRegistry;
    this.emitter = new Emitter();
  }

  // Public: Destroy and remove this panel from the UI.
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hide();
    if (this.element) this.element.remove();
    this.emitter.emit("did-destroy", this);
    return this.emitter.dispose();
  }

  getElement() {
    if (!this.element) {
      this.element = document.createElement("atom-panel");
      if (!this.visible) this.element.style.display = "none";
      if (this.className) this.element.classList.add(...this.className.split(" "));
      this.element.appendChild(this.viewRegistry.getView(this.item));
    }
    return this.element;
  }

  /*
  Section: Event Subscription
  */

  // Public: Invoke the given callback when the pane hidden or shown.
  //
  // * `callback` {Function} to be called when the pane is destroyed.
  //   * `visible` {Boolean} true when the panel has been shown
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeVisible(callback) {
    return this.emitter.on("did-change-visible", callback);
  }

  // Public: Invoke the given callback when the pane is destroyed.
  //
  // * `callback` {Function} to be called when the pane is destroyed.
  //   * `panel` {Panel} this panel
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /*
  Section: Panel Details
  */

  // Public: Returns the panel's item.
  getItem() {
    return this.item;
  }

  // Public: Returns a {Number} indicating this panel's priority.
  getPriority() {
    return this.priority;
  }

  getClassName() {
    return this.className;
  }

  // Public: Returns a {Boolean} true when the panel is visible.
  isVisible() {
    return this.visible;
  }

  // Public: Hide this panel
  hide() {
    let wasVisible = this.visible;
    this.visible = false;
    if (this.element) this.element.style.display = "none";
    if (wasVisible) this.emitter.emit("did-change-visible", this.visible);
  }

  // Public: Show this panel.
  //
  // * `options` (optional) {Object}
  //   * `crumb` Modal panels only. A {String}, or `true` to use the label the
  //     panel declared when it was added. The panel announces "display me now
  //     and take me into the breadcrumb": the modal that is visible at this
  //     moment becomes the previous entry of the window's modal trail, the
  //     breadcrumb strip shows the path, and `modal:go-back` (Shift-Escape)
  //     or a click on an earlier crumb returns to it. Without `crumb` the
  //     panel is shown standalone, exactly as before — and showing a modal
  //     standalone ends whatever trail another flow had built.
  show(options) {
    if (options != null) {
      for (const key of Object.keys(options)) {
        if (key !== "crumb") {
          throw new TypeError(`Panel::show received an unknown option "${key}"`);
        }
      }
      if ("crumb" in options) {
        if (typeof options.crumb !== "string" && options.crumb !== true) {
          throw new TypeError("The crumb option must be a string or true");
        }
        if (!this.flowKeeper) {
          throw new Error("The crumb option is only supported on modal panels");
        }
        this.flowKeeper.showStep(this, options.crumb === true ? this.crumb : options.crumb);
        return;
      }
    }
    let wasVisible = this.visible;
    this.visible = true;
    if (this.element) this.element.style.display = null;
    if (!wasVisible) this.emitter.emit("did-change-visible", this.visible);
  }
};
