const VIRTUAL_KEYS = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PrintScreen: 44,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  NumLock: 144,
  ScrollLock: 145,
};
const VIRTUAL_CODES = {
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadEnter: 13,
};
function virtualKeyCode(input) {
  const numpad = /^Numpad([0-9])$/.exec(input.code);
  if (numpad && /^[0-9]$/.test(input.key)) return 96 + Number(numpad[1]);
  if (input.code === "MetaRight") return 92;
  if (VIRTUAL_KEYS[input.key] != null) return VIRTUAL_KEYS[input.key];
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.exec(input.key);
  if (functionKey) return 111 + Number(functionKey[1]);
  if (/^[a-z0-9]$/i.test(input.key)) return input.key.toUpperCase().charCodeAt(0);
  return VIRTUAL_CODES[input.code] || 0;
}

// Native replay must use the focused frame's Chromium input target. Electron's
// WebContents.sendInputEvent targets the root widget, including when an OOPIF
// owns focus, so it cannot restore a suppressed chord into a notebook widget.
module.exports = class NativeFrameInput {
  constructor(contents) {
    this.contents = contents;
    this.debugger = contents.debugger;
    this.sessions = new Map();
    this.ownsConnection = false;
    this.disposed = false;
    this.onDetach = () => {
      this.sessions.clear();
      this.ownsConnection = false;
    };
    this.onMessage = (_event, method, parameters) => {
      if (method !== "Target.detachedFromTarget") return;
      for (const [targetId, sessionId] of this.sessions) {
        if (sessionId === parameters.sessionId) this.sessions.delete(targetId);
      }
    };
    this.debugger?.on("detach", this.onDetach);
    this.debugger?.on("message", this.onMessage);
  }

  connect() {
    if (this.disposed || this.contents.isDestroyed() || !this.debugger) {
      throw new Error("The frame input target is unavailable");
    }
    if (!this.debugger.isAttached()) {
      this.debugger.attach("1.3");
      this.ownsConnection = true;
      this.sessions.clear();
    }
  }

  async inspectFrame(sessionId, frameId, expression) {
    const { executionContextId } = await this.debugger.sendCommand(
      "Page.createIsolatedWorld",
      { frameId, worldName: "lumine-embedded-keyboard", grantUniveralAccess: false },
      sessionId,
    );
    const result = await this.debugger.sendCommand(
      "Runtime.evaluate",
      { expression, contextId: executionContextId, objectGroup: "lumine-embedded-keyboard" },
      sessionId,
    );
    const objectId = result.result?.objectId;
    if (!objectId) throw new Error("The native iframe owner is unavailable");
    try {
      const { node } = await this.debugger.sendCommand("DOM.describeNode", { objectId }, sessionId);
      if (!["IFRAME", "FRAME"].includes(node.nodeName) || !node.frameId) {
        throw new Error("The focused node does not own a frame");
      }
      return node.frameId;
    } finally {
      await this.debugger.sendCommand("Runtime.releaseObject", { objectId }, sessionId);
    }
  }

  async frameSession(frameId, parentSessionId) {
    const targets = await this.debugger.sendCommand("Target.getTargets");
    const info = targets.targetInfos.find((entry) => entry.targetId === frameId);
    if (info?.type !== "iframe") return parentSessionId;
    let sessionId = this.sessions.get(frameId);
    if (!sessionId) {
      ({ sessionId } = await this.debugger.sendCommand("Target.attachToTarget", {
        targetId: frameId,
        flatten: true,
      }));
      this.sessions.set(frameId, sessionId);
    }
    const tree = await this.debugger.sendCommand("Page.getFrameTree", {}, sessionId);
    if (tree.frameTree.frame.id !== frameId) {
      throw new Error("The Chromium input session belongs to another frame");
    }
    return sessionId;
  }

  async context(frame, guard) {
    this.connect();
    const main = this.contents.mainFrame;
    let depth = 0;
    let node = frame;
    while (node !== main) {
      const parent = node?.parent;
      if (!parent || node.isDestroyed() || node.detached || ++depth > 256) {
        throw new Error("The frame input target was removed");
      }
      node = parent;
    }
    const tree = await this.debugger.sendCommand("Page.getFrameTree");
    let frameId = tree.frameTree.frame.id;
    let sessionId;
    // Page.getFrameTree omits OOPIF children. Follow the actual focused owner
    // in pristine isolated worlds instead: duplicate URLs, names and moved
    // DOM nodes cannot select another output's native input target.
    for (let index = 0; index < depth; index++) {
      if (!guard()) throw new Error("The frame input ownership changed");
      frameId = await this.inspectFrame(sessionId, frameId, "document.activeElement");
      sessionId = await this.frameSession(frameId, sessionId);
    }
    if (!guard()) throw new Error("The frame input ownership changed");
    return sessionId;
  }

  async dispatchToSelector(selector, method, parameters, guard) {
    this.connect();
    const tree = await this.debugger.sendCommand("Page.getFrameTree");
    const frameId = await this.inspectFrame(
      undefined,
      tree.frameTree.frame.id,
      "document.querySelector(" + JSON.stringify(selector) + ")",
    );
    const sessionId = await this.frameSession(frameId, undefined);
    if (!guard()) throw new Error("The frame input ownership changed");
    await this.debugger.sendCommand(method, parameters, sessionId);
  }

  async dispatch(frame, method, parameters, guard) {
    const sessionId = await this.context(frame, guard);
    if (!guard()) throw new Error("The frame input ownership changed");
    await this.debugger.sendCommand(method, parameters, sessionId);
  }

  async replay(frame, input, guard) {
    const modifiers =
      (input.alt ? 1 : 0) | (input.control ? 2 : 0) | (input.meta ? 4 : 0) | (input.shift ? 8 : 0);
    const text =
      input.type === "keyDown" &&
      input.key.length === 1 &&
      !input.control &&
      !input.meta &&
      !input.alt
        ? input.key
        : "";
    await this.dispatch(
      frame,
      "Input.dispatchKeyEvent",
      {
        type: input.type === "keyUp" ? "keyUp" : "keyDown",
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: virtualKeyCode(input),
        modifiers,
        autoRepeat: !!input.isAutoRepeat,
        location: input.location > 2 ? 0 : input.location || 0,
        isKeypad: input.location === 3,
        ...(text ? { text, unmodifiedText: text } : {}),
      },
      guard,
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.debugger?.removeListener("detach", this.onDetach);
    this.debugger?.removeListener("message", this.onMessage);
    this.sessions.clear();
    try {
      if (this.ownsConnection && this.debugger?.isAttached()) {
        this.debugger.detach();
      }
    } catch {
      // The window can have disposed its debugger before its destroyed event.
    }
  }
};
