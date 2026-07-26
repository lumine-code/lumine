describe("ide-client package", () => {
  beforeEach(async () => {
    await atom.packages.activatePackage("ide-client");
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage("ide-client");
  });

  it("exposes the versioned language-server service", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const service = main.provideLanguageServer();
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

  it("reports its sessions to the background zone", () => {
    const main = atom.packages.getActivePackage("ide-client").mainModule;
    const entries = new Map();
    const provider = {
      set: (id, entry) => entries.set(id, entry),
      remove: (id) => entries.delete(id),
      dispose() {},
    };
    const session = {
      adapter: { id: "stub", displayName: "Stub Server" },
      rootPath: "/project",
      state: "starting",
    };
    main.manager.sessions.set("stub:/project", session);
    const registration = main.consumeBusySignalBackgroundRegistry({ create: () => provider });
    expect(entries.get("ide-client:stub:/project")).toEqual({
      title: "Stub Server",
      detail: "/project",
      status: "starting",
    });

    // The entry is upserted in place as the server's state changes.
    session.state = "running";
    main.manager.didChangeSession(session);
    expect(entries.get("ide-client:stub:/project").status).toBe("running");

    // A session that goes away takes its entry with it.
    main.manager.sessions.delete("stub:/project");
    main.publishSessions();
    expect(entries.size).toBe(0);
    registration.dispose();
  });

  it("publishes LSP diagnostics through linter-indie", () => {
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
