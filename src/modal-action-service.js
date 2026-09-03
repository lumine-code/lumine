"use strict";

const { CompositeDisposable } = require("@lumine-code/event-kit");
const { humanizeKeystroke } = require("@lumine-code/underscore-plus");

/**
 * Owns the single action picker used by every modal model in one workspace.
 *
 * SelectList construction is injected so this service never imports the public
 * model and cannot create an InputDialog/SelectList module cycle.
 * @private
 */
module.exports = class ModalActionService {
  constructor({ createSelectList, commandRegistry, workspace }) {
    if (typeof createSelectList !== "function") {
      throw new TypeError("ModalActionService requires a createSelectList callback.");
    }
    this.createSelectList = createSelectList;
    this.commandRegistry = commandRegistry;
    this.workspace = workspace;
    this.disposables = new CompositeDisposable();
    this.forwardersDisposable = null;
    this.owner = null;
    this.context = null;
    this.destroyed = false;
  }

  async show({ owner, actions, context, infoMessage = null }) {
    if (this.destroyed) throw new Error("ModalActionService has been destroyed.");
    if (!owner || !Array.isArray(actions) || actions.length === 0) return false;

    const picker = this.getPicker();
    this.disposeForwarders();
    this.owner = owner;
    this.context = Object.freeze({ ...context });

    const separatorIds = [];
    let previousGroup = null;
    actions.forEach((action, index) => {
      const group = action.group ?? action.context ?? "dialog";
      if (index > 0 && group !== previousGroup) separatorIds.push(action.command);
      previousGroup = group;
    });

    await picker.update({ items: actions, separatorIds, infoMessage, status: null });
    picker.reset();

    const forwarders = {};
    for (const action of actions) {
      forwarders[action.command] = (event) => {
        event.stopPropagation();
        return this.confirmAction(action);
      };
    }
    this.forwardersDisposable = this.commandRegistry.add(picker.getElement(), forwarders);
    picker.show({ crumb: "Actions" });
    return true;
  }

  getPicker() {
    if (this.picker) return this.picker;

    this.picker = this.createSelectList({
      className: "select-list-actions",
      internalActionPalette: true,
      items: [],
      getItemId: (action) => action.command,
      search: {
        getFilterText: (action) => `${action.name} ${action.description ?? ""}`,
      },
      renderItem: (action, { highlight }) => ({
        className: [
          action.enabled === false && "disabled",
          action.tone === "danger" && "text-error",
        ].filter(Boolean),
        primary: highlight(action.name),
        secondary:
          action.enabled === false
            ? action.disabledReason || action.description
            : action.description,
        trailing: (action.keystrokes ?? []).map((keystrokes) => ({
          text: humanizeKeystroke(keystrokes),
          className: "key-binding",
        })),
        didRender: (element) => {
          if (action.enabled === false) element.setAttribute("aria-disabled", "true");
        },
      }),
    });
    this.disposables.add(
      this.picker.onDidConfirmSelection(({ item }) => this.confirmAction(item)),
      this.picker.onDidCancel(() => this.disposeForwarders()),
      this.picker.onDidHide(() => this.disposeForwarders()),
    );
    return this.picker;
  }

  async confirmAction(action) {
    if (!action || !this.owner) return false;
    if (action.enabled === false) {
      await this.picker.setStatus({
        type: "warning",
        message: action.disabledReason || "This action is unavailable.",
      });
      return false;
    }

    const owner = this.owner;
    const context = this.context;
    if (!this.workspace.popModal()) {
      this.picker.hide();
      owner.getPanel().show();
    }
    this.disposeForwarders();
    return owner.runAction(action.command, { source: "actions", context });
  }

  hide() {
    if (!this.picker?.isVisible()) return false;
    this.picker.hide();
    this.disposeForwarders();
    return true;
  }

  isVisible() {
    return Boolean(this.picker?.isVisible());
  }

  release(owner) {
    if (this.owner !== owner) return false;
    if (this.picker?.isVisible()) this.picker.hide();
    this.disposeForwarders();
    return true;
  }

  disposeForwarders() {
    if (this.forwardersDisposable) {
      this.forwardersDisposable.dispose();
      this.forwardersDisposable = null;
    }
    this.owner = null;
    this.context = null;
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.disposeForwarders();
    this.disposables.dispose();
    if (this.picker) {
      await this.picker.destroy();
      this.picker = null;
    }
  }
};
