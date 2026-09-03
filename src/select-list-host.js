"use strict";

const InputDialogHost = require("./input-dialog-host");

/**
 * @public
 * @status experimental
 *
 * Modal host for a detached {@link SelectList} model.
 */
module.exports = class SelectListHost extends InputDialogHost {
  /**
   * @public
   * @status experimental
   *
   * Return the complete detached select-list model.
   * @returns {SelectList}
   */
  getModel() {
    return super.getModel();
  }
};
