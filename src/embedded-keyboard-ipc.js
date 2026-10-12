const EmbeddedPaneKeymapBroker = require("./embedded-pane-keymap-broker");
const NativeFrameInput = require("./native-frame-input");

const STATE_CHANNEL = "lumine:embedded-keyboard-state";
const COMMAND_CHANNEL = "lumine:embedded-keyboard-command";
const registries = new WeakMap();

function live(frame) {
  return !!frame && !frame.isDestroyed() && !frame.detached;
}

function frameKey(frame) {
  return frame
    ? [frame.frameTreeNodeId, frame.processId, frame.routingId, frame.frameToken].join(":")
    : null;
}

function outerFrame(frame, main) {
  let current = frame;
  for (let depth = 0; depth < 256; depth++) {
    if (!live(current) || current === main) return null;
    if (current.parent === main) return current;
    current = current.parent;
  }
  return null;
}

class Session {
  constructor(
    contents,
    { testing, createBroker, nativeInput, reportError, isWindowFocused, sendCommand },
  ) {
    this.contents = contents;
    this.testing = testing;
    this.nativeInput = nativeInput || new NativeFrameInput(contents);
    this.reportError = reportError;
    this.isWindowFocused = isWindowFocused;
    this.snapshot = null;
    this.leaf = null;
    this.outer = null;
    this.inputId = 0;
    this.disposed = false;
    this.generation = 0;
    this.replays = [];
    this.flushLane = null;
    this.broker = createBroker({
      dispatch: (descriptor) => {
        if (
          this.ownsFocus() &&
          this.snapshot?.hostId === descriptor.hostId &&
          this.snapshot.revision === descriptor.revision &&
          EmbeddedPaneKeymapBroker.ALLOWED_COMMANDS.has(descriptor.command)
        ) {
          if (sendCommand) sendCommand(descriptor);
          else this.contents.send(COMMAND_CHANNEL, descriptor);
        }
      },
      replay: (input) => {
        if (this.handling) this.handling.push(input);
        else this.queueReplay([input]);
      },
    });
    this.beforeInput = (event, input) => this.handleInput(event, input);
    this.clear = () => {
      this.broker.clear();
      this.snapshot = this.leaf = this.outer = null;
      this.leafKey = this.outerKey = null;
      this.outerId = null;
      this.generation++;
      this.replays.length = 0;
      this.flushLane = null;
    };
    this.onNavigation = (details, _url, inPlace, isMainFrame, processId, routingId) => {
      if (details?.isSameDocument || inPlace) return;
      const navigating = details?.frame;
      if (details?.isMainFrame === true || isMainFrame) {
        this.clear();
        return;
      }
      if (
        (navigating &&
          [this.leaf, this.outer].some(
            (frame) => frame?.frameTreeNodeId === navigating.frameTreeNodeId,
          )) ||
        [this.leaf, this.outer].some(
          (frame) => frame && frame.processId === processId && frame.routingId === routingId,
        )
      ) {
        // Nested iframe load does not reach the workspace document. Keep the
        // trusted outer host's bindings and retire the old document's input.
        this.broker.setSnapshot(this.snapshot);
        this.leaf = this.outer = null;
        this.leafKey = this.outerKey = null;
        this.replays.length = 0;
        this.flushLane = null;
        this.generation++;
      }
    };
    contents.on("before-input-event", this.beforeInput);
    contents.on("render-process-gone", this.clear);
    contents.on("did-start-navigation", this.onNavigation);
  }

  info() {
    const main = this.contents.mainFrame;
    const focused = this.contents.focusedFrame;
    return {
      ok: true,
      focusedFrameId: focused?.frameTreeNodeId ?? null,
      mainFrameId: main?.frameTreeNodeId ?? null,
      isMainFrame: focused === main,
      ...(this.testing
        ? {
            frames: main.framesInSubtree.map((frame) => ({
              id: frame.frameTreeNodeId,
              parentId: frame.parent?.frameTreeNodeId ?? null,
              url: frame.url,
              name: frame.name,
            })),
          }
        : {}),
    };
  }

