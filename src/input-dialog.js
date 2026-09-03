"use strict";

const { Disposable, CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const etch = require("@lumine-code/etch");
const TextEditor = require("./text-editor");
const DialogActions = require("./dialog-actions");
const DialogSource = require("./dialog-source");
const InputDialogComponent = require("./input-dialog-component");
const $ = etch.dom;

// A status is coloured with the theme's existing text utilities rather than
// with colours of its own, so it matches every other severity in the editor.
const SEVERITY_CLASSES = {
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
};

// Elements that should be allowed to receive focus and clicks inside the
// dialog without the focus policy pulling focus back to the query editor.
const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, a[href], [tabindex], lumine-text-editor";

/**
 * @public
 * @status experimental
 *
 * Modal panel with a mini query editor and optional custom DOM content.
 *
 * InputDialog owns the behaviors every query-driven modal needs — panel
 * lifecycle, focus and blur handling, `core:confirm`/`core:cancel` commands,
 * and the message line — without any list semantics. SelectList extends it
 * with items, filtering, and selection. Use it directly for dialogs that are
 * not lists (prompts, save dialogs, forms).
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
 * The query is the dialog's own state, not the caller's: it is cleared on
 * every fresh show, kept across a modal-flow round trip, remembered when the
 * dialog closes, and put back on demand by `select-list:restore-query` (F11).
 * A dialog therefore never needs to call `reset()` before `show()`.
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
    // The query the dialog was last closed with, and whether the dialog is
    // coming back from a flow step rather than being opened afresh. See
    // {@link #didShowPanel}.
    this.lastQuery = "";
    this.suspendedByFlow = false;
    this.panelLifecycleGeneration = 0;
    this.openerElement = null;
    this.dispatchedActionCommand = null;
    this.actionCommandsDisposable = null;
    this.dialogActions = new DialogActions({
      dispatch: (request) => this.dispatchAction(request),
      confirm: (request) => this.confirmDialogAction(request),
      getItemId: (item) => this.getActionItemId(item),
      resolveItemById: (id) => this.resolveActionItemById(id),
      hooks: {
        close: () => this.hide(),
        stay: () => {},
        push: () => {},
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
    this.initializeState();
    this.component = this.createComponent();
    this.element = this.component.element;
    this.element.getModel = () => this;
    if (Object.prototype.hasOwnProperty.call(this.props, "query")) {
      this.component.refs.queryEditor.setText(
        this.props.query == null ? "" : String(this.props.query),
      );
    }
    this.disposables.add(
      this.services.textEditorRegistry.add(this.component.refs.queryEditor, { role: "fragment" }),
      this.services.textEditorRegistry.maintainConfig(this.component.refs.queryEditor),
    );
    if (this.component.refs.itemActionsIndicator) {
      this.disposables.add(
        this.services.tooltipManager.add(this.component.refs.itemActionsIndicator, {
          title: "Actions",
          keyBindingCommand: "select-list:actions",
          keyBindingTarget: this.component.refs.queryEditor.element,
        }),
      );
    }
    this.element.classList.add(...this.rootClasses());
    if (this.props.className) {
      this.element.classList.add(...this.props.className.split(/\s+/).filter(Boolean));
    }
    this.disposables.add(
      this.component.refs.queryEditor.onDidChange(() => {
        this.didChangeQuery();
      }),
    );
    if (this.props.placeholderText) {
      this.component.refs.queryEditor.setPlaceholderText(this.props.placeholderText);
    }
    this.scheduleStatusExpiry();
    this.disposables.add(this.registerCommands());
    this.registerActionCommands(this.props.commands);
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
    const didLoseFocus = this.didLoseFocus.bind(this);
    const didMouseDownOnElement = this.didMouseDownOnElement.bind(this);
    this.element.addEventListener("focusout", didLoseFocus);
    this.element.addEventListener("mousedown", didMouseDownOnElement);
    this.disposables.add(
      new Disposable(() => {
        this.element.removeEventListener("focusout", didLoseFocus);
        this.element.removeEventListener("mousedown", didMouseDownOnElement);
      }),
    );
    this.didInitializeElement();
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

  didInitializeElement() {}

  didSuspendPanel() {}

  /**
   * CSS classes applied to the root element. Subclasses override to replace
   * the default `input-dialog` class.
   * @private
   * @returns {string[]} Class names for the root element
   */
  rootClasses() {
    return ["input-dialog"];
  }

  /**
   * @public
   * @status experimental
   *
   * Focuses the query editor input.
   */
  focus() {
    this.component.refs.queryEditor.element.focus();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the root element rendered for this dialog.
   * @returns {HTMLElement}
   */
  getElement() {
    return this.element;
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether this dialog has been destroyed.
   * @returns {boolean}
   */
  isDestroyed() {
    return this.destroyed;
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when the query changes.
   */
  onDidChangeQuery(callback) {
    return this.emitter.on("did-change-query", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when modal visibility changes.
   */
  onDidChangeVisible(callback) {
    return this.emitter.on("did-change-visible", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback after a fresh dialog open.
   */
  onDidOpen(callback) {
    return this.emitter.on("did-open", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when a modal-flow step resumes.
   */
  onDidResume(callback) {
    return this.emitter.on("did-resume", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback after the dialog is hidden.
   */
  onDidHide(callback) {
    return this.emitter.on("did-hide", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when confirmation has no primary action.
   */
  onDidConfirm(callback) {
    return this.emitter.on("did-confirm", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback after the dialog is cancelled.
   */
  onDidCancel(callback) {
    return this.emitter.on("did-cancel", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback immediately before the dialog is destroyed.
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  /**
   * Handles focus leaving any element inside the dialog.
   * If focus moves within the dialog, refocuses the query editor unless the
   * new target is an interactive control (checkbox, button, custom content
   * input, …). If focus moves outside, cancels after a frame delay.
   * @param {FocusEvent} event - The focusout event
   * @private
   */
  didLoseFocus(event) {
    // Keep focus on editor when clicking inside the dialog
    if (this.element.contains(event.relatedTarget)) {
      // Focus already moving into the query editor (e.g. its internal input):
      // refocusing would re-fire focusout and recurse.
      if (this.component.refs.queryEditor.element.contains(event.relatedTarget)) return;
      // Let interactive controls keep the focus they just received.
      if (this.isInteractiveTarget(event.relatedTarget)) return;
      this.component.refs.queryEditor.element.focus();
      return;
    }
    // Wait for click to complete before canceling
    requestAnimationFrame(() => {
      if (!document.hasFocus() || !this.isVisible()) return;
      if (this.element.contains(document.activeElement)) return;
      this.cancel();
    });
  }

  /**
   * Keeps clicks on the dialog's own surface from moving focus away.
   * CSS pseudo-elements dispatch events as their owning element. Interactive
   * controls (inputs, checkboxes, buttons, links, custom content) are exempt
   * so they can receive focus and clicks normally.
   * @param {MouseEvent} event - The mousedown event
   * @private
   */
  didMouseDownOnElement(event) {
    // Let the query editor handle its own mousedown (cursor placement, selection)
    if (this.component.refs.queryEditor.element.contains(event.target)) return;
    if (this.isInteractiveTarget(event.target)) return;
    // Anywhere else inside the panel (messages, list, surface): keep focus on editor
    event.preventDefault();
    this.component.refs.queryEditor.element.focus();
  }

  /**
   * Returns whether a node is (or is inside) an interactive control that may
   * take focus without the focus policy stealing it back.
   * @param {Node} node - The node to test
   * @returns {boolean} True when the node resolves to an interactive control
   * @private
   */
  isInteractiveTarget(node) {
    if (!node || !node.closest) return false;
    const match = node.closest(INTERACTIVE_SELECTOR);
    // Bound the match to a control *inside* the dialog. `closest` would
    // otherwise escape upward to workspace-level `[tabindex]` elements and
    // treat every click as interactive.
    return !!match && match !== this.element && this.element.contains(match);
  }

  /**
   * @public
   * @status experimental
   *
   * Clears the query editor text.
   */
  reset() {
    this.component.refs.queryEditor.setText("");
  }

  /**
   * @public
   * @status experimental
   *
   * Destroys the dialog and cleans up resources.
   * @returns {Promise} Resolves when destruction is complete
   */
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearStatusTimer();
    this.disposables.dispose();
    this.services.actionService?.release(this);
    await this.dialogActions.destroy();
    this.dialogSource.destroy();
    if (this.panel) {
      this.panel.destroy();
      this.panel = null;
    }
    delete this.element.getModel;
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
    await this.component.destroy();
    this.component = null;
  }

  /**
   * @public
   * @status experimental
   *
   * Shows the dialog as a modal panel.
   *
   * The dialog reacts to its panel becoming visible — whoever shows it — so
   * the show side effects (open/resume events, select-all, focus) also run
   * when the panel is shown from outside, e.g. by the modal flow re-showing
   * this dialog on a back navigation.
   *
   * @param {Object} [options] - Passed through to Panel#show. `{crumb:
   *   "Label"}` (or `crumb: true` to use the dialog's `crumb` prop) displays
   *   the dialog as a step of the modal flow: the modal visible at that
   *   moment becomes the previous breadcrumb entry, and Shift-Escape or a
   *   crumb click returns to it. Without options the dialog is shown
   *   standalone, as before.
   */
  show(options) {
    // An explicit show is always an opening, never a resume. The flow re-shows
    // a step through the panel rather than through here, so clearing the flag
    // on this path cannot swallow a real return — it only stops a suspension
    // whose trail was abandoned (Shift+F10, then Escape) from surviving into the
    // next time the dialog is opened.
    this.suspendedByFlow = false;
    const panelOptions = { ...(options ?? {}) };
    this.openingQueryProvided = Object.prototype.hasOwnProperty.call(panelOptions, "query");
    this.selectOpeningQuery = panelOptions.selectQuery !== false;
    if (this.openingQueryProvided) {
      this.component.refs.queryEditor.setText(
        panelOptions.query == null ? "" : String(panelOptions.query),
      );
    }
    delete panelOptions.query;
    delete panelOptions.selectQuery;
    this.getPanel().show(Object.keys(panelOptions).length > 0 ? panelOptions : undefined);
    return this.sourcePromise ?? Promise.resolve();
  }

  /**
   * Runs the show side effects. Invoked whenever the panel becomes visible,
   * whether through {@link #show}, a modal-flow step change, or a
   * back navigation re-showing this dialog.
   *
   * A dialog opens on an empty query. The one exception is a dialog coming
   * back from a flow step — Shift+F10 into the actions list and back — which is a
   * resume, not an opening: clearing there would throw away the query the
   * action was about to act on. {@link #restoreQuery} (F11) is the on-demand
   * way to recover the query from the previous completed open.
   * @private
   */
  didShowPanel(generation = this.panelLifecycleGeneration) {
    const resuming = this.suspendedByFlow;
    this.suspendedByFlow = false;
    if (!resuming) this.openerElement = document.activeElement;
    if (!resuming) this.sourcePromise = null;
    try {
      this.emitter.emit("did-change-visible", { dialog: this, visible: true });
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      if (!resuming && !this.openingQueryProvided) this.reset();
      if (!this.isCurrentPanelLifecycle(generation, true)) return;

      this.refreshItemActionsIndicator();
      if (this.selectOpeningQuery !== false) this.component.refs.queryEditor.selectAll();
      this.focus();
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      if (!resuming) this.sourcePromise = this.dialogSource.open();
      if (!this.isCurrentPanelLifecycle(generation, true)) return;
      this.emitter.emit(resuming ? "did-resume" : "did-open", { dialog: this });
    } finally {
      this.openingQueryProvided = false;
      this.selectOpeningQuery = true;
    }
  }

  /**
   * Runs when the panel stops being visible for real — an explicit hide, a
   * cancel, or another modal taking over. A flow transition does not come
   * through here: the dialog is suspended, not closed.
   * @private
   */
  didHidePanel({ visibilityChanged = true, generation = this.panelLifecycleGeneration } = {}) {
    this.lastQuery = this.getQuery();
    this.dialogSource.cancel("dialog-hidden");
    if (visibilityChanged) {
      this.emitter.emit("did-change-visible", { dialog: this, visible: false });
    }
    if (!this.isCurrentPanelLifecycle(generation, false)) return;
    this.emitter.emit("did-hide", { dialog: this });
  }

  isCurrentPanelLifecycle(generation, visible) {
    return (
      !this.destroyed &&
      this.panelLifecycleGeneration === generation &&
      this.isVisible() === visible
    );
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the modal panel that hosts the dialog, creating it (hidden) on
   * first access. The panel item is `options.panelItem` when one was supplied,
   * otherwise the dialog model itself. The panel carries the dialog's `crumb`
   * as its declared breadcrumb label.
   * @returns {Panel} The modal panel
   */
  getPanel() {
    if (!this.panel) {
      this.panel = this.services.workspace.addModalPanel({
        item: this.props.panelItem ?? this,
        visible: false,
        crumb: this.props.crumb,
      });
      // The modal panel container force-hides every other modal panel when one
      // becomes visible, without notifying the owner. A dialog hidden that way
      // is orphaned: its cancel path never runs, so editor state it was meant
      // to restore stays broken and the panel leaks. Treat an unrequested hide
      // as a cancel — unless it is the modal flow moving to another step
      // (panel.flowTransition), which must not cancel the dialog the flow may
      // come back to.
      this.disposables.add(
        this.panel.onDidChangeVisible((visible) => {
          const generation = ++this.panelLifecycleGeneration;
          if (visible) {
            this.didShowPanel(generation);
            return;
          }
          if (this.panel.flowTransition) {
            // The flow moving to another step. The dialog is suspended, not
            // closed: it keeps its query for the return trip and records
            // nothing, since it was never left.
            this.suspendedByFlow = true;
            this.didSuspendPanel();
            this.emitter.emit("did-change-visible", { dialog: this, visible: false });
            return;
          }
          this.didHidePanel({ generation });
          if (this.hidingSelf) return;
          this.cancel();
        }),
        this.panel.onDidEndModalFlow((reason) => {
          if (!this.suspendedByFlow || this.destroyed) return;
          if (reason === "back") this.finalizeSuspendedHide();
          else this.cancel("modal-flow");
        }),
      );
    }
    return this.panel;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the item owned by the dialog's modal panel.
   */
  getPanelItem() {
    return this.getPanel().getItem();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the configured asynchronous source, or null.
   */
  getSource() {
    return this.props.source ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the asynchronous source and reload it when open.
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
   */
  reload() {
    return this.dialogSource.reload();
  }

  /**
   * @public
   * @status experimental
   *
   * Return whether source work or its debounce is pending.
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

  /**
   * @public
   * @status experimental
   *
   * Hides the dialog. Focus returns to the previously focused element via the
   * workspace's modal panel focus restoration.
   */
  hide() {
    const releasedActionPicker = this.services.actionService?.release(this) ?? false;
    if (!this.isVisible()) {
      if (releasedActionPicker) this.finalizeSuspendedHide();
      return;
    }

    if (this.panel) {
      this.hidingSelf = true;
      this.panel.hide();
      this.hidingSelf = false;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Toggles the visibility of the dialog.
   */
  toggle() {
    if (this.isVisible()) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Returns whether the dialog is currently visible.
   * @returns {boolean} True if the panel exists and is visible
   */
  isVisible() {
    return Boolean(this.panel?.isVisible());
  }

  registerCommands() {
    return this.services.commandRegistry.add(this.element, this.commandsForElement());
  }

  registerActionCommands(commands) {
    const listeners = this.prepareActionCommandListeners(commands);
    const nextDisposable =
      Object.keys(listeners).length > 0
        ? this.services.commandRegistry.add(this.element, listeners)
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
      opener: this.openerElement,
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

  /**
   * @public
   * @status experimental
   *
   * Return the complete declared action catalogue.
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
   */
  hasAvailableActions(context = this.getActionContext()) {
    return this.dialogActions.hasAvailable(context);
  }

  /**
   * @public
   * @status experimental
   *
   * Return evaluated actions for the current context.
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
   */
  isActionPending(command) {
    return this.dialogActions.isPending(command);
  }

  describeDialogAction(action, context) {
    let target = this.element;
    if (action.dispatch === "workspace") target = this.services.workspace.getElement();
    if (action.dispatch === "opener") target = context.opener ?? this.element;
    const bindingTarget = this.component.refs.queryEditor?.element ?? target;
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
    let target = this.element;
    if (action.dispatch === "workspace") target = this.services.workspace.getElement();
    if (action.dispatch === "opener") target = context.opener ?? this.element;

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
    const response = await this.services.applicationDelegate.confirm({
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
   */
  onDidStartAction(callback) {
    return this.emitter.on("did-start-action", callback);
  }

  /**
   * @public
   * @status experimental
   *
   * Invoke a callback when an action finishes.
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
    if (pending) this.element.setAttribute("aria-busy", "true");
    else this.element.removeAttribute("aria-busy");
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
        this.cancel();
        event.stopPropagation();
      },
      "select-list:actions": (event) => {
        if (this.props.internalActionPalette) {
          // Shift+F10 toggles: pressed in the actions list itself, it goes back to
          // the dialog it belongs to.
          this.services.workspace.popModal();
        } else {
          this.consumeUiAction(this.showActions());
        }
        event.stopPropagation();
      },
      "select-list:restore-query": (event) => {
        this.restoreQuery();
        event.stopPropagation();
      },
    };
  }

  /**
   * @public
   * @status experimental
   *
   * Puts back the query the dialog was last closed with, selected so the next
   * keystroke replaces it. A fresh show clears the query; this is how it is
   * asked for again.
   * @returns {boolean} Whether there was a query to restore
   */
  restoreQuery() {
    if (!this.lastQuery) return false;
    this.component.refs.queryEditor.setText(this.lastQuery);
    this.component.refs.queryEditor.selectAll();
    return true;
  }

  /**
   * @public
   * @status experimental
   *
   * Opens the explicitly declared actions in the workspace's shared action
   * picker, preserving this dialog as the previous modal-flow step.
   * @returns {Promise<boolean>} Whether an action picker was opened
   */
  async showActions() {
    try {
      if (this.props.internalActionPalette) return false;
      const context = this.getActionContext("actions");
      const actions = this.getAvailableActions(context);
      if (actions.length === 0) return false;

      const selected = typeof this.getSelectedItem === "function" ? this.getSelectedItem() : null;
      const info =
        selected != null && typeof this.getFilterKey === "function"
          ? this.getFilterKey(selected)
          : null;
      const opened = await this.services.actionService.show({
        owner: this,
        actions,
        context,
        infoMessage: info,
      });
      if (opened) this.setActionsExpanded(true);
      return opened;
    } catch (error) {
      if (!this.destroyed && error?.name !== "AbortError") {
        await this.setStatus({ type: "error", message: error?.message ?? String(error) });
      }
      throw error;
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Confirms the dialog with the current query through its primary action, or
   * emits `onDidConfirm` when no primary action is declared.
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
   * Cancels and hides the dialog, then emits `onDidCancel`.
   */
  cancel(reason = "api") {
    if (this.canceling || this.destroyed) return;
    this.canceling = true;
    this.hide();
    this.finalizeSuspendedHide();
    this.emitter.emit("did-cancel", { dialog: this, reason });
    this.canceling = false;
  }

  finalizeSuspendedHide() {
    if (!this.suspendedByFlow || this.isVisible()) return false;
    this.suspendedByFlow = false;
    this.didHidePanel({ visibilityChanged: false });
    return true;
  }

  /**
   * @public
   * @status experimental
   *
   * Update one or more documented dialog options.
   */
  update(props = {}) {
    this.validateUpdateProps(props);
    this.updateProps(props);
    this.refreshItemActionsIndicator();
    return this.component.update();
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

  /**
   * @public
   * @status experimental
   *
   * Return the current episodic status.
   */
  getStatus() {
    return this.props.status ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the episodic status.
   */
  setStatus(status) {
    return this.update({ status });
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the episodic status.
   */
  clearStatus() {
    return this.setStatus(null);
  }

  /**
   * @public
   * @status experimental
   *
   * Return the resting information message.
   */
  getInfoMessage() {
    return this.props.infoMessage ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the resting information message.
   */
  setInfoMessage(infoMessage) {
    return this.update({ infoMessage });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the current loading message and badge.
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
   */
  clearLoadingState() {
    return this.setLoadingState(null);
  }

  /**
   * @public
   * @status experimental
   *
   * Return the query editor placeholder.
   */
  getPlaceholderText() {
    return this.props.placeholderText ?? "";
  }

  /**
   * @public
   * @status experimental
   *
   * Set the query editor placeholder.
   */
  setPlaceholderText(placeholderText) {
    return this.update({ placeholderText });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the caller-owned header element.
   */
  getHeaderElement() {
    return this.props.headerElement ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the caller-owned header element.
   */
  setHeaderElement(headerElement) {
    return this.update({ headerElement });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the caller-owned content element.
   */
  getContentElement() {
    return this.props.contentElement ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Replace the caller-owned content element.
   */
  setContentElement(contentElement) {
    return this.update({ contentElement });
  }

  /**
   * @public
   * @status experimental
   *
   * Return the declared modal breadcrumb label.
   */
  getCrumb() {
    return this.props.crumb ?? null;
  }

  /**
   * @public
   * @status experimental
   *
   * Set the modal breadcrumb label.
   */
  setCrumb(crumb) {
    return this.update({ crumb });
  }

  /**
   * Applies prop changes shared by every dialog. Subclasses override to
   * handle their own props and call `super.updateProps(props)`.
   * @param {Object} props - The props to apply
   * @private
   */
  updateProps(props) {
    if ("query" in props) {
      this.component.refs.queryEditor.setText(props.query == null ? "" : String(props.query));
      // setText triggers didChangeQuery, so derived state refreshes itself
    }

    if ("selectQuery" in props) {
      if (props.selectQuery) {
        this.component.refs.queryEditor.selectAll();
      } else {
        this.component.refs.queryEditor.clearSelections();
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
      this.component.refs.queryEditor.setPlaceholderText(props.placeholderText || "");
    }

    if ("actions" in props) {
      this.setActions(props.actions ?? []);
    }

    if ("commands" in props) {
      this.props.commands = props.commands;
      this.registerActionCommands(props.commands);
    }

    if ("source" in props) {
      this.setSource(props.source ?? null);
    }

    if ("crumb" in props) {
      this.props.crumb = props.crumb;
      // The panel caches the declared label; keep it in sync.
      if (this.panel) {
        this.panel.crumb = props.crumb;
      }
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
    return $.div(
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
      $(TextEditor, { ref: "queryEditor", mini: true }),
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
                  this.consumeUiAction(this.showActions());
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
    const available = this.isVisible() && this.hasAvailableActions();
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

  /**
   * @public
   * @status experimental
   *
   * Return the raw query editor text.
   */
  getQuery() {
    if (this.component?.refs?.queryEditor) {
      return this.component.refs.queryEditor.getText();
    } else {
      return "";
    }
  }

  /**
   * @public
   * @status experimental
   *
   * Set the query text and optionally select it.
   */
  setQuery(query, { select = false } = {}) {
    return this.update({ query, selectQuery: select });
  }

  /**
   * @public
   * @status experimental
   *
   * Clear the query text.
   */
  clearQuery() {
    return this.setQuery("");
  }

  /**
   * @public
   * @status experimental
   *
   * Select the complete query.
   */
  selectQuery() {
    this.component.refs.queryEditor.selectAll();
  }

  /**
   * @public
   * @status experimental
   *
   * Return the full TextEditor model used for the query.
   */
  getQueryEditor() {
    return this.component.refs.queryEditor;
  }

  /**
   * @public
   * @status experimental
   *
   * Return the parsed query text and metadata.
   */
  getParsedQuery() {
    return Object.freeze({ text: this.getQuery(), data: null });
  }

  /**
   * @public
   * @status experimental
   *
   * Use the active editor's single-line selection as the query.
   */
  setQueryFromSelection() {
    const editor = this.services.workspace.getActiveTextEditor();
    if (!editor) return false;
    const text = editor.getSelectedText();
    if (!text || /\n/.test(text)) return false;
    this.component.refs.queryEditor.setText(text);
    this.component.refs.queryEditor.selectAll();
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
      this.component.update();
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
