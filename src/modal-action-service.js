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
  constructor({ createSelectList, commandRegistry, keymapManager, workspace }) {
    if (typeof createSelectList !== "function") {
      throw new TypeError("ModalActionService requires a createSelectList callback.");
    }
    if (!keymapManager || typeof keymapManager.add !== "function") {
      throw new TypeError("ModalActionService requires a keymap manager.");
    }
    this.createSelectList = createSelectList;
    this.commandRegistry = commandRegistry;
    this.keymapManager = keymapManager;
    this.workspace = workspace;
    this.disposables = new CompositeDisposable();
    this.forwardersDisposable = null;
    this.owner = null;
    this.context = null;
    this.pendingOwner = null;
    this.showGeneration = 0;
    this.actionStateGeneration = 0;
    this.actionCommands = null;
    this.destroyed = false;
  }

  async show({ owner, actions, context, infoMessage = null }) {
    if (this.destroyed) throw new Error("ModalActionService has been destroyed.");
    if (!owner || !Array.isArray(actions) || actions.length === 0) return false;

    const picker = this.getPicker();
    const generation = ++this.showGeneration;
    this.disposeForwarders({ clearPicker: false });
    this.pendingOwner = owner;
    const capturedContext = Object.freeze({ ...context });

    const sections = this.sectionsForActions(actions);

    try {
      await picker.update({ sections, query: "", infoMessage, status: null });
    } catch (error) {
      if (this.showGeneration === generation) this.pendingOwner = null;
      throw error;
    }
    if (this.destroyed || this.showGeneration !== generation || this.pendingOwner !== owner) {
      return false;
    }
    this.pendingOwner = null;
    this.owner = owner;
    this.context = capturedContext;
    this.actionCommands = actions.map(({ command }) => command);

    const forwarders = {};
    const keyBindings = {};
    for (const action of actions) {
      forwarders[action.command] = (event) => {
        event.stopPropagation();
        return this.confirmAction(action).catch(() => false);
      };
      for (const keystrokes of action.commandKeystrokes ?? []) {
        if (!Object.prototype.hasOwnProperty.call(keyBindings, keystrokes)) {
          keyBindings[keystrokes] = action.command;
        }
      }
    }
    const registrations = [this.commandRegistry.add(picker.getElement(), forwarders)];
    if (Object.keys(keyBindings).length > 0) {
      registrations.push(
        this.keymapManager.add("core:modal-action-service", {
          ".select-list-actions lumine-text-editor[mini]": keyBindings,
        }),
      );
    }
    if (typeof owner.onDidStartAction === "function") {
      registrations.push(
        owner.onDidStartAction(() => {
          void this.refreshActionStates(owner, generation).catch(() => {});
        }),
      );
    }
    if (typeof owner.onDidFinishAction === "function") {
      registrations.push(
        owner.onDidFinishAction(() => {
          void this.refreshActionStates(owner, generation).catch(() => {});
        }),
      );
    }
    this.forwardersDisposable = new CompositeDisposable(...registrations);
    try {
      picker.show({ crumb: "Actions" });
    } catch (error) {
      this.disposeForwarders();
      throw error;
    }
    return true;
  }

  sectionsForActions(actions) {
    const sections = [];
    actions.forEach((action) => {
      const group = action.group ?? action.context ?? "dialog";
      let section = sections.at(-1);
      if (!section || section.label !== group) {
        section = { id: `action-group-${sections.length}`, label: group, items: [] };
        sections.push(section);
      }
      section.items.push(action);
    });
    return sections;
  }

  async refreshActionStates(owner, showGeneration) {
    if (this.owner !== owner || this.showGeneration !== showGeneration || !this.actionCommands) {
      return;
    }
    const generation = ++this.actionStateGeneration;
    try {
      const current = new Map(
        owner.getAvailableActions(this.context).map((action) => [action.command, action]),
      );
      const actions = this.actionCommands.map((command) => current.get(command)).filter(Boolean);
      await this.picker.update({ sections: this.sectionsForActions(actions) });
    } catch (error) {
      if (
        this.owner === owner &&
        this.showGeneration === showGeneration &&
        this.actionStateGeneration === generation
      ) {
        await this.picker.setStatus({
          type: "error",
          message: error?.message ?? String(error),
        });
      }
    }
  }

  getPicker() {
    if (this.picker) return this.picker;

    this.picker = this.createSelectList({
      className: "select-list-actions",
      internalActionPalette: true,
      items: [],
      commands: {
        "select-list:confirm-action-picker": {
          description: "Run the selected dialog action.",
          hiddenInCommandPalette: true,
          didDispatch: (event) => this.confirmAction(event.detail.item),
        },
      },
      actions: [
        {
          command: "select-list:confirm-action-picker",
          context: "item",
          disposition: "stay",
          primary: true,
        },
      ],
      getItemId: (action) => action.command,
      search: {
        getFilterText: (action) => `${action.name} ${action.description ?? ""}`,
      },
      renderItem: (action, { highlight }) => ({
        className: [
          action.enabled === false && "disabled",
          action.pending && "pending",
          action.tone === "danger" && "text-error",
        ].filter(Boolean),
        primary: highlight(action.name),
        secondary: action.pending
          ? "In progress…"
          : action.enabled === false
            ? action.disabledReason || action.description
            : action.description,
        trailing: (action.keystrokes ?? []).map((keystrokes) => ({
          text: humanizeKeystroke(keystrokes),
          className: "key-binding",
        })),
        didRender: (element) => {
          if (action.enabled === false) element.setAttribute("aria-disabled", "true");
          if (action.pending) element.setAttribute("aria-busy", "true");
        },
      }),
    });
    this.disposables.add(
      this.picker.onDidCancel(() => this.cancelOwner()),
      this.picker.getPanel().onDidChangeVisible((visible) => {
        if (!visible && this.picker.getPanel().flowTransition) {
          this.cancelPendingShow();
          this.disposeForwarders();
        }
      }),
    );
    return this.picker;
  }

  async confirmAction(action) {
    if (!action || !this.owner) return false;
    const owner = this.owner;
    const context = this.context;
    const availability = owner.getActionAvailability
      ? await owner.getActionAvailability(action.command, context)
      : {
          status: action.enabled === false ? "disabled" : "available",
          reason: action.disabledReason,
        };
    if (this.owner !== owner || this.context !== context) return false;
    if (availability.status !== "available") {
      await this.picker.setStatus({
        type: "warning",
        message:
          availability.status === "disabled" && availability.reason
            ? String(availability.reason)
            : availability.status === "pending"
              ? "This action is already in progress."
              : availability.status === "unavailable"
                ? "This action is no longer available."
                : "This action is unavailable.",
      });
      return false;
    }

    if (!this.workspace.popModal()) {
      this.picker.hide();
      owner.getPanel().show();
    }
    this.disposeForwarders();
    return owner.runAction(action.command, { source: "actions", context });
  }

  cancelOwner() {
    const owner = this.owner;
    this.cancelPendingShow();
    this.disposeForwarders();
    if (owner && !owner.isDestroyed?.()) owner.cancel("action-picker");
  }

  hide() {
    const wasActive = Boolean(this.pendingOwner || this.picker?.isVisible());
    this.cancelPendingShow();
    if (this.picker?.isVisible()) this.picker.hide();
    this.disposeForwarders();
    return wasActive;
  }

  isVisible() {
    return Boolean(this.picker?.isVisible());
  }

  release(owner) {
    if (this.owner !== owner && this.pendingOwner !== owner) return false;
    this.cancelPendingShow(owner);
    if (this.picker?.isVisible()) this.picker.hide();
    this.disposeForwarders();
    return true;
  }

  cancelPendingShow(owner = null) {
    if (!this.pendingOwner || (owner && this.pendingOwner !== owner)) return false;
    this.showGeneration++;
    this.pendingOwner = null;
    return true;
  }

  disposeForwarders({ clearPicker = true } = {}) {
    if (this.forwardersDisposable) {
      this.forwardersDisposable.dispose();
      this.forwardersDisposable = null;
    }
    this.owner?.setActionsExpanded?.(false);
    this.owner = null;
    this.context = null;
    this.actionCommands = null;
    this.actionStateGeneration++;
    if (clearPicker && this.picker && !this.picker.isDestroyed?.()) {
      void this.picker
        .update({ sections: [], query: "", infoMessage: null, status: null })
        .catch(() => {});
    }
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.showGeneration++;
    this.pendingOwner = null;
    this.disposeForwarders({ clearPicker: false });
    this.disposables.dispose();
    if (this.picker) {
      await this.picker.destroy();
      this.picker = null;
    }
  }
};