  ownsFocus() {
    return (
      !this.disposed &&
      !this.contents.isDestroyed() &&
      this.isWindowFocused() &&
      live(this.leaf) &&
      frameKey(this.contents.focusedFrame) === this.leafKey
    );
  }

  update(snapshot) {
    if (snapshot?.type === "focused-frame-info") {
      return this.testing ? this.info() : { ok: false };
    }
    if (!snapshot) {
      this.clear();
      return this.info();
    }
    const focused = this.contents.focusedFrame;
    const outer = outerFrame(focused, this.contents.mainFrame);
    if (snapshot.enabled && !outer && focused !== this.contents.mainFrame) {
      this.clear();
      return { ...this.info(), ok: false };
    }
    if (
      this.snapshot?.hostId === snapshot.hostId &&
      this.snapshot.revision === snapshot.revision &&
      frameKey(focused) === this.leafKey
    ) {
      return this.info();
    }
    if (!this.broker.setSnapshot(snapshot)) {
      this.clear();
      return { ok: false };
    }
    this.replays.length = 0;
    this.flushLane = null;
    this.snapshot = snapshot;
    this.leaf = focused;
    this.outer = outer;
    this.outerId = outer?.frameTreeNodeId ?? null;
    this.leafKey = frameKey(focused);
    this.outerKey = frameKey(outer);
    this.generation++;
    return { ...this.info(), pending: !!snapshot.enabled && !outer };
  }

  handleInput(event, input) {
    if (
      this.disposed ||
      !this.snapshot?.enabled ||
      this.contents.isDestroyed() ||
      !this.isWindowFocused() ||
      !["keyDown", "keyUp"].includes(input?.type)
    ) {
      return;
    }
    if (input.isComposing) {
      this.broker.setSnapshot(this.snapshot);
      this.replays.length = 0;
      this.flushLane = null;
      this.generation++;
      return;
    }
    const focused = this.contents.focusedFrame;
    const outer = outerFrame(focused, this.contents.mainFrame);
    if (!outer) return;
    if (this.outerId == null) this.outerId = outer.frameTreeNodeId;
    if (outer.frameTreeNodeId !== this.outerId) {
      this.clear();
      return;
    }
    if (frameKey(focused) !== this.leafKey || frameKey(outer) !== this.outerKey) {
      // Focus can change between nested children without a focusin event in
      // the parent DOM. Keep the outer host's bindings, retire its old chord.
      this.broker.setSnapshot(this.snapshot);
      this.replays.length = 0;
      this.flushLane = null;
      this.leaf = focused;
      this.leafKey = frameKey(focused);
      this.outer = outer;
      this.outerKey = frameKey(outer);
      this.generation++;
    }
    const descriptor = { ...input, __lumineNativeInputId: ++this.inputId };
    this.handling = [];
    try {
      const prevented = this.broker.handleInput(descriptor);
      const replay = this.handling;
      if (replay.length || this.flushLane || this.replays.length) {
        if (
          !prevented &&
          !replay.some((entry) => entry.__lumineNativeInputId === descriptor.__lumineNativeInputId)
        ) {
          replay.push(descriptor);
        }
        event.preventDefault();
        this.queueReplay(replay);
      } else if (prevented) {
        event.preventDefault();
      }
    } catch (error) {
      this.clear();
      this.reportError(error);
    } finally {
      this.handling = null;
    }
  }

  queueReplay(inputs) {
    if (!inputs.length || !this.ownsFocus()) return;
    const owner = {
      leaf: this.leaf,
      leafKey: this.leafKey,
      generation: this.generation,
      hostId: this.snapshot.hostId,
      revision: this.snapshot.revision,
    };
    for (const input of inputs) this.replays.push({ owner, input });
    if (!this.flushLane) {
      const lane = {};
      this.flushLane = lane;
      void this.flush(lane);
    }
  }

