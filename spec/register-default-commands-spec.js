const { ipcRenderer } = require("electron");
const registerDefaultCommands = require("../src/register-default-commands");
const { SaveConflictedError } = require("../src/pane");
const Config = require("../src/config");

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

  for (const rejected of [false, true]) {
    it(`preserves the ${rejected ? "rejection" : "completion"} of an asynchronous editing command`, async () => {
      const commands = commandsRegisteredOn("win32");
      const [listener] = commands.get("editor:indent");
      const result = rejected
        ? Promise.reject(new Error("Indent failed"))
        : Promise.resolve("indented");
      result.catch(() => {});
      const model = {
        getUndoGroupingInterval: () => 100,
        transact: (_interval, fn) => fn(),
        indent: () => result,
      };
      const actual = listener.didDispatch.call({ getModel: () => model }, { stopPropagation() {} });
      expect(actual).toBe(result);
      if (rejected) await expectAsync(result).toBeRejectedWithError("Indent failed");
      else await expectAsync(result).toBeResolvedTo("indented");
    });
  }

  // Every registration, keyed by command name. A name registered against more
  // than one selector keeps each listener, in registration order, so a spec
  // naming one cannot silently be handed another.
  function commandsRegisteredOn(platform, overrides = {}) {
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
      ...overrides,
    });

    return listenersByName;
  }

  function commandNamesRegisteredOn(platform) {
    return new Set(commandsRegisteredOn(platform).keys());
  }

  it("registers the twenty directional pane operations exactly once with descriptions", () => {
    const commands = commandsRegisteredOn("win32");
    for (const direction of ["up", "down", "left", "right"]) {
      for (const command of [
        `window:focus-pane-${direction}`,
        `pane:move-active-item-${direction}`,
        `pane:copy-active-item-${direction}`,
        `pane:split-${direction}-and-move-active-item`,
        `pane:split-${direction}-and-copy-active-item`,
      ]) {
        expect(commands.get(command).length).toBe(1);
        if (command.startsWith("pane:split-"))
          expect(commands.get(command)[0].description).toBeUndefined();
        else expect(commands.get(command)[0].description).toMatch(/\.$/);
      }
    }
    for (const oldDirection of ["above", "below", "on-left", "on-right"]) {
      expect(commands.has(`window:focus-pane-${oldDirection}`)).toBe(false);
      expect(commands.has(`window:move-active-item-to-pane-${oldDirection}`)).toBe(false);
      expect(commands.has(`window:copy-active-item-to-pane-${oldDirection}`)).toBe(false);
    }
  });

  for (const rejection of [null, "Copy provider failed"]) {
    it(`reports a ${rejection === null ? "null" : "string"} provider rejection at the pane command boundary`, async () => {
      const addError = jasmine.createSpy("addError");
      const commands = commandsRegisteredOn("win32", { notificationManager: { addError } });
      const [listener] = commands.get("pane:split-right-and-copy-active-item");
      const sourcePane = { getActiveItem: () => ({}) };
      const workspace = {
        getActivePane: () => sourcePane,
        copyPaneItem: () => Promise.reject(rejection),
      };
      await expectAsync(listener.didDispatch.call({ getModel: () => workspace })).toBeResolved();
      expect(addError).toHaveBeenCalledWith("Unable to complete the pane operation.", {
        detail: String(rejection),
        dismissable: true,
      });
    });
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

  it("registers Reload All Windows exactly once on every platform and forwards it to the main process", () => {
    const send = spyOn(ipcRenderer, "send");

    for (const platform of ["win32", "linux", "darwin"]) {
      const commands = commandsRegisteredOn(platform);
      const listeners = commands.get("application:reload-all-windows");
      expect(listeners.length).toBe(1);
      const [listener] = listeners;
      const didDispatch = typeof listener === "function" ? listener : listener.didDispatch;

      didDispatch();

      expect(send).toHaveBeenCalledOnceWith("command", "application:reload-all-windows");
      send.calls.reset();
    }
  });

  it("forwards Restart Window in Developer Mode once on every platform without the old command alias", () => {
    const send = spyOn(ipcRenderer, "send");

    for (const platform of ["win32", "linux", "darwin"]) {
      const commands = commandsRegisteredOn(platform);
      const listeners = commands.get("application:restart-window-in-developer-mode");
      expect(listeners.length).toBe(1);
      expect(commands.has("application:reopen-window-in-dev-mode")).toBe(false);
      const [listener] = listeners;
      expect(listener.description).toBe("Restart the current window in developer mode.");

      listener.didDispatch();

      expect(send).toHaveBeenCalledOnceWith(
        "command",
        "application:restart-window-in-developer-mode",
      );
      send.calls.reset();
    }
  });

  it("registers the core commands migrated from Bacadra Tools", () => {
    const commands = commandNamesRegisteredOn("win32");

    expect(commands.has("application:restart-window-in-developer-mode")).toBe(true);
    expect(commands.has("git:update-repositories")).toBe(true);
    expect(commands.has("editor:collapse-blank-lines")).toBe(true);
    expect(commands.has("editor:collapse-content-spaces")).toBe(true);
    expect(commands.has("editor:delete-to-next-line-content")).toBe(true);
  });

  describe("save command outcomes", () => {
    function dispatchSaveWith(result) {
      const commands = commandsRegisteredOn("win32");
      const [listener] = commands.get("core:save");
      const didDispatch = typeof listener === "function" ? listener : listener.didDispatch;
      return didDispatch.call({
        getModel: () => ({ saveActivePaneItem: () => result }),
      });
    }

    it("settles an expected save cancellation at the native command boundary", async () => {
      const cancellation = new SaveConflictedError("Save cancelled due to conflict");

      await expectAsync(dispatchSaveWith(Promise.reject(cancellation))).toBeResolved();
    });

    it("keeps unexpected save failures observable", async () => {
      const error = new Error("disk failed");

      await expectAsync(dispatchSaveWith(Promise.reject(error))).toBeRejectedWith(error);
    });
  });

  describe("core file discovery commands", () => {
    function dispatch(commands, commandName) {
      const [listener] = commands.get(commandName);
      const didDispatch = typeof listener === "function" ? listener : listener.didDispatch;
      return didDispatch();
    }

    it("toggles the shared VCS-ignore policy without refreshing explicitly", () => {
      let excludeVcsIgnoredPaths = true;
      const config = {
        get: jasmine.createSpy("get").and.callFake(() => excludeVcsIgnoredPaths),
        set: jasmine.createSpy("set").and.callFake((_keyPath, value) => {
          excludeVcsIgnoredPaths = value;
          return true;
        }),
      };
      const project = { refreshFilePaths: jasmine.createSpy("refreshFilePaths") };
      const commands = commandsRegisteredOn("win32", { config, project });
      const [listener] = commands.get("core:toggle-vcs-ignored-paths");

      expect(listener.displayName).toBe("Core: Toggle VCS Ignored Paths");
      expect(listener.description).toBe(
        "Include VCS-ignored paths in project discovery, or exclude them again.",
      );
      expect(dispatch(commands, "core:toggle-vcs-ignored-paths")).toBe(true);
      expect(dispatch(commands, "core:toggle-vcs-ignored-paths")).toBe(true);
      expect(config.get.calls.allArgs()).toEqual([
        ["core.excludeVcsIgnoredPaths"],
        ["core.excludeVcsIgnoredPaths"],
      ]);
      expect(config.set.calls.allArgs()).toEqual([
        ["core.excludeVcsIgnoredPaths", false],
        ["core.excludeVcsIgnoredPaths", true],
      ]);
      expect(project.refreshFilePaths).not.toHaveBeenCalled();
    });

    it("toggles the window-local VCS-ignore policy through ordinary config observers", () => {
      const keyPath = "core.excludeVcsIgnoredPaths";
      const save = jasmine.createSpy("save configuration");
      const config = new Config({ mainSource: "config.json", saveCallback: save });
      config.setSchema("core", {
        type: "object",
        properties: { excludeVcsIgnoredPaths: { type: "boolean", default: true } },
      });
      config.resetUserSettings({});
      const observed = [];
      config.observe(keyPath, (value) => observed.push(value));
      const project = { refreshFilePaths: jasmine.createSpy("refreshFilePaths") };
      const commands = commandsRegisteredOn("win32", { config, project });
      const commandName = "core:toggle-local-vcs-ignored-paths";
      const [listener] = commands.get(commandName);

      expect(listener.displayName).toBe("Core: Toggle Local VCS Ignored Paths");
      expect(listener.description).toBe(
        "Include VCS-ignored paths in this window, or exclude them again.",
      );
      expect(dispatch(commands, commandName)).toBe(true);
      expect(config.get(keyPath)).toBe(false);
      expect(config.get(keyPath, { includeLocal: false })).toBe(true);
      expect(observed).toEqual([true, false]);

      expect(dispatch(commands, commandName)).toBe(true);
      expect(config.get(keyPath)).toBe(true);
      expect(config.get(keyPath, { includeLocal: false })).toBe(true);
      expect(observed).toEqual([true, false, true]);
      expect(config.inspect(keyPath).hasLocalOverride).toBe(true);
      advanceClock(10);
      expect(save).not.toHaveBeenCalled();
      expect(project.refreshFilePaths).not.toHaveBeenCalled();
    });

    it("refreshes the shared file index on demand", () => {
      const refresh = Promise.resolve();
      const project = {
        refreshFilePaths: jasmine.createSpy("refreshFilePaths").and.returnValue(refresh),
      };
      const commands = commandsRegisteredOn("win32", { project });
      const [listener] = commands.get("core:refresh-file-index");

      expect(listener.description).toBe(
        "Crawl the project again and update the shared file index.",
      );
      expect(dispatch(commands, "core:refresh-file-index")).toBe(refresh);
      expect(project.refreshFilePaths).toHaveBeenCalledOnceWith();
    });
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
