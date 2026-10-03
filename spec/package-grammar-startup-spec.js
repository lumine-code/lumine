const path = require("path");
const fs = require("fs");
const temp = require("@lumine-code/fs-temp").track();
const Package = require("../src/package");
const GrammarRegistry = require("../src/grammar-registry");

describe("Package grammar loading during workspace restoration", () => {
  let pack;
  let grammarRegistry;
  let injectionRegistration;
  let grammarPath;
  const injectionPoint = {
    type: "comment",
    language: () => "todo",
    content: (node) => node,
  };

  const buildPackage = (name) =>
    new Package({
      path: path.join(__dirname, "fixtures", "packages", name),
      metadata: { name },
      bundledPackage: false,
      packageManager: lumine.packages,
      grammarRegistry,
      notificationManager: lumine.notifications,
    });

  beforeEach(() => {
    grammarRegistry = new GrammarRegistry({ config: lumine.config });
    pack = buildPackage("package-with-tree-sitter-grammar");
    grammarPath = path.join(pack.path, "grammars", "some-language.json");
    // Activation publishes service injection points before asynchronous
    // grammar discovery finishes. Workspace restore must keep that grammar.
    pack.grammarsActivated = true;
    injectionRegistration = grammarRegistry.addInjectionPoint("some-language", injectionPoint);
  });

  afterEach(() => {
    injectionRegistration.dispose();
    for (const grammar of pack.grammars) grammar.deactivate();
    grammarRegistry.clear();
  });

  it("keeps the asynchronously loaded grammar and its injections during synchronous restore", async () => {
    await pack.loadGrammars();
    const grammar = grammarRegistry.grammarForId("some-language");
    expect(grammar.injectionPointsByType.comment).toEqual([injectionPoint]);
    expect(pack.grammarsLoaded).toBe(true);
    spyOn(grammarRegistry, "readGrammar");
    await pack.loadGrammars();
    expect(grammarRegistry.readGrammar).not.toHaveBeenCalled();

    // Workspace.deserialize preloads packagesWithActiveGrammars this way.
    pack.loadGrammarsSync();

    expect(pack.grammars).toEqual([grammar]);
    expect(grammarRegistry.grammarForId("some-language")).toBe(grammar);
    expect(grammarRegistry.grammarForId("some-language").injectionPointsByType.comment).toEqual([
      injectionPoint,
    ]);
  });

  it("discards a pending asynchronous read when synchronous restore already loaded its grammar", async () => {
    let finishRead;
    spyOn(pack, "getCachedResourcePaths").and.returnValue([grammarPath]);
    spyOn(grammarRegistry, "readGrammar").and.callFake((_path, callback) => {
      finishRead = callback;
    });
    const pendingGrammar = grammarRegistry.readGrammarSync(grammarPath);
    const load = pack.loadGrammars();
    expect(finishRead).toBeDefined();

    pack.loadGrammarsSync();
    const grammar = grammarRegistry.grammarForId("some-language");
    expect(grammar.injectionPointsByType.comment).toEqual([injectionPoint]);

    finishRead(null, pendingGrammar);
    await load;

    expect(pack.grammarsLoaded).toBe(true);
    expect(pack.grammars).toEqual([grammar]);
    expect(grammarRegistry.grammarForId("some-language")).toBe(grammar);
    expect(grammar.injectionPointsByType.comment).toEqual([injectionPoint]);
  });

  for (const grammarsActivated of [true, false]) {
    const activationState = grammarsActivated ? "active" : "inactive";
    it(`preserves an ${activationState} descriptor already loaded asynchronously during synchronous restore`, async () => {
      injectionRegistration.dispose();
      pack = buildPackage("package-with-grammars");
      pack.grammarsActivated = grammarsActivated;
      injectionRegistration = grammarRegistry.addInjectionPoint("source.alot", injectionPoint);
      const firstPath = path.join(pack.path, "grammars", "alot.json");
      const secondPath = path.join(pack.path, "grammars", "alittle.json");
      const firstGrammar = grammarRegistry.readGrammarSync(firstPath);
      const pendingGrammar = grammarRegistry.readGrammarSync(secondPath);
      let finishRead;
      spyOn(pack, "getCachedResourcePaths").and.returnValue([firstPath, secondPath]);
      spyOn(grammarRegistry, "readGrammar").and.callFake((filePath, callback) => {
        if (filePath === firstPath) callback(null, firstGrammar);
        else finishRead = callback;
      });
      const load = pack.loadGrammars();
      expect(pack.grammars).toEqual([firstGrammar]);
      expect(grammarRegistry.grammarForId("source.alot")).toBe(
        grammarsActivated ? firstGrammar : undefined,
      );

      pack.loadGrammarsSync();
      const secondGrammar = grammarRegistry.grammarForId("source.alittle");
      finishRead(null, pendingGrammar);
      await load;

      expect(pack.grammarsLoaded).toBe(true);
      expect(pack.grammars).toEqual([firstGrammar, secondGrammar]);
      expect(grammarRegistry.grammarForId("source.alot")).toBe(firstGrammar);
      expect(grammarRegistry.grammarForId("source.alittle")).toBe(secondGrammar);
      expect(grammarRegistry.grammarForId("source.alot").injectionPointsByType.comment).toEqual([
        injectionPoint,
      ]);
    });
  }
});

