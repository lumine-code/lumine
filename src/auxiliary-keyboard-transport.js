const { ipcRenderer } = require("electron");
const { EventEmitter } = require("node:events");
const COMMAND_CHANNEL = "lumine:embedded-keyboard-command";

// The shared runtime's IPC identity is the main renderer. Route native frame
// input through the authenticated owner while retaining the child's DOM scope.
module.exports = class AuxiliaryKeyboardTransport extends EventEmitter {
  constructor(service) {
    super();
    this.service = service;
    this.command = (_event, { id, descriptor }) => {
      if (id === service.getId()) this.emit(COMMAND_CHANNEL, null, descriptor);
    };
    ipcRenderer.on("auxiliary-window-keyboard-command", this.command);
    this.focus = service.onDidFocus(() => this.emit("did-focus-window"));
    this.blur = service.onDidBlur(() => this.emit("did-blur-window"));
  }

  sendSync(_channel, snapshot) {
    if (this.service.closed) return { ok: false };
    return ipcRenderer.sendSync(
      "lumine:auxiliary-window-keyboard-state",
      this.service.getId(),
      snapshot,
    );
  }

  dispose() {
    ipcRenderer.removeListener("auxiliary-window-keyboard-command", this.command);
    this.focus.dispose();
    this.blur.dispose();
    this.removeAllListeners();
  }
};
