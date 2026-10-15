const _ = require("@lumine-code/underscore-plus");
const KeymapManager = require("../src/keymap-manager");
const { keyBindingsForTarget, keyBindingLabelForCommand } = require("../src/key-binding-helpers");

describe("targeted key binding hints", () => {
  let keymaps, workspace, editor;

  beforeEach(() => {
    keymaps = new KeymapManager();
    workspace = document.createElement("div");
    workspace.className = "hint-workspace";
    editor = document.createElement("div");
    editor.className = "hint-editor";
    workspace.append(editor);
    document.querySelector("#jasmine-content").append(workspace);
  });

  afterEach(() => {
    keymaps.destroy();
    workspace.remove();
  });

  function mappings(target = editor) {
    return keyBindingsForTarget(keymaps, target).map(({ keystrokes, command }) => ({
      keystrokes,
      command,
    }));
  }

  it("shows only the local winning command for an ancestor's shortcut", () => {
    keymaps.add("default", {
      ".hint-workspace": { "ctrl-x": "hint:workspace" },
      ".hint-editor": { "ctrl-x": "hint:editor" },
    });

    expect(mappings()).toEqual([{ keystrokes: "ctrl-x", command: "hint:editor" }]);
    expect(keyBindingLabelForCommand(keymaps, "hint:workspace", editor)).toBeUndefined();
    expect(keyBindingLabelForCommand(keymaps, "hint:editor", editor)).toBe(
      _.humanizeKeystroke("ctrl-x"),
    );
  });

  it("respects user overrides, specificity and priority without caching old bindings", () => {
    keymaps.add("default", { ".hint-editor": { "ctrl-x": "hint:default" } });
    const override = keymaps.add("user", { ".hint-editor": { "ctrl-x": "hint:user" } });
    expect(mappings()).toEqual([{ keystrokes: "ctrl-x", command: "hint:user" }]);
    override.dispose();
    expect(mappings()).toEqual([{ keystrokes: "ctrl-x", command: "hint:default" }]);

    keymaps.add("specific", { ".hint-workspace .hint-editor": { "ctrl-x": "hint:specific" } });
    expect(mappings()).toEqual([{ keystrokes: "ctrl-x", command: "hint:specific" }]);
    keymaps.add("priority", { ".hint-editor": { "ctrl-x": "hint:priority" } }, 10);
    expect(mappings()).toEqual([{ keystrokes: "ctrl-x", command: "hint:priority" }]);
  });

  it("lets unset skip local bindings and reveal the ancestor's binding", () => {
    keymaps.add("default", {
      ".hint-workspace": { "ctrl-x": "hint:ancestor" },
      ".hint-editor": { "ctrl-x": "hint:local" },
    });
    keymaps.add("user", { ".hint-editor": { "ctrl-x": "unset!" } });

    expect(mappings()).toEqual([{ keystrokes: "ctrl-x", command: "hint:ancestor" }]);
    const dispatch = spyOn(keymaps, "dispatchCommandEvent").and.returnValue(true);
    keymaps.dispatchKeystroke("ctrl-x", editor, { preventDefault() {} });
    expect(dispatch.calls.mostRecent().args[0]).toBe("hint:ancestor");
  });

  it("suppresses native and abort directives instead of showing an overridden command", () => {
    keymaps.add("default", {
      ".hint-workspace": { "ctrl-x": "hint:cut", "ctrl-v": "hint:paste" },
    });
    keymaps.add("user", { ".hint-editor": { "ctrl-x": "native!", "ctrl-v": "abort!" } });

    expect(mappings()).toEqual([]);
    expect(keyBindingLabelForCommand(keymaps, "hint:cut", editor)).toBeUndefined();
    expect(keyBindingLabelForCommand(keymaps, "hint:paste", editor)).toBeUndefined();
  });

  it("resolves complete chords and suppresses a chord whose prefix is native", () => {
    keymaps.add("default", { ".hint-editor": { "ctrl-k ctrl-x": "hint:original" } });
    keymaps.add("user", { ".hint-editor": { "ctrl-k ctrl-x": "hint:chord" } });
    expect(mappings()).toEqual([{ keystrokes: "ctrl-k ctrl-x", command: "hint:chord" }]);

    const native = keymaps.add("native-prefix", { ".hint-editor": { "ctrl-k": "native!" } });
    expect(mappings()).toEqual([]);
    native.dispose();
    keymaps.add("abort-prefix", { ".hint-editor": { "ctrl-k": "abort!" } });
    expect(mappings()).toEqual([{ keystrokes: "ctrl-k ctrl-x", command: "hint:chord" }]);
  });

  it("scans bindings once without dispatching or changing the pending keyboard sequence", () => {
    keymaps.add("default", { ".hint-editor": { "ctrl-k ctrl-x": "hint:chord" } });
    const find = spyOn(keymaps, "findKeyBindings").and.callThrough();
    const dispatch = spyOn(keymaps, "dispatchCommandEvent");
    const queued = ["ctrl-k"];
    const pending = [];
    keymaps.queuedKeystrokes = queued;
    keymaps.pendingPartialMatches = pending;

    expect(mappings()).toEqual([{ keystrokes: "ctrl-k ctrl-x", command: "hint:chord" }]);
    expect(find).toHaveBeenCalledOnceWith({ target: editor });
    expect(dispatch).not.toHaveBeenCalled();
    expect(keymaps.queuedKeystrokes).toBe(queued);
    expect(keymaps.pendingPartialMatches).toBe(pending);
  });

  it("requires a target for scoped resolution while preserving unscoped tooltip lookup", () => {
    keymaps.add("default", { ".hint-editor": { "ctrl-x": "hint:editor" } });

    expect(keyBindingsForTarget(keymaps, null)).toEqual([]);
    expect(keyBindingsForTarget(keymaps, undefined)).toEqual([]);
    expect(keyBindingsForTarget(keymaps, document)).toEqual([]);
    expect(keyBindingsForTarget(keymaps, window)).toEqual([]);
    expect(keyBindingsForTarget(null, editor)).toEqual([]);
    expect(keyBindingLabelForCommand(keymaps, "hint:editor", null)).toBeUndefined();
    expect(keyBindingLabelForCommand(keymaps, "hint:editor")).toBe(_.humanizeKeystroke("ctrl-x"));
  });
});
