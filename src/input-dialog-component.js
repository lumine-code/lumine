"use strict";

const etch = require("@lumine-code/etch");

/**
 * Private Etch renderer for an InputDialog or SelectList model.
 *
 * The public model owns behavior and state. This component owns Etch's element,
 * virtual tree, and refs so rendering can change without changing the model API.
 * @private
 */
module.exports = class InputDialogComponent {
  constructor(model) {
    this.model = model;
    etch.initialize(this);
  }

  render() {
    return this.model.render();
  }

  update() {
    return etch.update(this);
  }

  destroy() {
    return etch.destroy(this);
  }
};
