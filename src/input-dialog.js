"use strict";

const { Disposable, CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const etch = require("@lumine-code/etch");
const DialogActions = require("./dialog-actions");
const DialogSource = require("./dialog-source");
const InputDialogComponent = require("./input-dialog-component");
require("./input-dialog-element");
const $ = etch.dom;

// A status is coloured with the theme's existing text utilities rather than
// with colours of its own, so it matches every other severity in the editor.
const SEVERITY_CLASSES = {
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
};

/**
 * @public
 * @status experimental
 *
 * Detached query-dialog model with a mini editor and optional custom DOM content.
 *
 * InputDialog owns query state, messages, sources, commands and actions without
 * any list semantics. SelectList extends it with items, filtering, and
 * selection. The model creates its renderer only when {@link #getElement} is
 * first called and never inserts that element into the DOM. Use
 * {@link Workspace#addInputDialog} when the dialog needs a modal host.
 *
 * The dialog shows **one** message at a time, from three sources in
 * precedence order: `loadingMessage` (work in flight), then `status` (an
 * episodic overlay — a validation failure, a warning, a confirmation), then
 * `infoMessage` (the resting line: a prompt, a help text, a stat line). The
 * overlay never destroys the resting line, so clearing a status restores it
 * with nothing to save and put back.
 *
 * Custom DOM can be hosted through `headerElement` (above the query editor)
 * and `contentElement` (below the messages).
 *
 * The query is the dialog's own state. A modal host decides when a new session
 * resets it, preserves it across modal-flow steps, and restores a previous
 * session on request.
 */
class InputDialog {
  constructor(props, services) {
    this.props = { ...(props ?? {}) };
    this.services = services;
    this.emitter = new Emitter();
    this.statusTimer = null;
    this.destroyed = false;
    this.itemActionsAvailable = false;
    this.actionsExpanded = false;
    this.pendingActionCommands = new Set();
    this.dispatchedActionCommand = null;
    this.actionCommandsDisposable = null;
    this.host = null;
    this.hostVisible = false;
    this.dialogActions = new DialogActions({
      dispatch: (request) => this.dispatchAction(request),
      confirm: (request) => this.confirmDialogAction(request),
      getItemId: (item) => this.getActionItemId(item),
      resolveItemById: (id) => this.resolveActionItemById(id),
      hooks: {
        close: (payload) => this.requestDisposition("close", payload),
        stay: (payload) => this.requestDisposition("stay", payload),
        push: (payload) => this.requestDisposition("push", payload),
        recordRecent: ({ context }) => this.recordActionRecent(context),
      },
    });
    this.dialogActions.set(this.props.actions ?? []);
    this.dialogSource = new DialogSource({
      source: this.props.source ?? null,
      getQuery: () => this.getQuery(),
      getParsedQuery: () => this.getParsedQuery(),
      apply: (publication) => this.applySourcePublication(publication),
      setLoading: (loading) => this.didChangeSourceLoading(loading),
      setError: (error) => this.didFailSource(error),
    });
    this.disposables = new CompositeDisposable();
    this.materializedDisposables = null;
    this.queryEditorRegistration = null;
    this.queryEditor = this.services.textEditorFactory.build({ mini: true });
    this.disposables.add(this.services.textEditorFactory.maintainConfig(this.queryEditor));
    if (Object.prototype.hasOwnProperty.call(this.props, "query")) {
      this.queryEditor.setText(this.props.query == null ? "" : String(this.props.query));
    }
    if (this.props.placeholderText) {
      this.queryEditor.setPlaceholderText(this.props.placeholderText);
    }
    // TextEditor changes also include display resets, such as font metrics or
    // tab-width changes. Only edits to the query text invalidate its status,
    // selection and source, so observe completed buffer transactions directly.
    this.disposables.add(this.queryEditor.getBuffer().onDidChangeText(() => this.didChangeQuery()));
    this.initializeState();
    this.component = null;
    this.scheduleStatusExpiry();
    this.disposables.add(
      this.dialogActions.onDidStart((event) => {
        this.pendingActionCommands.add(event.command);
        this.updateActionPendingState();
        this.emitter.emit("did-start-action", event);
      }),
      this.dialogActions.onDidFinish((event) => {
        this.pendingActionCommands.delete(event.command);
        this.updateActionPendingState();
        this.emitter.emit("did-finish-action", event);
      }),
    );
  }

  /**
   * Subclass hook run before the first render to prepare instance state.
   * `this.props` is assigned; the DOM does not exist yet.
   * @private
   */
  initializeState() {}

  createComponent() {
    return new InputDialogComponent(this);
  }

  materialize() {
    if (this.component) return;
    this.component = this.createComponent();
    this.component.element.setModel(this);
    this.component.element.classList.add(...this.rootClasses());
    this.materializedDisposables = new CompositeDisposable(this.registerCommands());
    this.registerActionCommands(this.props.commands);
    if (this.component.refs.itemActionsIndicator) {
      this.materializedDisposables.add(
        this.services.tooltipManager.add(this.component.refs.itemActionsIndicator, {
          title: "Actions",
          keyBindingCommand: "select-list:actions",
          keyBindingTarget: this.queryEditor.getElement(),
        }),
      );
    }
    this.didInitializeElement();
  }

  didAttachElement() {
    if (!this.queryEditorRegistration) {
      this.queryEditorRegistration = this.services.textEditorRegistry.add(this.queryEditor, {
        role: "input",
      });
    }
  }

  didDetachElement() {
    this.queryEditorRegistration?.dispose();
    this.queryEditorRegistration = null;
  }

  didInitializeElement() {}

  /**
   * CSS classes applied to the root element. Subclasses override to replace
   * the default `input-dialog` class.
   * @private
   * @returns {string[]} Class names for the root element
   */
  rootClasses() {
    return ["input-dialog"];
  }

  /** @category DOM Access */

  /**
   * @public
   * @status experimental
   *
   * Return the root element rendered for this dialog.
   * @returns {HTMLElement}
   */
  getElement() {
    this.materialize();
    return this.component.element;
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether this dialog has been destroyed.
   * @returns {Boolean}
   * @category Lifecycle
   */
  isDestroyed() {
    return this.destroyed;
  }

  attachHost(host) {
    if (this.host && this.host !== host) {
      throw new Error("This dialog model already has a modal host.");
    }
    this.host = host;
    this.refreshItemActionsIndicator();
  }

  detachHost(host) {
    if (this.host !== host) return false;
    this.host = null;
    this.hostVisible = false;
    this.setActionsExpanded(false);
    this.refreshItemActionsIndicator();
    return true;
  }

  onDidRequestCancel(callback) {
    return this.emitter.on("did-request-cancel", callback);
  }

  onDidRequestActions(callback) {
    return this.emitter.on("did-request-actions", callback);
  }

  onDidRequestRestoreQuery(callback) {
    return this.emitter.on("did-request-restore-query", callback);
  }

  onDidRequestDisposition(callback) {
    return this.emitter.on("did-request-disposition", callback);
  }

  requestCancel(reason = "api") {
    this.emitter.emit("did-request-cancel", { dialog: this, reason });
  }

  requestActions() {
    this.emitter.emit("did-request-actions", { dialog: this });
  }

  requestRestoreQuery() {
    this.emitter.emit("did-request-restore-query", { dialog: this });
  }

  requestDisposition(disposition, payload) {
    this.emitter.emit("did-request-disposition", { dialog: this, disposition, payload });
  }

  didChangeHostVisible(visible) {
    this.hostVisible = visible;
    this.refreshItemActionsIndicator();
  }

  openSource() {
    return this.dialogSource.open();
  }

  cancelSource(reason) {
    return this.dialogSource.cancel(reason);
  }

  suspendSource() {
    return this.dialogSource.suspend();
  }

  resumeSource() {
    return this.dialogSource.resume();
  }

  /** @category Event Subscription */

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the query changes.
   * @param {Function} callback - The observer.
   * @param {Object} callback.event
   * @param {InputDialog} callback.event.dialog
   * @param {String} callback.event.query
   * @param {Object} callback.event.parsedQuery - Frozen {text, data} record.
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidChangeQuery(callback) {
    return this.emitter.on("did-change-query", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when confirmation has no primary action.
   * @param {Function} callback - The observer.
   * @param {Object} callback.event
   * @param {InputDialog} callback.event.dialog
   * @param {String} callback.event.query
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidConfirm(callback) {
    return this.emitter.on("did-confirm", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback during dialog destruction.
   * @param {Function} callback - The observer.
   * @returns {Disposable} Dispose to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Clears the query editor text.
   * @returns {void}
   * @category Query
   */
  reset() {
    this.queryEditor.setText("");
  }

  /** @private */
  resetForNewSession({ resetQuery = true } = {}) {
    if (resetQuery) this.reset();
  }

  /**
   * @public
   * @status experimental
   *
   * Destroys the dialog and cleans up resources.
   * @returns {Promise<void>}
   * @category Lifecycle
   */
  destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.destroyPromise = this.destroyNow();
    return this.destroyPromise;
  }

  async destroyNow() {
    const failures = [];
    const attempt = (callback) => {
      try {
        callback();
      } catch (error) {
        failures.push(error);
      }
    };
    try {
      if (this.host) await this.host.destroyFromModel();
    } catch (error) {
      failures.push(error);
    }
    attempt(() => this.clearStatusTimer());
    attempt(() => this.didDetachElement());
    attempt(() => this.materializedDisposables?.dispose());
    this.materializedDisposables = null;
    attempt(() => this.disposables.dispose());
    try {
      await this.dialogActions.destroy();
    } catch (error) {
      failures.push(error);
    }
    attempt(() => this.dialogSource.destroy());
    attempt(() => this.emitter.emit("did-destroy"));
    attempt(() => this.emitter.dispose());
    if (this.component) {
      attempt(() => this.component.element.setModel(null));
      try {
        await this.component.destroy();
      } catch (error) {
        failures.push(error);
      }
      this.component = null;
    }
    attempt(() => this.queryEditor.destroy());
    this.queryEditor = null;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to completely destroy the dialog model.");
    }
  }

  /** @category Asynchronous Sources */

  /**
   * @public
   * @status experimental
   *
   * Return the configured asynchronous source, or null.
   * @returns {Object|null}
   */
  getSource() {
    return this.props.source ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the asynchronous source and reload it when open.
   * @param {Object|null} source - Replacement source, or null to disable loading.
   * @param {String} source.mode - `snapshot` loads on opening/reload; `query` also reloads after query changes.
   * @param {Function} source.load - Receives a load context and may return a publication or a promise. InputDialog accepts option objects; SelectList also accepts item arrays. Undefined publishes no final result.
   * @param {Object} source.load.context - The query, parsedQuery, AbortSignal signal, and publish(value) callback. publish returns Promise<Boolean> indicating whether the progressive value was applied.
   * @param {Number} [source.debounceMs=100] - Delay for query-mode reloads in milliseconds.
   * @param {String} source.load.context.query - Raw query text.
   * @param {Object} source.load.context.parsedQuery - Frozen {text, data} query metadata.
   * @param {AbortSignal} source.load.context.signal - Aborted when the load is superseded, cancelled or destroyed.
   * @param {Function} source.load.context.publish - Publish progressive results; receives an option object or, for SelectList, an item array.
   * @param {*} [source.loadingMessage] - Loading message content; defaults to Loading….
   * @returns {Promise<void>}
   */
  setSource(source) {
    const previousSource = this.props.source;
    this.props.source = source;
    try {
      return this.dialogSource.setSource(source);
    } catch (error) {
      this.props.source = previousSource;
      throw error;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Reload the configured source immediately.
   * @returns {Promise<void>} Resolves after loading settles, including for a detached model. Loader failures appear as status messages.
   */
  reload() {
    return this.dialogSource.reload();
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether source work or its debounce is pending.
   * @returns {Boolean}
   */
  isLoading() {
    return this.dialogSource.isLoading();
  }

  applySourcePublication(publication) {
    if (Array.isArray(publication)) {
      if (typeof this.setItems !== "function") {
        throw new TypeError("An InputDialog source cannot publish an item array.");
      }
      return this.setItems(publication);
    }
    if (publication == null || typeof publication !== "object") {
      throw new TypeError("A dialog source publication must be an options object or item array.");
    }
    return this.update(publication);
  }

  didChangeSourceLoading(loading) {
    if (loading) {
      this.sourceOwnsLoadingState = true;
      return this.setLoadingState({
        message: this.props.source?.loadingMessage ?? "Loading…",
      });
    }
    if (!this.sourceOwnsLoadingState) return;
    this.sourceOwnsLoadingState = false;
    return this.clearLoadingState();
  }

  didFailSource(error) {
    return this.setStatus({ type: "error", message: error?.message ?? String(error) });
  }

  registerCommands() {
    return this.services.commandRegistry.add(this.getElement(), this.commandsForElement());
  }

  registerActionCommands(commands) {
    const listeners = this.prepareActionCommandListeners(commands);
    const nextDisposable =
      Object.keys(listeners).length > 0
        ? this.services.commandRegistry.add(this.getElement(), listeners)
        : null;
    const previousDisposable = this.actionCommandsDisposable;
    if (previousDisposable) {
      this.disposables.remove(previousDisposable);
      previousDisposable.dispose();
    }
    this.actionCommandsDisposable = nextDisposable;
    if (nextDisposable) this.disposables.add(nextDisposable);
  }

  prepareActionCommandListeners(commands) {
    commands = this.commandsForRegistration(commands);
    if (commands == null) return {};
    if (typeof commands !== "object" || Array.isArray(commands)) {
      throw new TypeError("Dialog commands must be a command-keyed object.");
    }
    const listeners = {};
    for (const [command, listener] of Object.entries(commands)) {
      const descriptor = typeof listener === "function" ? {} : { ...listener };
      const didDispatch = typeof listener === "function" ? listener : descriptor.didDispatch;
      if (typeof didDispatch !== "function") {
        throw new TypeError(`Dialog command '${command}' must have a didDispatch callback.`);
      }
      delete descriptor.didDispatch;
      listeners[command] = {
        ...descriptor,
        didDispatch: (event) => {
          event.stopPropagation();
          if (this.dispatchedActionCommand === command || !this.dialogActions.has(command)) {
            return didDispatch(event);
          }
          return this.consumeUiAction(this.runAction(command, { source: "command" }));
        },
      };
    }
    return listeners;
  }

  commandsForRegistration(commands) {
    return commands;
  }

  getActionContext(source = "api") {
    return {
      dialog: this,
      item: null,
      itemId: null,
      query: this.getQuery(),
      parsedQuery: this.getParsedQuery(),
      opener: this.host?.getOpenerElement() ?? null,
      source,
    };
  }

  getActionItemId(item) {
    if (item !== null && typeof item === "object") return item.id;
    return item;
  }

  resolveActionItemById() {
    return null;
  }

  recordActionRecent() {}

  /** @category Actions */

  /**
   * @public
   * @status experimental
   *
   * Return the complete declared action catalogue.
   * @returns {Array<Object>}
   */
  getActions() {
    return this.dialogActions.getAll();
  }

  actionsForCatalog(actions) {
    return actions;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the action catalogue.
   * @param {Array|Object|null} actions - Descriptors, [command, descriptor] pairs, or a command-keyed map; null clears the catalogue.
   * @returns {InputDialog}
   */
  setActions(actions) {
    this.dialogActions.set(this.actionsForCatalog(actions));
    this.props.actions = actions;
    this.refreshItemActionsIndicator();
    return this;
  }

  /**
   * @public
   * @status experimental
   *
   * Add an action and return a Disposable that removes it.
   * @param {Array|Object} action - One descriptor, an array of descriptors/pairs, or a command-keyed map.
   * @param {String} action.command - Command name when passing one descriptor.
   * @param {String} action.context - item or dialog; item actions require a current item.
   * @param {String} action.disposition - close, stay or push after successful execution.
   * @param {String} [action.dispatch="local"] - Dispatch on local, workspace or opener.
   * @param {Boolean|Function} [action.when=true] - Synchronous predicate controlling applicability.
   * @param {Boolean|Function} [action.enabled=true] - Synchronous predicate controlling execution.
   * @param {String|Function} [action.disabledReason] - Reason shown for a disabled action.
   * @param {Boolean|Function} [action.primary=false] - Make this the sole primary action for the current context.
   * @param {Boolean|Function} [action.recordsRecent=false] - Record the current item after successful execution.
   * @param {Boolean|Object|Function} [action.confirm] - Optional confirmation options, or a function receiving the context and AbortSignal.
   * @param {String} [action.group] - Group actions in declaration order.
   * @param {Number} [action.order=0] - Sort within the group.
   * @param {String} [action.tone="normal"] - normal or danger.
   * @returns {Disposable}
   */
  addAction(action) {
    const disposable = this.dialogActions.add(action);
    this.refreshItemActionsIndicator();
    return new Disposable(() => {
      disposable.dispose();
      this.refreshItemActionsIndicator();
    });
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether an action applies to the current context.
   * @param {Object} [context] - An action context; defaults to the current dialog context.
   * @param {InputDialog} [context.dialog] - The dialog model.
   * @param {*} [context.item] - The selected item, or null for an input dialog.
   * @param {*} [context.itemId] - The selected item identity, if any.
   * @param {String} [context.query] - Raw query text.
   * @param {Object} [context.parsedQuery] - Parsed {text, data} query.
   * @param {Element|null} [context.opener] - The element that opened the modal host.
   * @param {String} [context.source] - The action invocation source.
   * @param {Array<*>} [context.items] - Source items supplied by SelectList.
   * @returns {Boolean}
   */
  hasAvailableActions(context = this.getActionContext()) {
    return this.dialogActions.hasAvailable(context);
  }

  /**
   * @public
   * @status experimental
   *
   * Return evaluated actions for the current context.
   * @param {Object} [context] - An action context; defaults to the current dialog context.
   * @param {InputDialog} [context.dialog] - The dialog model.
   * @param {*} [context.item] - The selected item, or null for an input dialog.
   * @param {*} [context.itemId] - The selected item identity, if any.
   * @param {String} [context.query] - Raw query text.
   * @param {Object} [context.parsedQuery] - Parsed {text, data} query.
   * @param {Element|null} [context.opener] - The element that opened the modal host.
   * @param {String} [context.source] - The action invocation source.
   * @param {Array<*>} [context.items] - Source items supplied by SelectList.
   * @returns {Array<Object>}
   */
  getAvailableActions(context = this.getActionContext()) {
    return this.dialogActions
      .getAvailable(context)
      .map((action) => this.describeDialogAction(action, context));
  }

  getActionAvailability(command, context = this.getActionContext()) {
    return this.dialogActions.getAvailability(command, context);
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether any action, or one named action, is currently running.
   * @param {String} [command] - Check one action command, or omit to check all actions.
   * @returns {Boolean}
   */
  isActionPending(command) {
    return this.dialogActions.isPending(command);
  }

  describeDialogAction(action, context) {
    let target = this.getElement();
    if (action.dispatch === "workspace")
      target = this.host?.window.getElement() ?? this.services.workspace.getElement();
    if (action.dispatch === "opener") target = context.opener ?? this.getElement();
    const bindingTarget = this.queryEditor.getElement();
    const descriptor = this.services.commandRegistry.getCommandPresentation(action.command, {
      target,
      bindingTarget,
    });
    const commandKeystrokes = Object.freeze([...(descriptor?.keystrokes ?? [])]);
    const keystrokes = [];
    const seenKeystrokes = new Set();
    const bindingCommands = action.primary ? ["core:confirm", action.command] : [action.command];
    for (const command of bindingCommands) {
      const presentation = this.services.commandRegistry.getCommandPresentation(command, {
        target: command === "core:confirm" ? bindingTarget : target,
        bindingTarget,
      });
      for (const keystroke of presentation?.keystrokes ?? []) {
        if (seenKeystrokes.has(keystroke)) continue;
        seenKeystrokes.add(keystroke);
        keystrokes.push(keystroke);
      }
    }
    return Object.freeze({
      ...action,
      name: (descriptor?.displayName ?? action.command).replace(/^[^:]+:\s*/, ""),
      description: descriptor?.description,
      commandKeystrokes,
      keystrokes,
    });
  }

  async dispatchAction({ action, context, signal }) {
    let target = this.getElement();
    if (action.dispatch === "workspace")
      target = this.host?.window.getElement() ?? this.services.workspace.getElement();
    if (action.dispatch === "opener") target = context.opener ?? this.getElement();

    const previousDispatchedActionCommand = this.dispatchedActionCommand;
    this.dispatchedActionCommand = action.command;
    let result;
    try {
      result = this.services.commandRegistry.dispatch(target, action.command, {
        ...context,
        signal,
      });
    } finally {
      this.dispatchedActionCommand = previousDispatchedActionCommand;
    }
    if (!result) throw new Error(`Dialog action command '${action.command}' is not registered.`);
    return await result;
  }

  async confirmDialogAction({ confirmation, context, signal }) {
    const options =
      typeof confirmation === "function"
        ? await confirmation(context, signal)
        : confirmation === true
          ? {}
          : confirmation;
    if (signal.aborted || this.destroyed) return false;
    const message = options?.message ?? "Perform this action?";
    const confirmText = options?.confirmText ?? "Confirm";
    const cancelText = options?.cancelText ?? "Cancel";
    const response = await (this.host?.window ?? this.services.applicationDelegate).confirm({
      message,
      detail: options?.detail,
      buttons: [confirmText, cancelText],
    });
    if (signal.aborted || this.destroyed) return false;
    return response === 0;
  }

  /**
   * @public
   * @status experimental
   *
   * Run a declared action through the shared action runner.
   * @param {String} command - A declared action command.
   * @param {Object} [options] - Invocation options.
   * @param {String} [options.source="api"] - How the action was requested.
   * @param {Object|null} [options.context=null] - Override the current action context.
   * @returns {Promise<Object>} An action completion record with command, action, context, signal and status; optional reason/value/error describe the outcome. Unknown commands throw synchronously; action failures reject.
   */
  runAction(command, { source = "api", context = null } = {}) {
    return this.dialogActions
      .run(command, context ?? this.getActionContext(source))
      .then((result) => {
        if (this.destroyed) return result;
        if (result.status === "disabled") {
          this.setStatus({
            type: "warning",
            message: result.reason ? String(result.reason) : "This action is unavailable.",
          });
        } else if (result.status === "unavailable") {
          this.setStatus({
            type: "warning",
            message: "This action is no longer available.",
          });
        }
        return result;
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          this.setStatus({ type: "error", message: error?.message ?? String(error) });
        }
        throw error;
      });
  }

  setActionsExpanded(expanded) {
    this.actionsExpanded = Boolean(expanded);
    this.component?.refs?.itemActionsIndicator?.setAttribute(
      "aria-expanded",
      String(this.actionsExpanded),
    );
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when an action starts.
   * @param {Function} callback - The observer.
   * @param {Object} callback.event
   * @param {String} callback.event.command
   * @param {Object} callback.event.action
   * @param {Object} callback.event.context
   * @param {AbortSignal} callback.event.signal
   * @returns {Disposable} Dispose to unsubscribe.
   * @category Event Subscription
   */
  onDidStartAction(callback) {
    return this.emitter.on("did-start-action", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when an action finishes.
   * @param {Function} callback - The observer.
   * @param {Object} callback.event
   * @param {String} callback.event.command
   * @param {Object} callback.event.action
   * @param {Object} callback.event.context
   * @param {AbortSignal} callback.event.signal
   * @param {String} callback.event.status - success, disabled, unavailable, cancelled, aborted, or error.
   * @param {*} [callback.event.reason]
   * @param {*} [callback.event.value] - The dispatched command result.
   * @param {*} [callback.event.error]
   * @returns {Disposable} Dispose to unsubscribe.
   * @category Event Subscription
   */
  onDidFinishAction(callback) {
    return this.emitter.on("did-finish-action", callback);
  }

  consumeUiAction(result) {
    if (!result || typeof result.then !== "function") return result;
    return result.catch(() => undefined);
  }

  updateActionPendingState() {
    if (this.destroyed || !this.component) return;
    const pending = this.pendingActionCommands.size > 0;
    if (pending) this.component.element.setAttribute("aria-busy", "true");
    else this.component.element.removeAttribute("aria-busy");
    void this.component.update().catch(() => {});
  }

  /**
   * Returns the command bindings registered on the root element.
   * Subclasses extend the returned object with additional commands.
   * @returns {Object} Command name to handler map
   * @private
   */
  commandsForElement() {
    return {
      "core:confirm": (event) => {
        const result = this.consumeUiAction(this.confirm());
        event.stopPropagation();
        return result;
      },
      "core:cancel": (event) => {
        if (!this.host) return;
        this.requestCancel("command");
        event.stopPropagation();
      },
      "select-list:actions": (event) => {
        if (!this.host) return;
        if (this.props.internalActionPalette) {
          // Shift+F10 toggles: pressed in the actions list itself, it goes back to
          // the dialog it belongs to.
          this.requestCancel("actions-toggle");
        } else {
          this.requestActions();
        }
        event.stopPropagation();
      },
      "select-list:restore-query": (event) => {
        if (!this.host) return;
        this.requestRestoreQuery();
        event.stopPropagation();
      },
    };
  }

  /**
   * @public
   * @status experimental
   *
   * Confirms the dialog with the current query through its primary action, or
   * emits `onDidConfirm` when no primary action is declared.
   * @returns {Promise<Object>|undefined} The primary action completion promise, or undefined after emitting onDidConfirm.
   */
  confirm() {
    const primary = this.dialogActions.getPrimary(this.getActionContext("primary"));
    if (primary) return this.runAction(primary.command, { source: "primary" });
    const query = this.getQuery();
    this.emitter.emit("did-confirm", { dialog: this, query });
  }

  /**
   * @public
   * @status experimental
   *
   * Update one or more documented dialog options.
   * @param {Object} [props] - Partial dialog options. SelectList also accepts the list options described by {@link Workspace#addSelectList}.
   * @param {*} [props.query] - Replace the query text.
   * @param {Boolean} [props.selectQuery] - Select or clear the query selection.
   * @param {Object|null} [props.status] - Status as accepted by setStatus.
   * @param {*} [props.infoMessage] - Resting message content.
   * @param {*} [props.loadingMessage] - Loading message content.
   * @param {*} [props.loadingBadge] - Loading badge content.
   * @param {String} [props.placeholderText] - Query editor placeholder.
   * @param {HTMLElement|null} [props.headerElement] - Caller-owned header content.
   * @param {HTMLElement|null} [props.contentElement] - Caller-owned body content.
   * @param {Array|Object|null} [props.actions] - Action catalogue as accepted by setActions.
   * @param {Object|null} [props.commands] - Command-keyed functions or descriptors with a didDispatch function.
   * @param {Object|null} [props.source] - Asynchronous source as accepted by setSource.
   * @returns {Promise<void>} Resolves after the renderer update. Source loading triggered by this update settles independently.
   * @category Configuration
   */
  update(props = {}) {
    this.validateUpdateProps(props);
    this.updateProps(props);
    this.refreshItemActionsIndicator();
    return this.updateComponent();
  }

  updateComponent() {
    return this.component ? this.component.update() : Promise.resolve();
  }

  validateUpdateProps(props) {
    if (!props || typeof props !== "object" || Array.isArray(props)) {
      throw new TypeError("Dialog updates must be objects.");
    }
    if ("actions" in props) {
      this.dialogActions.validate(this.actionsForCatalog(props.actions ?? []));
    }
    if ("commands" in props) this.prepareActionCommandListeners(props.commands);
    if ("source" in props) this.dialogSource.validate(props.source ?? null);
  }

  /** @category Messages */

  /**
   * @public
   * @status experimental
   *
   * Return the current episodic status.
   * @returns {Object|null}
   */
  getStatus() {
    return this.props.status ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the episodic status.
   * @param {Object|null} status - Episodic status, or null to clear it.
   * @param {String} [status.type="info"] - `info`, `warning`, or `error`.
   * @param {*} status.message - Renderable message content.
   * @param {Number} [status.duration] - Positive milliseconds after which to clear this status.
   * @param {Boolean} [status.sticky=false] - Preserve the status when the query changes.
   * @returns {Promise<void>}
   */
  setStatus(status) {
    return this.update({ status });
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the episodic status.
   * @returns {Promise<void>}
   */
  clearStatus() {
    return this.setStatus(null);
  }

  /**
   * @public
   * @status experimental
   *
   * Return the resting information message.
   * @returns {*}
   */
  getInfoMessage() {
    return this.props.infoMessage ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the resting information message.
   * @param {*} infoMessage - Resting message content; null clears it.
   * @returns {Promise<void>}
   */
  setInfoMessage(infoMessage) {
    return this.update({ infoMessage });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the current loading message and badge.
   * @returns {Object|null}
   */
  getLoadingState() {
    if (!this.props.loadingMessage) return null;
    return { message: this.props.loadingMessage, badge: this.props.loadingBadge ?? null };
  }

  /**
   * @public
   * @status experimental
   *
   * Set the current loading message and badge.
   * @param {Object|null} loading - Loading presentation; null clears it.
   * @param {*} [loading.message] - Renderable loading message.
   * @param {*} [loading.badge] - Optional badge content.
   * @returns {Promise<void>}
   */
  setLoadingState(loading) {
    return this.update({
      loadingMessage: loading?.message ?? null,
      loadingBadge: loading?.badge ?? null,
    });
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the current loading state.
   * @returns {Promise<void>}
   */
  clearLoadingState() {
    return this.setLoadingState(null);
  }

  /** @category Query */

  /**
   * @public
   * @status experimental
   *
   * Return the query editor placeholder.
   * @returns {String}
   */
  getPlaceholderText() {
    return this.props.placeholderText ?? "";
  }

  /**
   * @public
   * @status experimental
   *
   * Set the query editor placeholder.
   * @param {String} placeholderText - Placeholder shown in the mini query editor.
   * @returns {Promise<void>}
   */
  setPlaceholderText(placeholderText) {
    return this.update({ placeholderText });
  }

  /** @category Custom Content */

  /**
   * @public
   * @status experimental
   *
   * Return the caller-owned header element.
   * @returns {HTMLElement|null}
   */
  getHeaderElement() {
    return this.props.headerElement ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the caller-owned header element.
   * @param {HTMLElement|null} headerElement - Caller-owned DOM content, or null to remove it.
   * @returns {Promise<void>}
   */
  setHeaderElement(headerElement) {
    return this.update({ headerElement });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the caller-owned content element.
   * @returns {HTMLElement|null}
   */
  getContentElement() {
    return this.props.contentElement ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the caller-owned content element.
   * @param {HTMLElement|null} contentElement - Caller-owned DOM content, or null to remove it.
   * @returns {Promise<void>}
   */
  setContentElement(contentElement) {
    return this.update({ contentElement });
  }

  /**
   * Applies prop changes shared by every dialog. Subclasses override to
   * handle their own props and call `super.updateProps(props)`.
   * @param {Object} props - The props to apply
   * @private
   */
  updateProps(props) {
    if ("query" in props) {
      this.queryEditor.setText(props.query == null ? "" : String(props.query));
      // setText triggers didChangeQuery, so derived state refreshes itself
    }

    if ("selectQuery" in props) {
      if (props.selectQuery) {
        this.queryEditor.selectAll();
      } else {
        this.queryEditor.clearSelections();
      }
    }

    if ("status" in props) {
      this.props.status = props.status || null;
      this.scheduleStatusExpiry();
    }

    if ("infoMessage" in props) {
      this.props.infoMessage = props.infoMessage;
    }

    if ("loadingMessage" in props) {
      this.props.loadingMessage = props.loadingMessage;
    }

    if ("loadingBadge" in props) {
      this.props.loadingBadge = props.loadingBadge;
    }

    if ("contentElement" in props) {
      this.props.contentElement = props.contentElement;
    }

    if ("headerElement" in props) {
      this.props.headerElement = props.headerElement;
    }

    if ("placeholderText" in props) {
      this.props.placeholderText = props.placeholderText;
      this.queryEditor.setPlaceholderText(props.placeholderText || "");
    }

    if ("actions" in props) {
      this.setActions(props.actions ?? []);
    }

    if ("commands" in props) {
      this.props.commands = props.commands;
      if (this.component) this.registerActionCommands(props.commands);
    }

    if ("source" in props) {
      this.setSource(props.source ?? null);
    }
  }

  /**
   * Cancels a pending status expiry, if any.
   * @private
   */
  clearStatusTimer() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /**
   * (Re)arms the expiry of the current status. A status with a `duration`
   * clears itself after that many milliseconds; anything that replaces the
   * status — including clearing it — cancels the pending expiry first, so a
   * timer from a superseded message can never wipe a newer one.
   * @private
   */
  scheduleStatusExpiry() {
    this.clearStatusTimer();
    const status = this.props.status;
    if (!status || !(status.duration > 0)) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      // The timer outlives a dialog the user closed and destroyed; updating a
      // destroyed etch component throws.
      if (this.destroyed || this.props.status !== status) return;
      this.update({ status: null });
    }, status.duration);
  }

  /**
   * Whether a message is occupying the line above the body. The list's empty
   * message stands down while one is: a failed load that also reported "no
   * results" would be stating the same fact twice.
   * @returns {boolean} True when a loading or status message is showing
   * @private
   */
  hasMessage() {
    return Boolean(this.props.loadingMessage || this.props.status);
  }

  render() {
    return $(
      "lumine-input-dialog",
      {},
      this.renderHeader(),
      this.renderQueryRow(),
      this.renderMessageLine(),
      this.renderBody(),
      this.renderContent(),
    );
  }

  renderHeader() {
    if (this.props.headerElement) {
      return $(ContentView, { element: this.props.headerElement });
    } else {
      return "";
    }
  }

  /**
   * Subclass hook rendered between the messages and the custom content.
   * SelectList renders its items here.
   * @private
   */
  renderBody() {
    return "";
  }

  renderContent() {
    if (this.props.contentElement) {
      return $(ContentView, { element: this.props.contentElement });
    } else {
      return "";
    }
  }

  renderQueryRow() {
    const actionPending = this.pendingActionCommands.size > 0;
    return $.div(
      {
        ref: "queryRow",
        className: `query-row${this.itemActionsAvailable ? " has-item-actions" : ""}`,
      },
      $(ContentView, { element: this.queryEditor.getElement() }),
      this.props.internalActionPalette
        ? ""
        : $.button(
            {
              ref: "itemActionsIndicator",
              className: `item-actions-indicator${
                actionPending ? " is-pending" : " icon icon-ellipsis"
              }`,
              type: "button",
              tabIndex: -1,
              hidden: !this.itemActionsAvailable,
              attributes: {
                "aria-label": actionPending ? "Action in progress" : "Actions",
                "aria-haspopup": "listbox",
                "aria-expanded": String(this.actionsExpanded),
                "aria-busy": String(actionPending),
              },
              on: {
                mousedown: (event) => {
                  // The button opens another modal step immediately. Keep the
                  // query editor focused until that transition starts, rather
                  // than briefly moving focus (and the caret) into the button.
                  event.preventDefault();
                  event.stopPropagation();
                },
                click: (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  this.requestActions();
                },
              },
            },
            actionPending
              ? $.span({ className: "action-pending-spinner loading-spinner-tiny" })
              : "",
          ),
    );
  }

  /**
   * Shows the query-row affordance exactly while this visible dialog offers
   * at least one applicable declared action. This is an
   * imperative toggle rather than a component update: moving through a list
   * already re-renders only the two affected rows, and the indicator should
   * not turn that into a full list render.
   * @private
   */
  refreshItemActionsIndicator() {
    if (!this.component?.refs?.itemActionsIndicator) return;
    const available = Boolean(this.host) && this.hostVisible && this.hasAvailableActions();
    this.itemActionsAvailable = available;
    this.component.refs.itemActionsIndicator.hidden = !available;
    this.component.refs.queryRow.classList.toggle("has-item-actions", available);
  }

  /**
   * Renders the single message line above the body. Exactly one of the three
   * sources wins, in precedence order: loading, then status, then the resting
   * info line. Stacking them was how a stale stat line ended up under a fresh
   * loading message, and how a failure and an empty result got reported as two
   * separate problems.
   * @returns {Object|String} The message element, or "" when there is nothing
   *   to say
   * @private
   */
  renderMessageLine() {
    if (this.props.loadingMessage) {
      return $.div(
        { className: "message-line loading" },
        // The spinner is the loading indicator, not an option: a message that
        // says work is in flight while sitting perfectly still is the one
        // thing it must not look like.
        $.span({ className: "loading-spinner-tiny" }),
        $.div({ ref: "loadingMessage", className: "loading-message" }, this.props.loadingMessage),
        this.props.loadingBadge
          ? $.span({ ref: "loadingBadge", className: "badge" }, this.props.loadingBadge)
          : "",
      );
    }

    if (this.props.status) {
      const { type = "info", message } = this.props.status;
      // The theme's own text utilities, so a status is coloured by whatever
      // palette is loaded rather than by a second set of rules here.
      const severity = SEVERITY_CLASSES[type] ?? SEVERITY_CLASSES.info;
      return $.div(
        {
          ref: "statusMessage",
          className: `message-line status-message ${severity}`,
          role: type === "error" ? "alert" : "status",
        },
        message,
      );
    }

    if (this.props.infoMessage) {
      return $.div(
        { ref: "infoMessage", className: "message-line info-message" },
        this.props.infoMessage,
      );
    }

    return "";
  }

  /** @category Query */

  /**
   * @public
   * @status experimental
   *
   * Return the raw query editor text.
   * @returns {String}
   */
  getQuery() {
    return this.queryEditor.getText();
  }

  /**
   * @public
   * @status experimental
   *
   * Set the query text and optionally select it.
   * @param {*} query - Query text, converted to a string; null clears it.
   * @param {Object} [options] - Selection options.
   * @param {Boolean} [options.select=false] - Select the complete query after setting it.
   * @returns {Promise<void>}
   */
  setQuery(query, { select = false } = {}) {
    return this.update({ query, selectQuery: select });
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the query text.
   * @returns {Promise<void>}
   */
  clearQuery() {
    return this.setQuery("");
  }

  /**
   * @public
   * @status experimental
   *
   * Select the complete query.
   * @returns {void}
   */
  selectQuery() {
    this.queryEditor.selectAll();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the full TextEditor model used for the query.
   * @returns {TextEditor}
   */
  getQueryEditor() {
    return this.queryEditor;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the parsed query text and metadata.
   * @returns {Object} A frozen {text, data} record; InputDialog uses the raw query and null data.
   */
  getParsedQuery() {
    return Object.freeze({ text: this.getQuery(), data: null });
  }

  /**
   * @public
   * @status experimental
   *
   * Use the active editor's single-line selection as the query.
   * @returns {Boolean}
   */
  setQueryFromSelection() {
    const editor =
      this.host?.window.getEditorContainer().getActiveTextEditor() ??
      this.services.workspace.getActiveTextEditor();
    if (!editor) return false;
    const text = editor.getSelectedText();
    if (!text || /\n/.test(text)) return false;
    this.queryEditor.setText(text);
    this.queryEditor.selectAll();
    return true;
  }

  didChangeQuery() {
    // A status answers the query it was raised for. Leaving it up under the
    // next one is how "Enter a value." ends up sitting below a filled field —
    // every dialog that got this right was clearing it by hand. A status the
    // caller declares `sticky` (a background failure, not a reply to input)
    // stays.
    if (this.props.status && !this.props.status.sticky) {
      this.clearStatusTimer();
      this.props.status = null;
      void this.updateComponent();
    }
    this.emitter.emit("did-change-query", {
      dialog: this,
      query: this.getQuery(),
      parsedQuery: this.getParsedQuery(),
    });
    this.dialogSource.queryChanged();
    this.refreshItemActionsIndicator();
  }
}

/**
 * Etch component that adopts a caller-owned DOM element so raw DOM content can
 * participate in the etch tree. Used for the `contentElement` prop.
 * @private
 */
class ContentView {
  constructor(props) {
    this.element = props.element;
  }

  update(props) {
    if (props.element !== this.element) {
      if (this.element.parentNode) {
        this.element.parentNode.replaceChild(props.element, this.element);
      }
      this.element = props.element;
    }
  }

  destroy() {
    this.element.remove();
  }
}

module.exports = InputDialog;
