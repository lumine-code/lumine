const { EventEmitter } = require("events");
const KeymapManager = require("../src/keymap-manager");
const Bridge = require("../src/embedded-pane-keyboard-bridge");
const PaneContainer = require("../src/pane-container");

describe("embedded pane keyboard renderer bridge", () => {
  let bridge, keymaps, transport, frame, root, registration;
  beforeEach(() => {
    const workspace = lumine.workspace;
    const element = workspace.getElement();
    element.style.width = "800px";
    element.style.height = "500px";
    jasmine.attachToDOM(element);
    spyOn(document, "hasFocus").and.returnValue(true);
    root = document.createElement("div");
    frame = document.createElement("iframe");
    frame.className = "native-frame-test";
    root.appendChild(frame);
    workspace
      .getCenter()
      .getActivePane()
      .activateItem({
        element: root,
        isSingleton: () => true,
        getTitle: () => "Frame Host",
      });
    keymaps = new KeymapManager();
    keymaps.add("frame-test", {
      "lumine-pane": { "alt-up": "window:focus-pane-up" },
      ".native-frame-test": { left: "widget:previous" },
    });
    transport = new EventEmitter();
    transport.sendSync = jasmine.createSpy("state").and.returnValue({
      ok: true,
      focusedFrameId: 123,
      isMainFrame: false,
    });
    bridge = new Bridge({
      keymaps,
      workspace,
      views: lumine.views,
      window,
      document,
      transport,
    });
    keymaps.frameKeyboardBridge = bridge;
    frame.focus();
    bridge.refresh();
  });
  afterEach(() => {
    registration?.dispose();
    registration = null;
    bridge.dispose();
    keymaps.frameKeyboardBridge = null;
    keymaps.destroy();
  });
  const descriptor = () => {
    const selected = bridge.current.bindings.find(
      (entry) => entry.command === "window:focus-pane-up",
    );
    return {
      hostId: bridge.current.hostId,
      revision: bridge.current.revision,
      bindingRank: selected.rank,
      command: selected.command,
      input: { type: "keyDown", key: "ArrowUp", alt: true },
    };
  };

  it("publishes real ancestor scope order with unrelated bindings as blockers", () => {
    expect(document.activeElement).toBe(frame);
    expect(bridge.current).not.toBeNull();
    const snapshot = transport.sendSync.calls.mostRecent().args[1];
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.bindings[0].command).toBe("widget:previous");
    expect(snapshot.bindings[0].depth).toBe(0);
    expect(snapshot.bindings[1].command).toBe("window:focus-pane-up");
    expect(snapshot.bindings[1].depth).toBeGreaterThan(0);
  });

  it("resolves the containing workspace pane past an embedded standalone pane", () => {
    const innerContainer = new PaneContainer({
      config: lumine.config,
      applicationDelegate: lumine.applicationDelegate,
      viewRegistry: lumine.views,
    });
    try {
      const inner = innerContainer.getActivePane();
      const element = inner.getElement();
      root.appendChild(element);
      element.itemViews.moveBefore(frame, null);
      frame.focus();
      bridge.refresh();
      expect(bridge.current?.frame).toBe(frame);
    } finally {
      innerContainer.destroy();
    }
  });

  it("dispatches authenticated current descriptors through the real keymap registry", () => {
    const callback = jasmine.createSpy("command");
    const matched = jasmine.createSpy("matched");
    keymaps.onDidMatchBinding(matched);
    frame.addEventListener("window:focus-pane-up", callback);
    spyOn(keymaps, "dispatchCommandEvent").and.callThrough();
    bridge.dispatch(descriptor());
    expect(callback).toHaveBeenCalledTimes(1);
    expect(keymaps.dispatchCommandEvent).toHaveBeenCalledTimes(1);
    expect(keymaps.dispatchCommandEvent.calls.mostRecent().args[1]).toBe(frame);
    expect(matched).toHaveBeenCalledTimes(1);
    expect(matched.calls.mostRecent().args[0].keyboardEventTarget).toBe(frame);
  });

  it("rejects non-pane commands, old revisions and another host's descriptors", () => {
    spyOn(keymaps, "dispatchCommandEvent");
    const command = descriptor();
    bridge.dispatch({ ...command, command: "core:save" });
    bridge.dispatch({ ...command, revision: command.revision + 1 });
    bridge.dispatch({ ...command, hostId: "other-host" });
    expect(keymaps.dispatchCommandEvent).not.toHaveBeenCalled();
  });

  it("does not interpret child window messages as keyboard commands", () => {
    spyOn(keymaps, "dispatchCommandEvent");
    window.dispatchEvent(
      new MessageEvent("message", { data: descriptor(), source: frame.contentWindow }),
    );
    expect(keymaps.dispatchCommandEvent).not.toHaveBeenCalled();
  });

  it("rejects commands after native focus left the registered frame", () => {
    const command = descriptor();
    const field = document.createElement("input");
    root.appendChild(field);
    field.focus();
    spyOn(keymaps, "dispatchCommandEvent");
    bridge.dispatch(command);
    expect(keymaps.dispatchCommandEvent).not.toHaveBeenCalled();
    expect(bridge.current).toBeNull();
  });

  it("invalidates scope changes and resolver changes before dispatch", () => {
    const command = descriptor();
    spyOn(keymaps, "dispatchCommandEvent");
    keymaps.add("changed", { ".native-frame-test": { "alt-up": "widget:up" } });
    bridge.dispatch(command);
    expect(keymaps.dispatchCommandEvent).not.toHaveBeenCalled();
    const resolver = keymaps.addKeystrokeResolver(() => "x");
    expect(transport.sendSync.calls.mostRecent().args[1].enabled).toBe(false);
    resolver.dispose();
    expect(transport.sendSync.calls.mostRecent().args[1].enabled).toBe(true);
  });

  it("revalidates mutable binding contents before accepting a native descriptor", () => {
    const command = descriptor();
    const selected = bridge.current.bindings.find((entry) => entry.rank === command.bindingRank);
    selected.binding.command = "window:focus-pane-down";
    spyOn(keymaps, "dispatchCommandEvent");
    bridge.dispatch(command);
    expect(keymaps.dispatchCommandEvent).not.toHaveBeenCalled();
    expect(bridge.current.revision).toBeGreaterThan(command.revision);
  });

  it("rearms a loaded active frame with a new revision while leaving inactive loads alone", () => {
    const previous = descriptor();
    frame.dispatchEvent(new Event("load"));
    expect(bridge.current.revision).toBeGreaterThan(previous.revision);
    const revision = bridge.current.revision;
    const other = document.createElement("iframe");
    root.appendChild(other);
    other.dispatchEvent(new Event("load"));
    expect(bridge.current.revision).toBe(revision);
  });

  it("rearms native window focus after main retires an iframe's keyboard context", () => {
    const previous = descriptor();
    transport.emit("did-blur-window");
    expect(bridge.current).toBeNull();
    transport.emit("did-focus-window");
    expect(bridge.current.frame).toBe(frame);
    expect(bridge.current.revision).toBeGreaterThan(previous.revision);
  });

  it("retires explicit host frames before outside-host lifetime retention", () => {
    registration = bridge.registerHost(root);
    const command = descriptor();
    registration.dispose();
    spyOn(keymaps, "dispatchCommandEvent");
    bridge.dispatch(command);
    expect(bridge.current).toBeNull();
    expect(keymaps.dispatchCommandEvent).not.toHaveBeenCalled();
    expect(transport.sendSync.calls.mostRecent().args[1]).toBeNull();
  });
});
