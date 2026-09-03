"use strict";

const InputDialog = require("./input-dialog");
const SelectList = require("./select-list");
const ModalActionService = require("./modal-action-service");

/**
 * Builds modal UI models with the services of one editor window.
 *
 * The factory is intentionally internal. Packages receive full InputDialog and
 * SelectList models through Workspace, while construction details stay with
 * the window that owns their panels, commands, keymaps, and query editors.
 * @private
 */
module.exports = class ModalDialogFactory {
  constructor(services) {
    this.actionService = new ModalActionService({
      createSelectList: (options) => new SelectList(options, this.services),
      commandRegistry: services.commandRegistry,
      workspace: services.workspace,
    });
    this.services = Object.freeze({ ...services, actionService: this.actionService });
  }

  buildInputDialog(options) {
    return new InputDialog(options, this.services);
  }

  buildSelectList(options) {
    return new SelectList(options, this.services);
  }

  destroy() {
    return this.actionService.destroy();
  }
};