describe("Python TODO injections after workspace restoration", () => {
  let filePath;

  afterEach(() => {
    for (const editor of lumine.workspace.getTextEditors()) {
      if (editor.getPath() === filePath) editor.destroy();
    }
  });

  it("keeps TODO highlighting after restoring an open Python editor and reopening its file", async () => {
    jasmine.useRealClock();
    const packageSource = (name) => {
      const checkout = path.resolve(__dirname, "..", "..", name);
      return fs.existsSync(checkout) ? checkout : name;
    };
    const [pythonPackage] = await Promise.all([
      lumine.packages.activatePackage(packageSource("language-python")),
      lumine.packages.activatePackage(packageSource("language-todo")),
    ]);
    filePath = path.join(temp.mkdirSync("lumine-restored-injections-"), "restore.py");
    fs.writeFileSync(filePath, "# TODO restore\n# FIXME reopen\n");
    const editor = await lumine.workspace.open(filePath);
    await editor.getBuffer().getLanguageMode().atTransactionEnd();
    const pythonGrammar = editor.getGrammar();
    const todoScope = "storage.type.class.todo";
    expect(editor.scopeDescriptorForBufferPosition([0, 3]).getScopesArray()).toContain(todoScope);

    const workspaceState = lumine.workspace.serialize();
    const projectState = lumine.project.serialize({ isUnloading: true });
    expect(workspaceState.packagesWithActiveGrammars).toContain("language-python");
    expect(workspaceState.packagesWithActiveGrammars).toContain("language-todo");
    editor.destroy();
    // Startup activates packages before restoring the project and workspace.
    // Deserialize the buffer too so the restored editor has a new parse tree.
    await lumine.project.deserialize(projectState);
    lumine.workspace.deserialize(workspaceState, lumine.deserializers);
    const restoredEditor = lumine.workspace.getActiveTextEditor();
    expect(restoredEditor.getPath()).toBe(filePath);
    await restoredEditor.getBuffer().getLanguageMode().atTransactionEnd();

    expect(restoredEditor.getGrammar()).toBe(pythonGrammar);
    expect(pythonPackage.grammars).toEqual([pythonGrammar]);
    expect(restoredEditor.scopeDescriptorForBufferPosition([0, 3]).getScopesArray()).toContain(
      todoScope,
    );
    expect(restoredEditor.scopeDescriptorForBufferPosition([1, 3]).getScopesArray()).toContain(
      todoScope,
    );

    restoredEditor.destroy();
    const reopenedEditor = await lumine.workspace.open(filePath);
    await reopenedEditor.getBuffer().getLanguageMode().atTransactionEnd();
    expect(reopenedEditor.getGrammar()).toBe(pythonGrammar);
    expect(reopenedEditor.scopeDescriptorForBufferPosition([0, 3]).getScopesArray()).toContain(
      todoScope,
    );
    expect(reopenedEditor.scopeDescriptorForBufferPosition([1, 3]).getScopesArray()).toContain(
      todoScope,
    );
  });
});
