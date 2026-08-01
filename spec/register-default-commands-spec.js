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

  function commandNamesRegisteredOn(platform) {
    Object.defineProperty(process, "platform", { value: platform });

    const commandNames = new Set();
    const commandRegistry = {
      add(_target, commandNameOrCommands) {
        if (typeof commandNameOrCommands === "string") {
          commandNames.add(commandNameOrCommands);
        } else {
          for (const commandName of Object.keys(commandNameOrCommands)) {
            commandNames.add(commandName);
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

    return commandNames;
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
});
