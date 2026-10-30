"use strict";

const InputDialogHost = require("./input-dialog-host");

/**
 * @public
 * @status experimental
 *
 * Modal host for a detached {@link SelectList} model. It inherits the complete
 * visibility, focus, modal-flow and session lifecycle of
 * {@link InputDialogHost} while narrowing {@link #getModel} to SelectList.
 */
module.exports = class SelectListHost extends InputDialogHost {
  constructor(model, services, options, lifecycle) {
    super(model, services, options, lifecycle);
    this.disposables.add(model.onDidChangeKeepOpen(() => this.updateKeepOpenPresentation()));
  }

  getPanel() {
    const panel = super.getPanel();
    this.updateKeepOpenPresentation();
    return panel;
  }

  /** @private List geometry remains owned by the active UI theme. */
  panelClassName() {
    return this.options.className;
  }

  /** @private Await both source publication and the opening query's ranking. */
  show(options = {}) {
    return super.show(options).then(() => this.model.queryWork?.promise);
  }

  updateKeepOpenPresentation() {
    this.panel?.getElement().toggleAttribute("keep-open", this.model.isKeepOpen());
  }

  resumeFocusTrap() {
    super.resumeFocusTrap();
    if (this.isVisible() && this.model.isKeepOpen() && !this.model.isActionPending()) this.focus();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the complete detached select-list model.
   * @returns {SelectList}
   * @category Model and Panel
   */
  getModel() {
    return super.getModel();
  }
};
