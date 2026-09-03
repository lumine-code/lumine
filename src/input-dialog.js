"use strict";

const { Disposable, CompositeDisposable, Emitter } = require("@lumine-code/event-kit");
const { humanizeKeystroke } = require("@lumine-code/underscore-plus");
const etch = require("@lumine-code/etch");
const TextEditor = require("./text-editor");
const DialogActions = require("./dialog-actions");
const DialogSource = require("./dialog-source");
const InputDialogComponent = require("./input-dialog-component");
const $ = etch.dom;

// The dialog's own chrome commands never appear in the item-actions list.
const UNLISTED_ACTIONS = new Set(["select-list:actions", "select-list:restore-query"]);

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
 * `preserveQuery` opts out of the clearing. A dialog therefore never needs to
 * call `reset()` before `show()`.
 */
class InputDialog {
  constructor(props, services) {
    this.props = { ...(props ?? {}) };
    this.services = services;
    this.emitter = new Emitter();
    this.statusTimer = null;
    this.destroyed = false;
    this.itemActionsAvailable = false;
    // The query the dialog was last closed with, and whether the dialog is
    // coming back from a flow step rather than being opened afresh. See
    // {@link #didShowPanel}.
    this.lastQuery = "";
    this.suspendedByFlow = false;
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
      this.dialogActions.onDidStart((event) => this.emitter.emit("did-start-action", event)),
      this.dialogActions.onDidFinish((event) => this.emitter.emit("did-finish-action", event)),
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

  onDidChangeQuery(callback) {
    return this.emitter.on("did-change-query", callback);
  }

  onDidChangeVisible(callback) {
    return this.emitter.on("did-change-visible", callback);
  }

  onDidOpen(callback) {
    return this.emitter.on("did-open", callback);
  }

  onDidResume(callback) {
    return this.emitter.on("did-resume", callback);
  }

  onDidHide(callback) {
    return this.emitter.on("did-hide", callback);
  }

  onDidConfirm(callback) {
    return this.emitter.on("did-confirm", callback);
  }

  onDidCancel(callback) {
    return this.emitter.on("did-cancel", callback);
  }

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
    if (this.itemActionsDisposables) {
      this.itemActionsDisposables.dispose();
      this.itemActionsDisposables = null;
    }
    await this.dialogActions.destroy();
    this.dialogSource.destroy();
    if (this.itemActionsList) {
      await this.itemActionsList.destroy();
      this.itemActionsList = null;
    }
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
   * the show side effects (willShow, select-all, focus) also run
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
    this.openerElement = document.activeElement;
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
   * action was about to act on. `preserveQuery` opts a dialog out entirely and
   * carries the query across ordinary opens too; {@link #restoreQuery} (F11)
   * is the on-demand version of the same thing.
   * @private
   */
  didShowPanel() {
    const resuming = this.suspendedByFlow;
    this.suspendedByFlow = false;
    if (!resuming && !this.openingQueryProvided && !this.props.preserveQuery) {
      this.reset();
    }

    if (this.props.willShow) {
      this.props.willShow();
    }

    this.refreshItemActionsIndicator();
    if (this.selectOpeningQuery !== false) this.component.refs.queryEditor.selectAll();
    this.focus();
    this.emitter.emit(resuming ? "did-resume" : "did-open", { dialog: this });
    this.emitter.emit("did-change-visible", { dialog: this, visible: true });
    if (!resuming) this.sourcePromise = this.dialogSource.open();
    this.openingQueryProvided = false;
    this.selectOpeningQuery = true;
  }

  /**
   * Runs when the panel stops being visible for real — an explicit hide, a
   * cancel, or another modal taking over. A flow transition does not come
   * through here: the dialog is suspended, not closed.
   * @private
   */
  didHidePanel() {
    this.lastQuery = this.getQuery();
    this.dialogSource.cancel("dialog-hidden");
    this.emitter.emit("did-hide", { dialog: this });
    this.emitter.emit("did-change-visible", { dialog: this, visible: false });
  }

  /**
   * @public
   * @status experimental
   *
   * Returns the modal panel that hosts the dialog, creating it (hidden) on
   * first access. The panel's item is `props.panelItem` when provided,
   * otherwise the dialog itself. The panel carries the dialog's `crumb` prop
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
          if (visible) {
            this.didShowPanel();
            return;
          }
          if (this.panel.flowTransition) {
            // The flow moving to another step. The dialog is suspended, not
            // closed: it keeps its query for the return trip and records
            // nothing, since it was never left.
            this.suspendedByFlow = true;
            return;
          }
          this.didHidePanel();
          if (this.hidingSelf) return;
          this.cancel();
        }),
      );
    }
    return this.panel;
  }

  getPanelItem() {
    return this.getPanel().getItem();
  }

  getSource() {
    return this.props.source ?? null;
  }

  setSource(source) {
    this.props.source = source;
    return this.dialogSource.setSource(source);
  }

  reload() {
    return this.dialogSource.reload();
  }

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
    if (!this.isVisible()) {
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
    if (this.actionCommandsDisposable) {
      this.disposables.remove(this.actionCommandsDisposable);
      this.actionCommandsDisposable.dispose();
      this.actionCommandsDisposable = null;
    }
    if (!commands || Object.keys(commands).length === 0) return;

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
          return this.runAction(command, { source: "command" });
        },
      };
    }

    this.actionCommandsDisposable = this.services.commandRegistry.add(this.element, listeners);
    this.disposables.add(this.actionCommandsDisposable);
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

  getActions() {
    return this.dialogActions.getAll();
  }

  setActions(actions) {
    this.dialogActions.set(actions);
    this.props.actions = actions;
    this.refreshItemActionsIndicator();
    return this;
  }

  addAction(action) {
    const disposable = this.dialogActions.add(action);
    this.refreshItemActionsIndicator();
    return new Disposable(() => {
      disposable.dispose();
      this.refreshItemActionsIndicator();
    });
  }

  hasAvailableActions(context = this.getActionContext()) {
    return this.dialogActions.hasAvailable(context);
  }

  getAvailableActions(context = this.getActionContext()) {
    return this.dialogActions
      .getAvailable(context)
      .map((action) => this.describeDialogAction(action, context));
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
      keystrokes,
    });
  }

  async dispatchAction({ action, context, signal }) {
    let target = this.element;
    if (action.dispatch === "workspace") target = this.services.workspace.getElement();
    if (action.dispatch === "opener") target = context.opener ?? this.element;

    this.dispatchedActionCommand = action.command;
    try {
      const result = this.services.commandRegistry.dispatch(target, action.command, {
        ...context,
        signal,
      });
      if (!result) throw new Error(`Dialog action command '${action.command}' is not registered.`);
      return await result;
    } finally {
      this.dispatchedActionCommand = null;
    }
  }

  async confirmDialogAction({ confirmation, context }) {
    const options =
      typeof confirmation === "function"
        ? confirmation(context)
        : confirmation === true
          ? {}
          : confirmation;
    const message = options?.message ?? "Perform this action?";
    const confirmText = options?.confirmText ?? "Confirm";
    const cancelText = options?.cancelText ?? "Cancel";
    const response = await this.services.applicationDelegate.confirm({
      message,
      detail: options?.detail,
      buttons: [confirmText, cancelText],
    });
    return response === 0;
  }

  runAction(command, { source = "api", context = null } = {}) {
    return this.dialogActions
      .run(command, context ?? this.getActionContext(source))
      .catch((error) => {
        if (error?.name !== "AbortError") {
          this.setStatus({ type: "error", message: error?.message ?? String(error) });
        }
        throw error;
      });
  }

  showActions() {
    return this.showItemActions();
  }

  onDidStartAction(callback) {
    return this.emitter.on("did-start-action", callback);
  }

  onDidFinishAction(callback) {
    return this.emitter.on("did-finish-action", callback);
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
        const result = this.confirm();
        event.stopPropagation();
        return result;
      },
      "core:cancel": (event) => {
        this.cancel();
        event.stopPropagation();
      },
      "select-list:actions": (event) => {
        if (this.props.skipItemActions || this.props.internalActionPalette) {
          // Shift+F10 toggles: pressed in the actions list itself, it goes back to
          // the dialog it belongs to.
          this.services.workspace.popModal();
        } else {
          this.showItemActions();
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
   * keystroke replaces it. The counterpart of `preserveQuery`: the query is
   * cleared on every fresh show, and this is how it is asked for again.
   * @returns {boolean} Whether there was a query to restore
   */
  restoreQuery() {
    if (!this.lastQuery) return false;
    this.component.refs.queryEditor.setText(this.lastQuery);
    this.component.refs.queryEditor.selectAll();
    return true;
  }

  /**
   * The item actions this dialog offers: the commands it contributes itself —
   * those reachable from its root element but not from the panel's host — and
   * any reachable host commands named by `additionalActionCommands`, each
   * with the label, description, and keybindings it carries in the registry,
   * the same sources the command palette reads. Packages register their
   * actions in their own namespace (`fuzzy-files:open`); the dialog's chrome
   * (`core:*`, `select-list:*` built-ins) stays out, always. An
   * `actionsFilter(descriptor)` prop narrows what is left of that, so an
   * action that only applies to some rows is listed only while one of them
   * is selected — the list is rebuilt on every Shift+F10, with the selection
   * already made, so the predicate may read it.
   *
   * Each action is either about the **selected row** or about the **list** —
   * "open this file in a split" against "index the project again". A package
   * says which by putting `actionScope: "list"` on the registration; `"item"`
   * is the default, since most actions are. The registry keeps any key it
   * does not recognise, so this costs nothing but the word.
   * @returns {Array} Action descriptors: {name, description, command, keystrokes, scope}
   * @private
   */
  itemActions() {
    if (this.dialogActions.getAll().length > 0) {
      return this.getAvailableActions();
    }

    // Anchor on the dialog root, not the query editor: from the editor the
    // difference would also sweep in every selector-based editor command.
    // From the root it holds exactly what the dialog contributes — packages
    // register their actions inline on this element.
    const host = this.getPanel().getElement().parentNode ?? this.services.workspace.getElement();
    const above = new Set(
      this.services.commandRegistry
        .findCommands({ target: host })
        .map((descriptor) => descriptor.name),
    );
    const available = this.services.commandRegistry.findCommands({ target: this.element });
    const descriptorsByName = new Map(available.map((descriptor) => [descriptor.name, descriptor]));
    const descriptors = [];
    const seenCommands = new Set();
    for (const descriptor of available) {
      if (above.has(descriptor.name) || seenCommands.has(descriptor.name)) continue;
      descriptors.push(descriptor);
      seenCommands.add(descriptor.name);
    }
    for (const command of this.props.additionalActionCommands ?? []) {
      const descriptor = descriptorsByName.get(command);
      if (!descriptor || seenCommands.has(command)) continue;
      descriptors.push(descriptor);
      seenCommands.add(command);
    }

    // A SelectList supplies these methods; a plain InputDialog has no
    // selected-row semantics and keeps every action it contributes.
    const hasSelection = typeof this.getSelectedItem === "function";
    const selected = hasSelection ? (this.getSelectedItem() ?? null) : null;
    const confirmAction =
      typeof this.confirmActionForItem === "function" ? this.confirmActionForItem(selected) : null;
    // The chrome exclusions are built in and hold whatever the
    // caller says. An item action needs a selected item; `actionsFilter` only
    // narrows what survives those built-in rules.
    const filter = (descriptor) =>
      !descriptor.name.startsWith("core:") &&
      !UNLISTED_ACTIONS.has(descriptor.name) &&
      (!hasSelection || selected != null || descriptor.actionScope === "list") &&
      (this.props.actionsFilter?.(descriptor) ?? true);
    // Keybindings resolve against the query editor, where dialog keymaps point.
    const bindingTarget = this.component.refs.queryEditor.element;
    return descriptors.filter(filter).map((descriptor) => {
      const bindingCommands =
        descriptor.name === confirmAction ? ["core:confirm", descriptor.name] : [descriptor.name];
      const seenKeystrokes = new Set();
      const keystrokes = [];
      for (const command of bindingCommands) {
        for (const binding of this.services.keymapManager.findKeyBindings({
          command,
          target: bindingTarget,
        })) {
          if (seenKeystrokes.has(binding.keystrokes)) continue;
          seenKeystrokes.add(binding.keystrokes);
          keystrokes.push(binding.keystrokes);
        }
      }
      return {
        // In a dialog that belongs to one package, the namespace is noise.
        name: descriptor.displayName.replace(/^[^:]+:\s*/, ""),
        description: descriptor.description,
        command: descriptor.name,
        scope: descriptor.actionScope === "list" ? "list" : "item",
        keystrokes,
      };
    });
  }

  /**
   * The actions in the order the list shows them — everything about the
   * selected row first, then everything about the list — with the identifier
   * of the row the group separator goes above. Nothing separates a list that
   * is all one scope.
   * @param {Array} actions - Descriptors from {@link #itemActions}
   * @returns {Object} `{items, separatorIds}` for the actions list
   * @private
   */
  groupItemActions(actions) {
    if (actions.some((action) => action.group)) {
      const separatorIds = [];
      let previousGroup = null;
      actions.forEach((action, index) => {
        const group = action.group ?? "";
        if (index > 0 && group !== previousGroup) separatorIds.push(action.command);
        previousGroup = group;
      });
      return { items: actions, separatorIds };
    }

    const contextFor = (action) =>
      action.context ?? (action.scope === "list" ? "dialog" : action.scope);
    const items = [
      ...actions.filter((action) => contextFor(action) !== "dialog"),
      ...actions.filter((action) => contextFor(action) === "dialog"),
    ];
    const boundary = items.findIndex((action) => contextFor(action) === "dialog");
    return { items, separatorIds: boundary > 0 ? [items[boundary].command] : [] };
  }

  /**
   * Shows the item-actions list — every command the dialog offers, with its
   * keybinding — as a step of the modal flow. Bound to Shift+F10 as
   * `select-list:actions`; Shift+F10 in the actions list itself goes back.
   * Confirming an action (or pressing its keybinding right in the actions
   * list) returns here first and then runs the command, exactly as if it was
   * pressed in this dialog.
   *
   * The rows are grouped: what acts on the selected item, then a separator,
   * then what acts on the list — see {@link #itemActions} for how a package
   * declares which is which.
   * @private
   */
  async showItemActions() {
    if (this.props.skipItemActions) return false;
    const actions = this.itemActions();
    if (actions.length === 0) return false;

    if (this.dialogActions.getAll().length > 0 && this.services.actionService) {
      const context = this.getActionContext("actions");
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
      if (opened) {
        this.component.refs?.itemActionsIndicator?.setAttribute("aria-expanded", "true");
      }
      return opened;
    }

    if (!this.itemActionsList) {
      // Lazy: select-list.js requires this module while it is still loading,
      // so the class is only reachable after both modules are initialized.
      const SelectList = require("./select-list");
      this.itemActionsList = new SelectList(
        {
          // The actions list wears the master's classes, so the package's own
          // keymap applies inside it untouched — an action keystroke resolves
          // there exactly as it does in the master. Packages bind actions in
          // their own namespace and leave the chrome keys (enter, escape,
          // navigation, Shift+F10) alone, so the base bindings keep working here.
          className: ["select-list-actions", this.props.className].filter(Boolean).join(" "),
          // An actions list of an actions list would only find the forwarders.
          skipItemActions: true,
          items: [],
          filterKeyForItem: (item) => `${item.name} ${item.description ?? ""}`,
          // The row/list divider means something only while the registration
          // order is on screen. Under a query the two groups interleave by
          // score, and a line drawn anywhere in that would be a lie.
          idForItem: (item) => (this.itemActionsList.getQuery() === "" ? item.command : null),
          elementForItem: (item, { highlight }) => ({
            className: [!item.enabled && "disabled", item.tone === "danger" && "text-error"].filter(
              Boolean,
            ),
            primary: highlight(item.name),
            secondary:
              item.enabled === false ? item.disabledReason || item.description : item.description,
            // Rendered the way the command palette writes keystrokes
            // (Alt+Enter); the raw form stays on the item for dispatching.
            trailing: item.keystrokes.map((keystrokes) => ({
              text: humanizeKeystroke(keystrokes),
              className: "key-binding",
            })),
          }),
          didConfirmSelection: (item) => {
            if (item.enabled === false) {
              return this.itemActionsList.setStatus({
                type: "warning",
                message: item.disabledReason || "This action is unavailable.",
              });
            }
            return this.runItemAction(item.command);
          },
          didCancelSelection: () => this.itemActionsList.hide(),
        },
        this.services,
      );
    }

    // Command listeners live on this dialog's element, so a keystroke
    // resolved inside the actions list needs a forwarder to reach them.
    // Disposed when the actions list hides, so a stale action set never
    // lingers.
    if (this.itemActionsDisposables) this.itemActionsDisposables.dispose();
    const forwarders = {};
    for (const action of actions) {
      forwarders[action.command] = (event) => {
        this.runItemAction(action.command);
        event.stopPropagation();
      };
    }
    this.itemActionsDisposables = new CompositeDisposable(
      this.services.commandRegistry.add(this.itemActionsList.element, forwarders),
      this.itemActionsList.getPanel().onDidChangeVisible((visible) => {
        this.component.refs?.itemActionsIndicator?.setAttribute("aria-expanded", String(visible));
        if (visible) return;
        this.itemActionsDisposables?.dispose();
        this.itemActionsDisposables = null;
      }),
    );

    // A select list names the selected item; a plain dialog has no selection.
    const selected = typeof this.getSelectedItem === "function" ? this.getSelectedItem() : null;
    const info =
      selected != null && typeof this.getFilterKey === "function"
        ? this.getFilterKey(selected)
        : null;
    this.itemActionsList.reset();
    await this.itemActionsList.update({
      ...this.groupItemActions(actions),
      infoMessage: info,
    });
    this.itemActionsList.show({ crumb: "Actions" });
    this.component.refs?.itemActionsIndicator?.setAttribute("aria-expanded", "true");
    return true;
  }

  /**
   * Runs an item action: returns to this dialog first — so the handler sees
   * it visible and focused, with its state intact — then dispatches the
   * command on the query editor, exactly like the keystroke it stands for.
   *
   * Returning re-shows the dialog, which runs its `willShow` again, and a
   * `willShow` that reloads the items resets the selection with them. That
   * would hand the action a different item than the one it was chosen for —
   * silently, since the fallback is a real item — so the selection is put
   * back before the command runs. Only if the item is still in the list: a
   * refresh that dropped it has genuinely unselected it. A refresh may rebuild
   * the same logical row as a new object, so identity wins first and a stable
   * `getIdForItem` match is the fallback.
   * @param {string} command - The command name to dispatch
   * @private
   */
  runItemAction(command) {
    if (this.dialogActions.has(command)) {
      const context = this.getActionContext("actions");
      if (!this.services.workspace.popModal()) {
        this.itemActionsList.hide();
        this.show();
      }
      return this.runAction(command, { source: "actions", context });
    }

    const selected = typeof this.getSelectedItem === "function" ? this.getSelectedItem() : null;
    const selectedId =
      selected != null && typeof this.getIdForItem === "function"
        ? this.getIdForItem(selected)
        : null;

    if (!this.services.workspace.popModal()) {
      // The trail is gone (the actions list was somehow orphaned); recover by
      // swapping the panels directly.
      this.itemActionsList.hide();
      this.show();
    }

    if (selected != null && this.items) {
      let restored = this.items.includes(selected) ? selected : null;
      if (restored == null && selectedId != null && typeof this.getIdForItem === "function") {
        restored = this.items.find((item) => this.getIdForItem(item) === selectedId) ?? null;
      }
      if (restored != null) this.selectItem(restored);
    }

    this.services.commandRegistry.dispatch(this.component.refs.queryEditor.element, command);
  }

  /**
   * @public
   * @status experimental
   *
   * Confirms the dialog with the current query.
   * Calls the didConfirm callback with the raw query text.
   */
  confirm() {
    const primary = this.dialogActions.getPrimary(this.getActionContext("primary"));
    if (primary) return this.runAction(primary.command, { source: "primary" });
    const query = this.getQuery();
    if (this.props.didConfirm) {
      this.props.didConfirm(query);
    }
    this.emitter.emit("did-confirm", { dialog: this, query });
  }

  /**
   * @public
   * @status experimental
   *
   * Cancels the dialog and calls the didCancel callback if provided.
   */
  cancel(reason = "api") {
    if (this.canceling || this.destroyed) return;
    this.canceling = true;
    this.hide();
    if (this.props.didCancel) this.props.didCancel();
    this.emitter.emit("did-cancel", { dialog: this, reason });
    this.canceling = false;
  }

  update(props = {}) {
    this.updateProps(props);
    this.refreshItemActionsIndicator();
    return this.component.update();
  }

  getStatus() {
    return this.props.status ?? null;
  }

  setStatus(status) {
    return this.update({ status });
  }

  clearStatus() {
    return this.setStatus(null);
  }

  getInfoMessage() {
    return this.props.infoMessage ?? null;
  }

  setInfoMessage(infoMessage) {
    return this.update({ infoMessage });
  }

  getLoadingState() {
    if (!this.props.loadingMessage) return null;
    return { message: this.props.loadingMessage, badge: this.props.loadingBadge ?? null };
  }

  setLoadingState(loading) {
    return this.update({
      loadingMessage: loading?.message ?? null,
      loadingBadge: loading?.badge ?? null,
    });
  }

  clearLoadingState() {
    return this.setLoadingState(null);
  }

  getPlaceholderText() {
    return this.props.placeholderText ?? "";
  }

  setPlaceholderText(placeholderText) {
    return this.update({ placeholderText });
  }

  getHeaderElement() {
    return this.props.headerElement ?? null;
  }

  setHeaderElement(headerElement) {
    return this.update({ headerElement });
  }

  getContentElement() {
    return this.props.contentElement ?? null;
  }

  setContentElement(contentElement) {
    return this.update({ contentElement });
  }

  getCrumb() {
    return this.props.crumb ?? null;
  }

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
      this.component.refs.queryEditor.setText(props.query);
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

    if ("preserveQuery" in props) {
      this.props.preserveQuery = props.preserveQuery;
    }

    if ("additionalActionCommands" in props) {
      this.props.additionalActionCommands = props.additionalActionCommands;
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
    return $.div(
      {
        ref: "queryRow",
        className: `query-row${this.itemActionsAvailable ? " has-item-actions" : ""}`,
      },
      $(TextEditor, { ref: "queryEditor", mini: true }),
      this.props.skipItemActions || this.props.internalActionPalette
        ? ""
        : $.button({
            ref: "itemActionsIndicator",
            className: "item-actions-indicator icon icon-ellipsis",
            type: "button",
            tabIndex: -1,
            hidden: !this.itemActionsAvailable,
            attributes: {
              "aria-label": "Actions",
              "aria-haspopup": "listbox",
              "aria-expanded": "false",
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
                this.showItemActions();
              },
            },
          }),
    );
  }

  /**
   * Shows the query-row affordance exactly while this visible dialog offers
   * at least one item action. `actionsFilter` may depend on the query or the
   * selected row, so callers refresh this after either changes. This is an
   * imperative toggle rather than a component update: moving through a list
   * already re-renders only the two affected rows, and the indicator should
   * not turn that into a full list render.
   * @private
   */
  refreshItemActionsIndicator() {
    if (!this.component.refs?.itemActionsIndicator) return;
    const available =
      this.isVisible() &&
      (this.dialogActions.getAll().length > 0
        ? this.hasAvailableActions()
        : this.itemActions().length > 0);
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

  getQuery() {
    if (this.component?.refs?.queryEditor) {
      return this.component.refs.queryEditor.getText();
    } else {
      return "";
    }
  }

  setQuery(query, { select = false } = {}) {
    return this.update({ query, selectQuery: select });
  }

  clearQuery() {
    return this.setQuery("");
  }

  selectQuery() {
    this.component.refs.queryEditor.selectAll();
  }

  getQueryEditor() {
    return this.component.refs.queryEditor;
  }

  getFilterQuery() {
    return this.props.filterQuery ? this.props.filterQuery(this.getQuery()) : this.getQuery();
  }

  getParsedQuery() {
    return Object.freeze({ text: this.getFilterQuery(), data: null });
  }

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
    if (this.props.didChangeQuery) {
      this.props.didChangeQuery(this.getFilterQuery());
    }
    this.emitter.emit("did-change-query", {
      dialog: this,
      query: this.getQuery(),
      filterQuery: this.getFilterQuery(),
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
