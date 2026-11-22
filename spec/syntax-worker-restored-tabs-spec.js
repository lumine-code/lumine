const path = require("node:path");
const analysis = require.resolve("./fixtures/syntax-worker-analysis");

describe("Syntax for restored tabs", () => {
  let execution;

  beforeEach(async () => {
    jasmine.useRealClock();
    execution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "inline";
    await lumine.packages.activatePackage("language-javascript");
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(() => {
    for (const editor of lumine.workspace.getTextEditors()) editor.destroy();
    lumine.grammars.syntaxWorkerService?.dispose();
    lumine.grammars.syntaxWorkerService = null;
    lumine.grammars.syntaxExecution = execution;
  });

  async function restoreTabs() {
    const { grammars, project, workspace, deserializers } = lumine;
    const leftPane = workspace.getActivePane();
    const rightPane = leftPane.splitRight({ activate: false });
    const open = async (name, pane) => {
      const filename = path.join(lumine.getConfigDirPath(), `restored-${name}.js`);
      const editor = await workspace.open(filename, { pane, activatePane: false });
      editor.setText(`const ${name} = true;\n`);
      return editor;
    };
    const left = await open("left", leftPane);
    await open("hidden", leftPane);
    await open("right", rightPane);
    leftPane.activateItem(left);
    const projectState = project.serialize({ isUnloading: false });
    const workspaceState = workspace.serialize();
    for (const editor of workspace.getTextEditors()) editor.destroy();

    grammars.syntaxExecution = "worker";
    await project.deserialize(projectState);
    const service = grammars.syntaxWorkerService;
    expect(service.sessions.size).toBe(0);
    expect(service.client).toBeUndefined();
    workspace.deserialize(workspaceState, deserializers);
    const editors = new Map(
      workspace.getTextEditors().map((editor) => [path.basename(editor.getPath()), editor]),
    );
    return [
      editors.get("restored-left.js"),
      editors.get("restored-right.js"),
      editors.get("restored-hidden.js"),
      service,
    ];
  }

  it("opens syntax for the visible editors of both panes and waits for a hidden tab's first display", async () => {
    const [left, right, hidden, service] = await restoreTabs();
    const mode = (editor) => editor.getBuffer().getLanguageMode();
    await conditionPromise(() => Boolean(mode(left).session && mode(right).session));
    expect(service.sessions.size).toBe(2);
    expect(hidden.getGrammar().scopeName).toBe("source.js");
    expect(hidden.getBuffer().getSyntaxSnapshotToken()).toBeNull();
    expect(mode(hidden).getHighlightingStatus().state).toBe("pending");
    expect(mode(hidden).session).toBeUndefined();

    lumine.workspace.paneForItem(hidden).activateItem(hidden);
    await conditionPromise(() => Boolean(mode(hidden).session));
    expect(service.sessions.size).toBe(3);
    expect(await hidden.whenGrammarSettled()).toBeTrue();
    expect(await hidden.analyzeSyntax(analysis, "rootChildren")).toEqual(["const hidden = true;"]);
  });

  it("honors explicit analysis of an edited dormant buffer and uses its latest root ranges", async () => {
    const [left, right, hidden, service] = await restoreTabs();
    await conditionPromise(() =>
      Boolean(
        left.getBuffer().getLanguageMode().session && right.getBuffer().getLanguageMode().session,
      ),
    );
    const buffer = hidden.getBuffer();
    const mode = buffer.getLanguageMode();
    expect(buffer.getText()).toBe("const hidden = true;\n");
    const originalEpoch = mode.getSyntaxRequestEpoch();
    buffer.setPath(path.join(lumine.getConfigDirPath(), "renamed-hidden.js"));
    expect(buffer.getLanguageMode()).toBe(mode);
    expect(mode.getSyntaxRequestEpoch()).not.toBe(originalEpoch);
    buffer.setText("const ignored = false;\nconst updated = true;\n");
    const indentation = Promise.withResolvers();
    hidden.trackIndentation(indentation.promise, mode);
    const obsolete = hidden.analyzeSyntax(analysis, "rootChildren");
    const ranges = lumine.grammars.setRootLanguageRanges(buffer, {
      module: analysis,
      method: "rootRanges",
      params: { prefix: "const updated" },
    });
    try {
      indentation.resolve();
      expect(await obsolete).toBeNull();
      expect(
        await hidden.analyzeSyntax(analysis, "rootChildren", null, { signal: AbortSignal.abort() }),
      ).toBeNull();
      expect(mode.session).toBeUndefined();
      expect(service.sessions.size).toBe(2);
      expect(await hidden.analyzeSyntax(analysis, "rootChildren")).toEqual([
        "const updated = true;",
      ]);
      expect(service.sessions.size).toBe(3);
      expect(buffer.getSyntaxSnapshotToken()).not.toBeNull();
    } finally {
      ranges.dispose();
    }
  });

  it("captures the committed text when a dormant buffer is first queried during a transaction", async () => {
    const [, , hidden, service] = await restoreTabs();
    const buffer = hidden.getBuffer();
    const mode = buffer.getLanguageMode();
    expect(mode.session).toBeUndefined();
    let obsolete;
    buffer.transact(() => {
      buffer.setText("const first = true;\n");
      obsolete = buffer.analyzeSyntax(analysis, "rootChildren");
      buffer.append("const second = true;\n");
    });
    expect(await obsolete).toBeNull();
    expect(await buffer.analyzeSyntax(analysis, "rootChildren")).toEqual([
      "const first = true;",
      "const second = true;",
    ]);
    expect(mode.error).toBeUndefined();
    expect(service.sessions.get(mode.session.id)).toBe(mode.session);
    expect(buffer.getSyntaxSnapshotToken()).not.toBeNull();
  });

  it("closes a dormant restored editor without creating or releasing a worker session", async () => {
    const [left, right, hidden, service] = await restoreTabs();
    await conditionPromise(() =>
      Boolean(
        left.getBuffer().getLanguageMode().session && right.getBuffer().getLanguageMode().session,
      ),
    );
    const release = spyOn(service, "release").and.callThrough();
    hidden.destroy();
    expect(release).not.toHaveBeenCalled();
    expect(service.sessions.size).toBe(2);
  });
});