  async flush(lane) {
    try {
      while (this.flushLane === lane && this.replays.length && !this.disposed) {
        const { owner, input } = this.replays.shift();
        const guard = () =>
          this.ownsFocus() &&
          owner.leafKey === this.leafKey &&
          owner.generation === this.generation &&
          this.snapshot?.hostId === owner.hostId &&
          this.snapshot.revision === owner.revision;
        try {
          if (guard()) await this.nativeInput.replay(owner.leaf, input, guard);
        } catch (error) {
          // A completed replay for A must not erase a newer B session or the
          // B keys queued while the obsolete request was still in flight.
          if (this.flushLane !== lane || !guard()) break;
          this.clear();
          this.reportError(error);
          break;
        }
      }
    } finally {
      if (this.flushLane === lane) this.flushLane = null;
    }
  }

  async testInput(request) {
    if (
      !this.testing ||
      !["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"].includes(
        request.method,
      ) ||
      typeof request.selector !== "string" ||
      !request.selector ||
      request.selector.length > 2048 ||
      !request.parameters ||
      typeof request.parameters !== "object"
    ) {
      return { ok: false };
    }
    const guard = () => !this.disposed && !this.contents.isDestroyed();
    await this.nativeInput.dispatchToSelector(
      request.selector,
      request.method,
      request.parameters,
      guard,
    );
    return this.info();
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.contents.removeListener("before-input-event", this.beforeInput);
    this.contents.removeListener("render-process-gone", this.clear);
    this.contents.removeListener("did-start-navigation", this.onNavigation);
    this.nativeInput.dispose();
    this.broker.dispose();
  }
}

module.exports = function attachEmbeddedKeyboardIpc(
  contents,
  {
    ipcMain = require("electron").ipcMain,
    testing = false,
    createBroker = (options) => new EmbeddedPaneKeymapBroker(options),
    nativeInput,
    sendCommand,
    isWindowFocused = () => contents.isFocused(),
    reportError = (error) => console.error("Embedded frame keyboard routing failed", error),
  } = {},
) {
  let registry = registries.get(ipcMain);
  if (!registry) {
    const sessions = new Map();
    const state = (event, snapshot) => {
      const session = sessions.get(event.sender);
      try {
        // A notebook frame must never be able to publish keymaps or request
        // native input. The genuine sender frame is supplied by Electron.
        if (
          !session ||
          event.sender.isDestroyed() ||
          event.senderFrame !== event.sender.mainFrame ||
          event.senderFrame.isDestroyed()
        ) {
          event.returnValue = { ok: false };
          return;
        }
        event.returnValue = session.update(snapshot);
      } catch (error) {
        session?.clear();
        event.returnValue = { ok: false };
        session?.reportError(error);
      }
    };
    const test = async (event, request) => {
      const session = sessions.get(event.sender);
      if (
        !session ||
        event.sender.isDestroyed() ||
        event.senderFrame !== event.sender.mainFrame ||
        event.senderFrame.isDestroyed()
      ) {
        return { ok: false };
      }
      return session.testInput(request);
    };
    ipcMain.on(STATE_CHANNEL, state);
    ipcMain.handle("lumine:embedded-keyboard-test-input", test);
    registry = { sessions, state };
    registries.set(ipcMain, registry);
  }
  const previous = registry.sessions.get(contents);
  previous?.dispose();
  const session = new Session(contents, {
    testing,
    createBroker,
    nativeInput,
    reportError,
    isWindowFocused,
    sendCommand,
  });
  registry.sessions.set(contents, session);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    contents.removeListener("destroyed", dispose);
    session.dispose();
    if (registry.sessions.get(contents) === session) registry.sessions.delete(contents);
    if (!registry.sessions.size) {
      ipcMain.removeListener(STATE_CHANNEL, registry.state);
      ipcMain.removeHandler("lumine:embedded-keyboard-test-input");
      registries.delete(ipcMain);
    }
  };
  contents.once("destroyed", dispose);
  return { dispose, clear: session.clear, update: (snapshot) => session.update(snapshot) };
};

module.exports.STATE_CHANNEL = STATE_CHANNEL;
module.exports.COMMAND_CHANNEL = COMMAND_CHANNEL;
