"use strict";

const { CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const { createFocusTrap } = require("focus-trap");

const HOST_OPTIONS = new Set(["item", "crumb", "visible", "restoreFocus", "priority", "className"]);
const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, a[href], [tabindex], lumine-text-editor";

/**
 * @public
 * @status experimental
 *
 * Hosts a detached {@link InputDialog} model in a lazily-created modal panel.
 * The host owns visibility, focus, modal-flow state and session lifecycle; the
 * complete dialog model remains available through {@link #getModel}.
 */
class InputDialogHost {
  constructor(model, services, options = {}, { ownsModel = false, didDestroy = null } = {}) {
    validateHostOptions(options);
    this.model = model;
    this.services = services;
    this.options = { ...options };
    this.ownsModel = ownsModel;
    this.didDestroyCallback = didDestroy;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.panelDisposables = null;
    this.panel = null;
    this.focusTrap = null;
    this.destroyed = false;
    this.destroyPromise = null;
    this.hidingSelf = false;
    this.canceling = false;
    this.suspendedByFlow = false;
    this.panelLifecycleGeneration = 0;
    this.openerElement = null;
    this.lastQuery = "";
    this.openingQueryProvided = false;
    this.selectOpeningQuery = true;
    this.sourcePromise = null;
    this.pendingOpenerElement = null;

    model.attachHost(this);
    this.disposables.add(
      model.onDidDestroy(() => {
        void this.destroyFromModel();
      }),
      model.onDidRequestCancel(({ reason }) => {
        if (reason === "actions-toggle") this.services.workspace.popModal();
        else this.cancel(reason);
      }),
      model.onDidRequestActions(() => this.consumeUiAction(this.showActions())),
      model.onDidRequestRestoreQuery(() => this.restoreQuery()),
      model.onDidRequestDisposition(({ disposition }) => {
        if (disposition === "close") this.hide();
      }),
      model.onDidStartAction(() => this.pauseFocusTrap()),
      model.onDidFinishAction(() => this.resumeFocusTrap()),
    );
  }

  /**
   * @public
   * @status experimental
   *
   * Return the complete detached dialog model.
   * @returns {InputDialog}
   */
  getModel() {
    return this.model;
  }

  /**
   * @public
   * @status experimental
   *
   * Materialize and return the underlying modal Panel. Calling this method is
   * the first point at which the host registers UI with the workspace.
   * @returns {Panel}
   */
  getPanel() {
    this.assertAlive();
    if (this.panel) return this.panel;

    const panel = this.services.workspace.addModalPanel({
      item: this.options.item ?? this.model,
      visible: false,
      crumb: this.options.crumb,
      restoreFocus: this.options.restoreFocus,
      priority: this.options.priority,
      className: this.options.className,
    });
    this.panel = panel;
    this.panelDisposables = new CompositeDisposable(
      panel.onWillShow(() => this.willShowPanel()),
      panel.onWillHide(() => this.willHidePanel()),
      panel.onDidChangeVisible((visible) => this.didChangePanelVisible(visible)),
      panel.onDidEndModalFlow((reason) => this.didEndModalFlow(reason)),
      panel.onDidDestroy(() => {
        if (!this.destroyed) void this.destroyFromPanel();
      }),
    );
    this.installFocusPolicy();

    const modelElement = this.model.getElement();
    if (!panel.getElement().contains(modelElement)) {
      panel.destroy();
      throw new Error("A modal host item must contain its dialog model element.");
    }
    if (this.options.visible === true) {
      this.options.visible = false;
      this.pendingOpenerElement = document.activeElement;
      panel.show();
    }
    return panel;
  }

  /**
   * @public
   * @status experimental
   *
   * Show the modal host and begin a model session.
   * @param {Object} [options]
   * @param {String} [options.query] - Opening query; omitted to reset it.
   * @param {Boolean} [options.selectQuery=true] - Whether to select the opening query.
   * @param {String|Boolean} [options.crumb] - Modal-flow breadcrumb for this opening.
   * @returns {Promise} Resolves when the opening source load settles.
   */
  show(options = {}) {
    this.assertAlive();
    validateShowOptions(options);
    this.options.visible = false;
    this.suspendedByFlow = false;
    if (!this.isVisible()) this.pendingOpenerElement = document.activeElement;
    const panelOptions = {};
    this.openingQueryProvided = Object.prototype.hasOwnProperty.call(options, "query");
    this.selectOpeningQuery = options.selectQuery !== false;
    if (this.openingQueryProvided) {
      this.model.setQuery(options.query == null ? "" : String(options.query));
    }
    if (Object.prototype.hasOwnProperty.call(options, "crumb")) {
      panelOptions.crumb = options.crumb;
    }
    this.getPanel().show(Object.keys(panelOptions).length > 0 ? panelOptions : undefined);
    return this.sourcePromise ?? Promise.resolve();
  }

  /**
   * @public
   * @status experimental
   *
   * Hide the modal without emitting cancellation.
   */
  hide() {
    const releasedActionPicker = this.services.actionService?.release(this) ?? false;
    if (!this.isVisible()) {
      if (releasedActionPicker) this.finalizeSuspendedHide();
      return;
    }
    this.hidingSelf = true;
    try {
      this.panel.hide();
    } finally {
      this.hidingSelf = false;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Hide a visible host or show a hidden one.
   * @param {Object} [options] - Opening options passed to {@link #show}.
   * @returns {Promise|undefined} The opening source promise when shown.
   */
  toggle(options) {
    return this.isVisible() ? this.hide() : this.show(options);
  }

  /**
   * @public
   * @status experimental
   *
   * Dismiss the modal and emit a cancellation event.
   * @param {String} [reason="api"] - Machine-readable cancellation reason.
   */
  cancel(reason = "api") {
    if (this.canceling || this.destroyed) return;
    this.canceling = true;
    try {
      this.hide();
      this.finalizeSuspendedHide();
      this.emitter.emit("did-cancel", { host: this, model: this.model, reason });
    } finally {
      this.canceling = false;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether this host's modal panel is visible.
   * @returns {Boolean}
   */
  isVisible() {
    return Boolean(this.panel?.isVisible());
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether this host has been destroyed.
   * @returns {Boolean}
   */
  isDestroyed() {
    return this.destroyed;
  }

  /**
   * @public
   * @status experimental
   *
   * Focus the model's query editor.
   */
  focus() {
    this.assertAlive();
    this.model.getQueryEditor().getElement().focus();
  }

  /**
   * @public
   * @status experimental
   *
   * Restore and select the query remembered from the previous session.
   * @returns {Boolean} Whether a non-empty query was restored.
   */
  restoreQuery() {
    this.assertAlive();
    if (!this.lastQuery) return false;
    this.model.setQuery(this.lastQuery, { select: true });
    return true;
  }

  /**
   * @public
   * @status experimental
   *
   * Open the shared picker for actions available on the model.
   * @returns {Promise} Resolves to whether the action picker opened.
   */
  async showActions() {
    this.assertAlive();
    try {
      const context = this.model.getActionContext("actions");
      const actions = this.model.getAvailableActions(context);
      if (actions.length === 0) return false;
      const selected = this.model.getSelectedItem?.() ?? null;
      const info = selected != null ? (this.model.getFilterKey?.(selected) ?? null) : null;
      const opened = await this.services.actionService.show({
        owner: this,
        actions,
        context,
        infoMessage: info,
      });
      if (opened) this.model.setActionsExpanded(true);
      return opened;
    } catch (error) {
      if (!this.destroyed && error?.name !== "AbortError") {
        await this.model.setStatus({ type: "error", message: error?.message ?? String(error) });
      }
      throw error;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the host's visibility changes.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidChangeVisible(callback) {
    return this.emitter.on("did-change-visible", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when a fresh modal session opens.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidOpen(callback) {
    return this.emitter.on("did-open", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when a suspended modal-flow session resumes.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidResume(callback) {
    return this.emitter.on("did-resume", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when a modal session fully hides.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidHide(callback) {
    return this.emitter.on("did-hide", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the host is cancelled.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidCancel(callback) {
    return this.emitter.on("did-cancel", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the host is destroyed.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  getOpenerElement() {
    return this.openerElement;
  }

  getActionContext(source) {
    return this.model.getActionContext(source);
  }

  getAvailableActions(context) {
    return this.model.getAvailableActions(context);
  }

  getActionAvailability(command, context) {
    return this.model.getActionAvailability(command, context);
  }

  runAction(command, options) {
    return this.model.runAction(command, options);
  }

  onDidStartAction(callback) {
    return this.model.onDidStartAction(callback);
  }

  onDidFinishAction(callback) {
    return this.model.onDidFinishAction(callback);
  }

  setActionsExpanded(expanded) {
    this.model.setActionsExpanded(expanded);
  }

  /**
   * @public
   * @status experimental
   *
   * Destroy the host and its panel. A model created from options is destroyed
   * with it; a model passed to the factory remains alive.
   * @returns {Promise} Resolves when owned resources have been destroyed.
   */
  destroy() {
    return this.beginDestroy({ fromModel: false, fromPanel: false });
  }

  /** @private */
  destroyFromModel() {
    return this.beginDestroy({ fromModel: true, fromPanel: false });
  }

  /** @private */
  destroyFromPanel() {
    return this.beginDestroy({ fromModel: false, fromPanel: true });
  }

  beginDestroy({ fromModel, fromPanel }) {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = this.destroyNow({ fromModel, fromPanel });
    return this.destroyPromise;
  }

  async destroyNow({ fromModel, fromPanel }) {
    const failures = [];
    const attempt = (callback) => {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(() => this.services.actionService?.release(this));
    attempt(() => this.finalizeSession("host-destroyed"));
    attempt(() => this.focusTrap?.deactivate());
    attempt(() => this.disposables.dispose());
    attempt(() => this.panelDisposables?.dispose());
    this.panelDisposables = null;
    const panel = this.panel;
    this.panel = null;
    if (panel && !fromPanel && !panel.destroyed) attempt(() => panel.destroy());
    attempt(() => this.model?.detachHost(this));
    attempt(() => this.emitter.emit("did-destroy", { host: this, model: this.model }));
    attempt(() => this.emitter.dispose());
    attempt(() => this.didDestroyCallback?.(this));
    try {
      if (this.ownsModel && !fromModel && this.model && !this.model.isDestroyed()) {
        await this.model.destroy();
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to completely destroy the modal host.");
    }
  }

  didChangePanelVisible(visible) {
    const generation = ++this.panelLifecycleGeneration;
    if (visible) {
      this.didShowPanel(generation);
      return;
    }
    if (this.panel.destroyed) return;
    if (this.panel.flowTransition) {
      this.suspendedByFlow = true;
      this.model.suspendSource();
      this.model.didChangeHostVisible(false);
      this.emitter.emit("did-change-visible", { host: this, model: this.model, visible: false });
      return;
    }
    this.didHidePanel({ generation });
    if (!this.hidingSelf && this.isCurrentPanelLifecycle(generation, false)) this.cancel();
  }

  willShowPanel() {
    if (!this.suspendedByFlow) this.pendingOpenerElement = document.activeElement;
  }

  willHidePanel() {
    this.focusTrap?.deactivate();
  }

  didShowPanel(generation) {
    const resuming = this.suspendedByFlow;
    this.suspendedByFlow = false;
    if (!resuming) {
      this.openerElement = this.pendingOpenerElement ?? document.activeElement;
      this.pendingOpenerElement = null;
    }
    if (!resuming) this.sourcePromise = null;
    try {
      this.model.didChangeHostVisible(true);
      this.emitter.emit("did-change-visible", { host: this, model: this.model, visible: true });
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      if (!resuming) {
        this.model.resetForNewSession({ resetQuery: !this.openingQueryProvided });
      }
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      this.model.refreshItemActionsIndicator();
      if (this.selectOpeningQuery !== false) this.model.selectQuery();
      this.activateFocusTrap();
      this.focus();
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      this.sourcePromise = resuming ? this.model.resumeSource() : this.model.openSource();
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      this.emitter.emit(resuming ? "did-resume" : "did-open", {
        host: this,
        model: this.model,
      });
    } finally {
      this.openingQueryProvided = false;
      this.selectOpeningQuery = true;
    }
  }

  didHidePanel({ visibilityChanged = true, generation = this.panelLifecycleGeneration } = {}) {
    this.lastQuery = this.model.getQuery();
    this.model.cancelSource("dialog-hidden");
    this.model.didChangeHostVisible(false);
    if (visibilityChanged) {
      this.emitter.emit("did-change-visible", { host: this, model: this.model, visible: false });
    }
    if (!this.isCurrentPanelLifecycle(generation, false)) return;
    this.emitter.emit("did-hide", { host: this, model: this.model });
  }

  finalizeSession(reason) {
    if (!this.model) return;
    this.lastQuery = this.model.getQuery();
    this.model.cancelSource(reason);
    this.model.didChangeHostVisible(false);
  }

  finalizeSuspendedHide() {
    if (!this.suspendedByFlow || this.isVisible()) return false;
    this.suspendedByFlow = false;
    this.didHidePanel({ visibilityChanged: false });
    return true;
  }

  didEndModalFlow(reason) {
    if (!this.suspendedByFlow || this.destroyed) return;
    if (reason === "back") this.finalizeSuspendedHide();
    else this.cancel("modal-flow");
  }

  isCurrentPanelLifecycle(generation, visible) {
    return (
      !this.destroyed &&
      this.panelLifecycleGeneration === generation &&
      this.isVisible() === visible
    );
  }

  installFocusPolicy() {
    const element = this.panel.getElement();
    this.focusTrap = createFocusTrap(element, {
      fallbackFocus: element,
      initialFocus: this.model.getQueryEditor().getElement(),
      escapeDeactivates: false,
      delayInitialFocus: false,
      returnFocusOnDeactivate: false,
    });
    const didLoseFocus = (event) => this.didLoseFocus(event);
    const didMouseDown = (event) => this.didMouseDownOnElement(event);
    element.addEventListener("focusout", didLoseFocus);
    element.addEventListener("mousedown", didMouseDown);
    this.panelDisposables.add(
      {
        dispose() {
          element.removeEventListener("focusout", didLoseFocus);
          element.removeEventListener("mousedown", didMouseDown);
        },
      },
      { dispose: () => this.focusTrap?.deactivate() },
    );
  }

  activateFocusTrap() {
    this.focusTrap?.activate();
    if (this.model.isActionPending()) this.focusTrap?.pause();
  }

  pauseFocusTrap() {
    if (this.isVisible()) this.focusTrap?.pause();
  }

  resumeFocusTrap() {
    if (this.isVisible() && !this.model.isActionPending()) this.focusTrap?.unpause();
  }

  didLoseFocus(event) {
    const element = this.panel.getElement();
    const queryElement = this.model.getQueryEditor().getElement();
    if (element.contains(event.relatedTarget)) {
      if (queryElement.contains(event.relatedTarget)) return;
      if (this.isInteractiveTarget(event.relatedTarget)) return;
      queryElement.focus();
      return;
    }
    const generation = this.panelLifecycleGeneration;
    requestAnimationFrame(() => {
      if (!document.hasFocus() || !this.isCurrentPanelLifecycle(generation, true)) return;
      if (this.model.isActionPending()) return;
      this.cancel("focus-lost");
    });
  }

  didMouseDownOnElement(event) {
    const queryElement = this.model.getQueryEditor().getElement();
    if (queryElement.contains(event.target) || this.isInteractiveTarget(event.target)) return;
    event.preventDefault();
    queryElement.focus();
  }

  isInteractiveTarget(node) {
    if (!node?.closest) return false;
    const element = this.panel.getElement();
    const match = node.closest(INTERACTIVE_SELECTOR);
    return Boolean(match && match !== element && element.contains(match));
  }

  consumeUiAction(result) {
    if (!result || typeof result.then !== "function") return result;
    return result.catch(() => undefined);
  }

  assertAlive() {
    if (this.destroyed) throw new Error("The modal host has been destroyed.");
  }
}

function validateHostOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Modal host options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (!HOST_OPTIONS.has(key)) throw new TypeError(`Unknown modal host option '${key}'.`);
  }
  if (options.visible != null && typeof options.visible !== "boolean") {
    throw new TypeError("Modal host visible must be a boolean.");
  }
  if (options.restoreFocus != null && typeof options.restoreFocus !== "boolean") {
    throw new TypeError("Modal host restoreFocus must be a boolean.");
  }
}

function validateShowOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Modal host show options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (!["query", "selectQuery", "crumb"].includes(key)) {
      throw new TypeError(`Unknown modal host show option '${key}'.`);
    }
  }
}

module.exports = InputDialogHost;
