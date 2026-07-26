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
    const registration = main.consumeIndie(() => delegate);
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
