const { Emitter, CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const PanelContainer = require("./panel-container");
const Panel = require("./panel");
const ModalFlow = require("./modal-flow");

/**
 * @public
 * @status public
 *
 * A presentation window belonging to one workspace. Documents and packages
 * belong to the workspace; this object owns the window's presentation lifetime.
 */
module.exports = class EditorWindow {
  constructor({ workspace, editorContainer, windowService, main = false, requestClose }) {
    this.workspace = workspace;
    this.editorContainer = editorContainer;
    this.windowService = windowService;
    this.main = main;
    this.persistentId = main ? "main" : windowService.persistentId;
    this.requestClose = requestClose;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.destroyed = false;
    this.willDestroyCallbacks = new Set();
    this.didDestroyCallbacks = new Set();
    this.domWindow = null;
    this.element = null;
    editorContainer.editorWindow = this;
    this.panelContainers = main
      ? workspace.panelContainers
      : Object.fromEntries(
          ["header", "footer", "modal"].map((location) => [
            location,
            new PanelContainer({
              location,
              viewRegistry: workspace.viewRegistry,
            }),
          ]),
        );
    if (!main && workspace.viewRegistry) {
      this.subscriptions.add({
        dispose: () => {
          for (const container of Object.values(this.panelContainers)) container.destroy();
        },
      });
    }
  }

  /**
   * @public
   * @status public
   *
   * Get the native identity of this window.
   */
  getId() {
    return this.windowService.getId();
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this is the workspace's main window.
   */
  isMain() {
    return this.main;
  }

  /**
   * @public
   * @status public
   *
   * Get the shared workspace owning this window.
   */
  getWorkspace() {
    return this.workspace;
  }

  /**
   * @public
   * @status public
   *
   * Get this window's local document pane container.
   */
  getEditorContainer() {
    return this.editorContainer;
  }

  /**
   * @public
   * @status public
   *
   * Get the DOM document used by this presentation.
   */
  getDocument() {
    return this.domWindow?.document ?? null;
  }

  /**
   * @public
   * @status public
   *
   * Get the DOM window used by this presentation.
   */
  getDOMWindow() {
    return this.domWindow;
  }

  /**
   * @public
   * @status extended
   *
   * Send a message to an embedded frame from its physical parent window.
   * @param {HTMLIFrameElement} frame - A frame belonging to this window's document.
   * @param {Object} message - Structured-cloneable message data.
   * @param {String} origin - The expected target origin, or "*" for an opaque sandbox.
   * @param {Array} ports - Transferable ports owned by the caller.
   */
  postMessageToFrame(frame, message, origin = "*", ports = []) {
    if (this.destroyed || frame.ownerDocument !== this.getDocument())
      throw new Error("The embedded frame does not belong to this editor window.");
    if (this.main) frame.contentWindow.postMessage(message, origin, ports);
    else this.domWindow.luminePresentation.postMessage(frame.contentWindow, message, origin, ports);
  }

  /**
   * @public
   * @status public
   *
   * Get this window's workspace command root.
   */
  getElement() {
    if (this.main && !this.destroyed && !this.element && this.domWindow)
      this.element = this.workspace.getElement();
    return this.element;
  }

  /**
   * @public
   * @status public
   *
   * Add a panel to this window's title bar region.
   * @param {Object} options - Panel item, visibility and priority.
   * @returns {Panel} The window-local panel.
   */
  addHeaderPanel(options) {
    return this.panelContainers.header.addPanel(new Panel(options, this.workspace.viewRegistry));
  }

  /**
   * @public
   * @status public
   *
   * Add a panel to this window's status bar region.
   * @param {Object} options - Panel item, visibility and priority.
   * @returns {Panel} The window-local panel.
   */
  addFooterPanel(options) {
    return this.panelContainers.footer.addPanel(new Panel(options, this.workspace.viewRegistry));
  }

  /**
   * @public
   * @status public
   *
   * Add a modal panel to this presentation's own document.
   * @param {Object} options - Panel content, visibility and modal options.
   * @returns {Panel} The local modal panel.
   */
  addModalPanel(options) {
    const panel = new Panel(options, this.workspace.viewRegistry);
    panel.flowKeeper = this.getModalFlow();
    return this.panelContainers.modal.addPanel(panel);
  }

  /** @private Own a separate breadcrumb trail for this document. */
  getModalFlow() {
    if (this.main) return this.workspace.getModalFlow();
    if (!this.modalFlow) {
      this.modalFlow = new ModalFlow(this);
      this.subscriptions.add(new Disposable(() => this.modalFlow.destroy()));
    }
    return this.modalFlow;
  }

  /** @private */
  getPanelContainers() {
    return this.panelContainers;
  }

  /** @private Bind presentation only after its document and root are ready. */
  setPresentation(domWindow, element) {
    if (this.destroyed) throw new Error("The editor window has been destroyed.");
    this.domWindow = domWindow;
    this.element = element;
    this.emitter.emit("did-set-presentation", this);
  }

  /**
   * @public
   * @status public
   *
   * Determine whether this presentation has been destroyed.
   */
  isDestroyed() {
    return this.destroyed;
  }

  /**
   * @public
   * @status public
   *
   * Subscribe before the window's presentation is released.
   */
  onWillDestroy(callback) {
    this.willDestroyCallbacks.add(callback);
    return new Disposable(() => this.willDestroyCallbacks.delete(callback));
  }

  /**
   * @public
   * @status public
   *
   * Subscribe after the window's presentation is released.
   */
  onDidDestroy(callback) {
    this.didDestroyCallbacks.add(callback);
    return new Disposable(() => this.didDestroyCallbacks.delete(callback));
  }

  /**
   * @public
   * @status public
   *
   * Subscribe when the native window gains focus.
   */
  onDidFocus(callback) {
    return this.windowService.onDidFocus(callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe when the native window loses focus.
   */
  onDidBlur(callback) {
    return this.windowService.onDidBlur(callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe when this native window is maximized.
   * @param {Function} callback - The observer.
   * @returns {Disposable} Removes the observation.
   */
  onDidMaximize(callback) {
    return this.windowService.onDidMaximize(callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe when this native window leaves maximization.
   * @param {Function} callback - The observer.
   * @returns {Disposable} Removes the observation.
   */
  onDidUnmaximize(callback) {
    return this.windowService.onDidUnmaximize(callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe when this native window enters fullscreen.
   * @param {Function} callback - The observer.
   * @returns {Disposable} Removes the observation.
   */
  onDidEnterFullScreen(callback) {
    return this.windowService.onDidEnterFullScreen(callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe when this native window leaves fullscreen.
   * @param {Function} callback - The observer.
   * @returns {Disposable} Removes the observation.
   */
  onDidLeaveFullScreen(callback) {
    return this.windowService.onDidLeaveFullScreen(callback);
  }

  /**
   * @public
   * @status public
   *
   * Set the native bounds of this presentation.
   * @param {Object} bounds - x, y, width and height.
   * @returns {Promise} Completes when the bounds have been applied.
   */
  setBounds(bounds) {
    if (this.windowService.setBounds) return this.windowService.setBounds(bounds);
    return Promise.all([
      this.windowService.setPosition(bounds.x, bounds.y),
      this.windowService.setSize(bounds.width, bounds.height),
    ]);
  }

  /**
   * @public
   * @status public
   *
   * Set the document path represented by this native window.
   * @param {String} filename - The current path, or an empty string.
   * @returns {Promise} Completes after the native property is set.
   */
  setRepresentedFilename(filename) {
    return this.windowService.setRepresentedFilename(filename);
  }

  /**
   * @public
   * @status public
   *
   * Set the attachment offset of native sheets in this window.
   * @param {Number} offset - The title bar height in pixels.
   * @returns {Promise|undefined} Completes when supported by the platform.
   */
  setSheetOffset(offset) {
    return this.windowService.setSheetOffset?.(offset);
  }

  /**
   * @public
   * @status public
   *
   * Choose a save path in a native dialog attached to this window.
   * @param {Object} options - Electron save dialog options.
   * @returns {Promise<Object>} The selected filePath or a cancelled result.
   */
  showSaveDialog(options = {}) {
    return this.windowService.showSaveDialog(options);
  }

  /**
   * @public
   * @status public
   *
   * Ask for a decision in a native dialog attached to this window.
   * @param {Object} options - The message, detail and button labels.
   * @returns {Promise<Number>} The selected button index.
   */
  confirm(options) {
    return this.windowService.confirm(options);
  }

  /**
   * @public
   * @status public
   *
   * Read the native window's state.
   */
  getState() {
    return this.windowService.getState();
  }

  /** @private Native state is pushed on geometry events so snapshots remain synchronous. */
  serializeGeometry() {
    const state = this.windowService.state;
    return {
      bounds: state?.bounds,
      maximized: !!state?.maximized,
      fullScreen: !!state?.fullScreen,
    };
  }

  /**
   * @public
   * @status public
   *
   * Focus this window.
   */
  focus() {
    return this.windowService.focus();
  }

  /**
   * @public
   * @status public
   *
   * Minimize this window.
   */
  minimize() {
    return this.windowService.minimize();
  }

  /**
   * @public
   * @status public
   *
   * Maximize this window.
   */
  maximize() {
    return this.windowService.maximize();
  }

  /**
   * @public
   * @status public
   *
   * Restore this window from maximization.
   */
  unmaximize() {
    return this.windowService.unmaximize();
  }

  /**
   * @public
   * @status public
   *
   * Request a coordinated close of this window.
   */
  close() {
    return this.requestClose ? this.requestClose(this) : this.windowService.close();
  }

  /** @private Release presentation resources without destroying document models. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const errors = [];
    const attempt = (callback) => {
      try {
        callback();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const callback of [...this.willDestroyCallbacks]) attempt(() => callback(this));
    this.willDestroyCallbacks.clear();
    attempt(() => this.subscriptions.dispose());
    this.element = null;
    this.domWindow = null;
    for (const callback of [...this.didDestroyCallbacks]) attempt(() => callback(this));
    this.didDestroyCallbacks.clear();
    attempt(() => this.emitter.dispose());
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Unable to release the editor window.");
  }
};
