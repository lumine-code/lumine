const fakeStatusBar = (tiles) => ({
  addRightTile(options) {
    const tile = {
      ...options,
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    };
    tiles.push(tile);
    return tile;
  },
});

describe("ide-client package", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("ide-client");
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("ide-client");
  });

  it("exposes the versioned language-server service", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const service = main.provideIdeClient();
    expect(typeof service.registerAdapter).toBe("function");
    expect(typeof service.sessionForEditor).toBe("function");
    expect(typeof service.applyWorkspaceEdit).toBe("function");
  });

  it("registers its workspace commands", () => {
    const commands = atom.commands.findCommands({ target: atom.views.getView(atom.workspace) });
    expect(commands.map(({ name }) => name)).toContain("ide-client:toggle-problems");
    expect(commands.map(({ name }) => name)).toContain("ide-client:restart");
    expect(commands.map(({ name }) => name)).toContain("ide-client:servers");
  });

  it("satisfies the autocomplete provider contract", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const provider = main.provideAutocomplete();
    // autocomplete rejects a provider outright when these are misnamed, and
    // the rejection is only visible at runtime.
    expect(typeof provider.scopeSelector).toBe("string");
    expect(provider.scopeSelector.length).toBeGreaterThan(0);
    expect(provider.selector).toBeUndefined();
    expect(provider.disableForSelector).toBeUndefined();
    expect(typeof provider.getSuggestions).toBe("function");
  });

  it("consumes a service name that no other provided service nests under", () => {
    const { consumedServices } = atom.packages.getLoadedPackage("ide-client").metadata;
    // A service named "x.y" is stored at the key path ["x"]["y"], so it is
    // also handed to consumers of "x". Consuming both names would receive the
    // wrong value depending on registration order.
    const names = Object.keys(consumedServices);
    for (const name of names) {
      const parent = name.split(".")[0];
      if (parent === name) continue;
      expect(names).not.toContain(parent);
    }
  });

  it("takes only the transient half of busy-signal", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const provider = { add() {}, remove() {}, changeTitle() {}, clear() {}, dispose() {} };
    const registration = main.consumeBusySignal({
      create: () => provider,
      // The running servers have a status item of their own now; asking for a
      // background zone would mean the old mirroring path came back.
      createBackground: () => {
        throw new Error("createBackground must not be called");
      },
    });
    expect(main.manager.busyProvider).toBe(provider);

    // Dropping the service unhooks the manager rather than leaving a stale
    // provider it would keep reporting into.
    registration.dispose();
    expect(main.manager.busyProvider).toBe(null);
  });

  it("adds its status-bar item to the code-intelligence band", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const tiles = [];
    const registration = main.consumeStatusBar(fakeStatusBar(tiles));
    expect(tiles.length).toBe(1);
    // Outside source control (310) on the right panel.
    expect(tiles[0].priority).toBe(250);
    expect(tiles[0].item).toBe(main.serverStatus.element);

    registration.dispose();
    expect(tiles[0].destroyed).toBe(true);
    expect(main.serverStatus).toBe(null);
  });

  it("removes the status-bar item on deactivation", async () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const tiles = [];
    // The disposable consumeStatusBar returns belongs to the status-bar
    // package, so it never fires when this package deactivates.
    main.consumeStatusBar(fakeStatusBar(tiles));
    await atom.packages.deactivatePackage("ide-client");
    expect(tiles[0].destroyed).toBe(true);
  });

  it("publishes LSP diagnostics through linter.registry", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const delegate = {
      batches: [],
      setMessages(filePath, messages) {
        this.batches.push({ filePath, messages });
      },
      dispose() {},
    };
    const registration = main.consumeLinterRegistry(() => delegate);
    const filePath = require("path").resolve("project", "main.ts");
    main.manager.publishDiagnostics(
      {},
      {
        uri: require("url").pathToFileURL(filePath).href,
        diagnostics: [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
            severity: 2,
            message: "Example warning",
          },
        ],
      },
    );
    expect(delegate.batches[0].filePath).toBe(filePath);
    expect(delegate.batches[0].messages[0].severity).toBe("warning");
    registration.dispose();
  });
});
