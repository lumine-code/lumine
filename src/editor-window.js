const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");

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
    this.requestClose = requestClose;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.destroyed = false;
    this.domWindow = null;
    this.element = null;
    editorContainer.editorWindow = this;
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
   * @status public
   *
   * Get this window's workspace command root.
   */
  getElement() {
    return this.element;
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
    return this.emitter.on("will-destroy", callback);
  }

  /**
   * @public
   * @status public
   *
   * Subscribe after the window's presentation is released.
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
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
   * Read the native window's state.
   */
  getState() {
    return this.windowService.getState();
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
    attempt(() => this.emitter.emit("will-destroy", this));
    attempt(() => this.subscriptions.dispose());
    this.element = null;
    this.domWindow = null;
    attempt(() => this.emitter.emit("did-destroy", this));
    attempt(() => this.emitter.dispose());
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Unable to release the editor window.");
  }
};
