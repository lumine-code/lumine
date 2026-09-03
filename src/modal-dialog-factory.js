"use strict";

const InputDialog = require("./input-dialog");
const SelectList = require("./select-list");
const InputDialogHost = require("./input-dialog-host");
const SelectListHost = require("./select-list-host");
const ModalActionService = require("./modal-action-service");

const MODAL_MODEL_OPTIONS = new Set([
  "item",
  "crumb",
  "visible",
  "restoreFocus",
  "priority",
  "className",
  "panelItem",
]);

/** @private */
module.exports = class ModalDialogFactory {
  constructor(services) {
    this.models = new WeakSet();
    this.hostByModel = new WeakMap();
    this.hosts = new Set();
    this.destroyed = false;
    this.actionService = new ModalActionService({
      createSelectListHost: (options, hostOptions) => this.addSelectList(options, hostOptions),
      commandRegistry: services.commandRegistry,
      keymapManager: services.keymapManager,
      workspace: services.workspace,
    });
    this.services = Object.freeze({ ...services, actionService: this.actionService });
  }

  buildInputDialog(options = {}) {
    this.assertAlive();
    validateModelOptions(options);
    const model = new InputDialog(options, this.services);
    this.models.add(model);
    return model;
  }

  buildSelectList(options = {}) {
    this.assertAlive();
    validateModelOptions(options);
    const model = new SelectList(options, this.services);
    this.models.add(model);
    return model;
  }

  addInputDialog(modelOrOptions, hostOptions = {}) {
    if (modelOrOptions instanceof SelectList) {
      throw new TypeError("addInputDialog requires an InputDialog model, not a SelectList.");
    }
    const existing =
      modelOrOptions instanceof InputDialog && !(modelOrOptions instanceof SelectList);
    const model = existing ? modelOrOptions : this.buildInputDialog(modelOrOptions);
    return this.addHost(model, InputDialogHost, hostOptions, !existing);
  }

  addSelectList(modelOrOptions, hostOptions = {}) {
    if (modelOrOptions instanceof InputDialog && !(modelOrOptions instanceof SelectList)) {
      throw new TypeError("addSelectList requires a SelectList model, not an InputDialog.");
    }
    const existing = modelOrOptions instanceof SelectList;
    const model = existing ? modelOrOptions : this.buildSelectList(modelOrOptions);
    return this.addHost(model, SelectListHost, hostOptions, !existing);
  }

  addHost(model, Host, hostOptions, ownsModel) {
    this.assertAlive();
    if (!this.models.has(model)) {
      throw new Error("A modal host can only use a model built by this workspace.");
    }
    if (model.isDestroyed()) throw new Error("A destroyed dialog model cannot be hosted.");
    if (this.hostByModel.has(model)) throw new Error("This dialog model already has a modal host.");

    let host;
    try {
      host = new Host(model, this.services, hostOptions, {
        ownsModel,
        didDestroy: () => {
          if (this.hostByModel.get(model) === host) this.hostByModel.delete(model);
          this.hosts.delete(host);
        },
      });
    } catch (error) {
      if (ownsModel) void model.destroy();
      throw error;
    }
    this.hostByModel.set(model, host);
    this.hosts.add(host);
    return host;
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    const hosts = Array.from(this.hosts, (host) => host.destroy());
    this.destroyPromise = Promise.allSettled([this.actionService.destroy(), ...hosts]);
    return this.destroyPromise;
  }

  assertAlive() {
    if (this.destroyed) throw new Error("The modal dialog factory has been destroyed.");
  }
};

function validateModelOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Dialog model options must be an object.");
  }
  for (const option of MODAL_MODEL_OPTIONS) {
    if (Object.prototype.hasOwnProperty.call(options, option)) {
      throw new TypeError(`'${option}' is a modal host option, not a dialog model option.`);
    }
  }
}
