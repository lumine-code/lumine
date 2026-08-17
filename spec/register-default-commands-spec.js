const registerDefaultCommands = require("../src/register-default-commands");

describe("registerDefaultCommands", () => {
  const macOSOnlyCommands = [
    "application:hide",
    "application:hide-other-applications",
    "application:unhide-all-applications",
    "application:bring-all-windows-to-front",
  ];
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  // Every registration, keyed by command name. A name registered against more
  // than one selector keeps each listener, in registration order, so a spec
  // naming one cannot silently be handed another.
  function commandsRegisteredOn(platform) {
    Object.defineProperty(process, "platform", { value: platform });

    const listenersByName = new Map();
    const record = (commandName, listener) => {
      if (!listenersByName.has(commandName)) listenersByName.set(commandName, []);
      listenersByName.get(commandName).push(listener);
    };
    const commandRegistry = {
      // `add(target, name, listener)` and `add(target, commands)` both land
      // here; the second argument says which.
      add(_target, commandNameOrCommands, listener) {
        if (typeof commandNameOrCommands === "string") {
          record(commandNameOrCommands, listener);
        } else {
          for (const [commandName, value] of Object.entries(commandNameOrCommands)) {
            record(commandName, value);
          }
        }
      },
    };

    registerDefaultCommands({
      commandRegistry,
      commandInstaller: {},
      config: {},
      notificationManager: {},
      project: {},
      repositories: {},
      clipboard: {},
    });

    return listenersByName;
  }

  function commandNamesRegisteredOn(platform) {
    return new Set(commandsRegisteredOn(platform).keys());
  }

  it("registers macOS application-management commands only on macOS", () => {
    const macOSCommands = commandNamesRegisteredOn("darwin");
    const windowsCommands = commandNamesRegisteredOn("win32");
    const linuxCommands = commandNamesRegisteredOn("linux");

    for (const commandName of macOSOnlyCommands) {
      expect(macOSCommands.has(commandName)).toBe(true);
      expect(windowsCommands.has(commandName)).toBe(false);
      expect(linuxCommands.has(commandName)).toBe(false);
    }
  });

  it("registers the core commands migrated from Bacadra Tools", () => {
    const commands = commandNamesRegisteredOn("win32");

    expect(commands.has("application:reopen-window-in-dev-mode")).toBe(true);
    expect(commands.has("editor:collapse-blank-lines")).toBe(true);
    expect(commands.has("editor:collapse-content-spaces")).toBe(true);
    expect(commands.has("editor:delete-to-next-line-content")).toBe(true);
  });

  // The wrappers replace each handler with one of their own, so they are the
  // only thing standing between a descriptor written in one of these maps and
  // the registry. A wrapper that returned a bare function would drop the
  // description in silence; one that assumed a bare function would call
  // `.call` on the descriptor object and throw at dispatch.
  describe("the propagation-stopping wrappers", () => {
    // Both wrappers rebind `this` to the model, so the listener is called the
    // way the registry calls it: on the element, which hands back the model.
    function dispatch(listener) {
      const calls = [];
      const model = {
        moveLeft: () => calls.push("moveLeft"),
        splitSelectionsIntoLines: () => calls.push("splitSelectionsIntoLines"),
        getElement: () => ({ copyOnlySelectedText: () => calls.push("copyOnlySelectedText") }),
        getUndoGroupingInterval: () => 0,
        transact: (_interval, fn) => {
          calls.push("transact");
          fn();
        },
      };
      const element = { getModel: () => model };
      const didDispatch = typeof listener === "function" ? listener : listener.didDispatch;

      didDispatch.call(element, { stopPropagation: () => calls.push("stopPropagation") });
      return calls;
    }

    function listenerFor(commandName) {
      const [listener] = commandsRegisteredOn("win32").get(commandName);
      return listener;
    }

    it("leaves a bare handler bare, still stopping propagation on the model", () => {
      const listener = listenerFor("core:move-left");

      expect(typeof listener).toBe("function");
      expect(dispatch(listener)).toEqual(["stopPropagation", "moveLeft"]);
    });

    it("carries a descriptor's metadata through stopEventPropagation", () => {
      const listener = listenerFor("editor:split-selections-into-lines");

      expect(listener.description).toBe(
        "Break each multi-line selection into one selection per line.",
      );
      expect(typeof listener.didDispatch).toBe("function");
      expect(dispatch(listener)).toEqual(["stopPropagation", "splitSelectionsIntoLines"]);
    });

    it("carries a descriptor's metadata through stopEventPropagationAndGroupUndo", () => {
      const listener = listenerFor("editor:copy-selection");

      expect(listener.description).toBe(
        "Copy the selection alone, never the whole line when nothing is selected.",
      );
      expect(typeof listener.didDispatch).toBe("function");
      expect(dispatch(listener)).toEqual(["stopPropagation", "transact", "copyOnlySelectedText"]);
    });
  });
});
