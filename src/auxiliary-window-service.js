const { Emitter } = require("@lumine-code/event-kit");

// Renderer-side controller of one native auxiliary presentation. All requests
// travel through the owning environment's authenticated application delegate.
module.exports = class AuxiliaryWindowService {
  constructor(applicationDelegate, descriptor) {
    this.applicationDelegate = applicationDelegate;
    this.id = descriptor.id;
    this.persistentId = descriptor.persistentId;
    this.state = descriptor.state;
    this.emitter = new Emitter();
    this.subscription = applicationDelegate.onAuxiliaryWindowEvent(({ id, type, state }) => {
      if (id === this.id) {
        if (type === "closed") this.closed = true;
        if (state) this.state = state;
        this.emitter.emit(type);
      }
    });
  }

  getId() {
    return this.id;
  }
  invoke(action, ...args) {
    return this.applicationDelegate.invokeAuxiliaryWindow("invoke", this.id, action, ...args);
  }
  getState() {
    return this.invoke("getState");
  }
  focus() {
    return this.invoke("focus");
  }
  show() {
    return this.invoke("show");
  }
  hide() {
    return this.invoke("hide");
  }
  minimize() {
    return this.invoke("minimize");
  }
  maximize() {
    return this.invoke("maximize");
  }
  unmaximize() {
    return this.invoke("unmaximize");
  }
  isMaximized() {
    return this.invoke("isMaximized");
  }
  isFullScreen() {
    return this.invoke("isFullScreen");
  }
  isVisible() {
    return this.invoke("isVisible");
  }
  getPosition() {
    return this.invoke("getPosition");
  }
  getSize() {
    return this.invoke("getSize");
  }
  setBounds(bounds) {
    return this.invoke("setBounds", bounds);
  }
  setFullScreen(value) {
    return this.invoke("setFullScreen", value);
  }
  setRepresentedFilename(filename) {
    return this.invoke("setRepresentedFilename", filename);
  }
  setTitle(title) {
    return this.invoke("setTitle", title);
  }
  setSheetOffset(value) {
    return this.invoke("setSheetOffset", value);
  }
  showSaveDialog(options) {
    return this.invoke("showSaveDialog", options);
  }
  confirm(options) {
    return this.invoke("confirm", options);
  }
  openDevTools() {
    return this.invoke("openDevTools");
  }
  toggleDevTools() {
    return this.invoke("toggleDevTools");
  }
  closeDevTools() {
    return this.invoke("closeDevTools");
  }
  close() {
    if (this.closed) return Promise.resolve();
    return this.invoke("close");
  }
  onDidFocus(callback) {
    return this.emitter.on("focus", callback);
  }
  onDidBlur(callback) {
    return this.emitter.on("blur", callback);
  }
  onDidMaximize(callback) {
    return this.emitter.on("maximize", callback);
  }
  onDidUnmaximize(callback) {
    return this.emitter.on("unmaximize", callback);
  }
  onDidEnterFullScreen(callback) {
    return this.emitter.on("enter-full-screen", callback);
  }
  onDidLeaveFullScreen(callback) {
    return this.emitter.on("leave-full-screen", callback);
  }
  onDidRequestClose(callback) {
    return this.emitter.on("close-requested", callback);
  }
  onDidClose(callback) {
    return this.emitter.on("closed", callback);
  }
  onDidResize(callback) {
    return this.emitter.on("resize", callback);
  }
  onDidMove(callback) {
    return this.emitter.on("move", callback);
  }

  destroy() {
    this.subscription.dispose();
    this.emitter.dispose();
  }
};
