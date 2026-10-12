const { ipcRenderer } = require("electron");
const { Disposable } = require("@lumine-code/event-kit");
const { randomUUID } = require("crypto");
const commands = require("./pane-item-command-definitions");

const STATE_CHANNEL = "lumine:embedded-keyboard-state";
const COMMAND_CHANNEL = "lumine:embedded-keyboard-command";
const ALLOWED_COMMANDS = new Set(Object.keys(commands));

module.exports = class EmbeddedPaneKeyboardBridge {
  constructor({
    keymaps,
    workspace,
    views,
    window,
    document,
    transport = ipcRenderer,
    enabled = true,
    root = workspace.getElement(),
  }) {
    Object.assign(this, { keymaps, workspace, views, window, document, transport });
    this.enabled = enabled;
    this.hosts = new Set();
    this.ids = new WeakMap();
    this.retiredFrames = new WeakSet();
    this.revision = 0;
    this.current = null;
    this.disposed = false;
    this.refreshBound = () => this.refresh();
    this.deferRefresh = () => queueMicrotask(() => this.refresh());
    this.frameLoaded = (event) => {
      if (event.target?.matches?.("iframe") && this.activeFrame() === event.target)
        this.refresh({ force: true });
    };
    this.commandListener = (_event, descriptor) => this.dispatch(descriptor);
    this.nativeFocused = () => this.refresh({ force: true });
    this.nativeBlurred = () => this.clear();
    this.transport.on(COMMAND_CHANNEL, this.commandListener);
    this.transport.on("did-focus-window", this.nativeFocused);
    this.transport.on("did-blur-window", this.nativeBlurred);
    this.document.addEventListener("focusin", this.refreshBound, true);
    this.document.addEventListener("load", this.frameLoaded, true);
    this.window.addEventListener("focus", this.deferRefresh);
    this.window.addEventListener("blur", this.deferRefresh);
    this.observer = new this.window.MutationObserver(this.refreshBound);
    this.observer.observe(this.document.body, { childList: true, subtree: true, attributes: true });
    this.workspaceHost = this.registerHost(root);
  }

  registerHost(root) {
    if (!root || root.ownerDocument !== this.document || root.nodeType !== 1)
      throw new TypeError("A frame host must be an element in this workspace document.");
    if (this.disposed) throw new Error("The embedded keyboard bridge has ended.");
    const host = { root, disposed: false };
    this.hosts.add(host);
    for (const frame of this.framesIn(root)) this.retiredFrames.delete(frame);
    this.refresh();
    return new Disposable(() => {
      if (host.disposed) return;
      host.disposed = true;
      this.hosts.delete(host);
      for (const frame of this.framesIn(root)) this.retiredFrames.add(frame);
      this.refresh();
    });
  }

  framesIn(root) {
    return [...(root.matches("iframe") ? [root] : []), ...root.querySelectorAll("iframe")];
  }

  activeFrame() {
    const frame = this.document.activeElement;
    if (
      (typeof this.document.hasFocus === "function" && !this.document.hasFocus()) ||
      !frame?.matches?.("iframe") ||
      !frame.isConnected ||
      this.retiredFrames.has(frame) ||
      ![...this.hosts].some((host) => !host.disposed && host.root.contains(frame))
    )
      return null;
    const visible = this.workspace.getVisiblePanes();
    let pane;
    for (
      let element = frame.closest("lumine-pane");
      element;
      element = element.parentElement?.closest("lumine-pane")
    ) {
      const candidate = element.getModel?.();
      if (visible.includes(candidate) && !candidate.isDestroyed()) {
        pane = candidate;
        break;
      }
    }
    if (!pane) return null;
    const item = pane.getActiveItem();
    if (!item || this.workspace.paneForItem(item) !== pane) return null;
    const view = this.views.getView(item);
    if (!view?.contains(frame) || frame.getClientRects().length === 0) return null;
    if (this.workspace.getActivePane() !== pane) pane.activate();
    return frame;
  }

  bindingsFor(frame) {
    const output = [];
    let depth = 0;
    for (
      let element = frame;
      element && element !== this.document;
      element = element.parentElement
    ) {
      const matches = this.keymaps
        .getKeyBindings()
        .filter((binding) => element.matches(binding.selector))
        .sort((left, right) => left.compare(right));
      for (const binding of matches)
        output.push({
          command: binding.command,
          keystrokes: binding.keystrokes,
          depth,
          rank: output.length,
          binding,
        });
      depth++;
    }
    return output;
  }

  refresh({ force = false } = {}) {
    if (this.disposed || !this.enabled) return;
    const frame = this.activeFrame();
    if (!frame) {
      this.clear();
      return;
    }
    const bindings = this.bindingsFor(frame);
    const serializable = bindings.map(({ binding: _binding, ...entry }) => entry);
    const enabled =
      this.keymaps.customKeystrokeResolvers.length === 0 &&
      bindings.some((binding) => ALLOWED_COMMANDS.has(binding.command));
    const fingerprint = JSON.stringify([
      enabled,
      this.keymaps.getPartialMatchTimeout(),
      serializable,
    ]);
    if (!force && this.current?.frame === frame && this.current.fingerprint === fingerprint) return;
    let hostId = this.ids.get(frame);
    if (!hostId) {
      hostId = randomUUID();
      this.ids.set(frame, hostId);
    }
    const revision = ++this.revision;
    const snapshot = {
      hostId,
      revision,
      enabled,
      partialMatchTimeout: this.keymaps.getPartialMatchTimeout(),
      bindings: serializable,
    };
    const acknowledgement = this.transport.sendSync(STATE_CHANNEL, snapshot);
    const nativeChild =
      acknowledgement?.isMainFrame === false &&
      Number.isSafeInteger(acknowledgement.focusedFrameId);
    if (!acknowledgement?.ok || (acknowledgement.pending !== true && !nativeChild)) {
      this.current = null;
      return;
    }
    this.current = { frame, hostId, revision, bindings, fingerprint };
  }

  dispatch(descriptor) {
    const current = this.current;
    if (
      this.disposed ||
      !current ||
      descriptor?.hostId !== current.hostId ||
      descriptor.revision !== current.revision ||
      !ALLOWED_COMMANDS.has(descriptor.command) ||
      this.activeFrame() !== current.frame ||
      this.keymaps.customKeystrokeResolvers.length > 0
    )
      return;
    const selected = current.bindings.find((entry) => entry.rank === descriptor.bindingRank);
    const fresh = this.bindingsFor(current.frame);
    if (
      !selected ||
      selected.command !== descriptor.command ||
      fresh.length !== current.bindings.length ||
      fresh.some(
        (entry, index) =>
          entry.binding !== current.bindings[index].binding ||
          entry.depth !== current.bindings[index].depth ||
          entry.command !== current.bindings[index].command ||
          entry.keystrokes !== current.bindings[index].keystrokes,
      )
    ) {
      this.refresh();
      return;
    }
    const input = descriptor.input;
    if (!input || !["keyDown", "keyUp"].includes(input.type)) return;
    const event = new this.window.KeyboardEvent(input.type === "keyDown" ? "keydown" : "keyup", {
      key: input.key,
      code: input.code,
      location: input.location,
      ctrlKey: input.control,
      shiftKey: input.shift,
      altKey: input.alt,
      metaKey: input.meta,
      repeat: input.isAutoRepeat,
      bubbles: true,
      cancelable: true,
    });
    if (this.keymaps.dispatchCommandEvent(descriptor.command, current.frame, event)) {
      this.keymaps.emitter.emit("did-match-binding", {
        keystrokes: descriptor.keystrokes,
        eventType: event.type,
        binding: selected.binding,
        keyboardEventTarget: current.frame,
      });
    }
  }

  clear() {
    if (!this.current) return;
    this.current = null;
    this.transport.sendSync(STATE_CHANNEL, null);
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.hosts.clear();
    this.observer.disconnect();
    this.document.removeEventListener("focusin", this.refreshBound, true);
    this.document.removeEventListener("load", this.frameLoaded, true);
    this.window.removeEventListener("focus", this.deferRefresh);
    this.window.removeEventListener("blur", this.deferRefresh);
    this.transport.removeListener(COMMAND_CHANNEL, this.commandListener);
    this.transport.removeListener("did-focus-window", this.nativeFocused);
    this.transport.removeListener("did-blur-window", this.nativeBlurred);
  }
};
