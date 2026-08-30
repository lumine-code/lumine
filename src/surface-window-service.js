const { Emitter, CompositeDisposable } = require("@lumine-code/event-kit");

// Renderer-side handle for one explicit detached-pane window transaction. It
// owns no pane or workspace state; callers commit only after their model move
// and DOM mount have both succeeded, or cancel to tear the hidden window down.
module.exports = class SurfaceWindowService {
  static async reserve(applicationDelegate, options = {}) {
    const transaction = await applicationDelegate.reserveDetachedPaneWindow(options);
    return new SurfaceWindowService(applicationDelegate, transaction);
  }

  constructor(applicationDelegate, transaction) {
    this.applicationDelegate = applicationDelegate;
    this.transactionId = transaction.transactionId;
    this.id = transaction.surfaceId;
    this.frameName = transaction.frameName;
    this.url = transaction.url;
    this.state = transaction.state;
    this.domWindow = null;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable(
      applicationDelegate.onDidReceiveDetachedPaneWindowEvent((surfaceId, eventName, detail) => {
        if (surfaceId !== this.id) return;
        this.state = detail?.state || (eventName === "closed" ? "closed" : this.state);
        this.emitter.emit(eventName, detail);
      }),
    );
  }

  open(opener = window) {
    if (this.domWindow && !this.domWindow.closed) return this.domWindow;
    if (!["reserved", "accepted", "created", "ready"].includes(this.state)) {
      throw new Error(`Cannot open a detached-pane window in state '${this.state}'`);
    }
    const domWindow = opener.open(
      this.url,
      this.frameName,
      "frame=false,nodeIntegration=no,contextIsolation=no,webviewTag=no",
    );
    if (!domWindow) throw new Error("The detached-pane window was rejected");
    this.domWindow = domWindow;
    return domWindow;
  }

  whenDocumentReady() {
    const domWindow = this.domWindow;
    if (!domWindow) throw new Error("The detached-pane window has not been opened");
    if (domWindow.location.href === this.url && domWindow.document.readyState === "complete") {
      return Promise.resolve(domWindow.document);
    }
    return new Promise((resolve, reject) => {
      const closedSubscription = this.onDidClose(() => {
        closedSubscription.dispose();
        reject(new Error("The detached-pane window closed before its document loaded"));
      });
      const loaded = () => {
        closedSubscription.dispose();
        resolve(domWindow.document);
      };
      domWindow.addEventListener("load", loaded, { once: true });
    });
  }

  async perform(operation, ...args) {
    const result = await this.applicationDelegate.performDetachedPaneWindowTransaction(
      this.transactionId,
      operation,
      ...args,
    );
    if (result?.state) this.state = result.state;
    if (["cancel", "attach", "close-accepted", "dispose"].includes(operation)) {
      this.state = "closed";
    }
    return result;
  }

  ready() {
    return this.perform("ready");
  }

  commit() {
    return this.perform("commit");
  }

  cancel() {
    return this.perform("cancel");
  }

  attach() {
    return this.perform("attach");
  }

  closeAccepted() {
    return this.perform("close-accepted");
  }

  closeCancelled() {
    return this.perform("close-cancelled");
  }

  requestClose() {
    return this.perform("request-close");
  }

  focus() {
    return this.perform("focus");
  }

  minimize() {
    return this.perform("minimize");
  }

  maximize() {
    return this.perform("maximize");
  }

  unmaximize() {
    return this.perform("unmaximize");
  }

  setBounds(bounds) {
    return this.perform("set-bounds", bounds);
  }

  show() {
    return this.perform("show");
  }

  getState() {
    return this.perform("get-state");
  }

  setTitle(title) {
    return this.perform("set-title", title);
  }

  setDocumentEdited(edited) {
    return this.perform("set-document-edited", Boolean(edited));
  }

  setRepresentedFilename(filePath) {
    return this.perform("set-represented-filename", filePath || "");
  }

  confirm(options) {
    return this.perform("confirm", options);
  }

  showSaveDialog(options) {
    return this.perform("show-save-dialog", options);
  }

  toggleDevTools() {
    return this.perform("toggle-dev-tools");
  }

  performWebContentsAction(action) {
    return this.perform("web-contents-action", action);
  }

  showContextMenu(requestId, template) {
    return this.perform("show-context-menu", requestId, template);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      try {
        if (["reserved", "accepted"].includes(this.state)) await this.cancel();
        else if (this.state !== "closed") await this.perform("dispose");
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  onDidRequestClose(callback) {
    return this.emitter.on("close-requested", callback);
  }

  onDidClose(callback) {
    return this.emitter.on("closed", callback);
  }

  onDidFocus(callback) {
    return this.emitter.on("focus", callback);
  }

  onDidBlur(callback) {
    return this.emitter.on("blur", callback);
  }

  onDidChangeState(callback) {
    return this.emitter.on("state-changed", callback);
  }

  destroy() {
    this.subscriptions.dispose();
    this.emitter.dispose();
    this.domWindow = null;
  }
};
