const path = require("node:path");
const Client = require("../src/syntax-worker-client");
const Service = require("../src/syntax-worker-service");
const Mode = require("../src/tree-sitter-worker-language-mode");

describe("Syntax failure containment in the editor", () => {
  let service, editors;
  const module = path.join(__dirname, "fixtures/syntax-worker-analysis.js");
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    editors = [];
    service = new Service(lumine.grammars, {
      clientFactory: () =>
        new Client({
          source: `
          require(${JSON.stringify(require.resolve("../src/tree-sitter-runtime"))}).maximumPages = 512;
          require(${JSON.stringify(require.resolve("../src/syntax-worker-bootstrap"))}).connect(self);
        `,
        }),
    });
  });
  afterEach(() => {
    for (const editor of editors) editor.destroy();
    service.dispose();
  });
  function open(text) {
    const editor = lumine.workspace.buildTextEditor();
    editors.push(editor);
    editor.setText(text);
    editor.getBuffer().setLanguageMode(
      new Mode({
        buffer: editor.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("source.js"),
        service,
      }),
    );
    return editor;
  }

  it("turns real OOM into one warning and unavailable analysis across splits", async () => {
    spyOn(console, "error");
    const warning = spyOn(lumine.notifications, "addWarning").and.callThrough();
    const neighbour = open("const healthy = 1;\n");
    expect(await neighbour.whenGrammarSettled()).toBeTrue();
    const editor = open("const value = [1, 2, 3];\n".repeat(90000));
    const grammar = editor.getGrammar();
    const split = editor.copy();
    editors.push(split);
    const states = [];
    const subscription = split.onDidChangeSyntaxAvailability((state) => states.push(state));
    const pending = editor.analyzeSyntax(module, "summary");
    await conditionPromise(() => !editor.getSyntaxAvailability().available);
    expect(await pending).toBeNull();
    expect(await split.analyzeSyntax(module, "summary")).toBeNull();
    expect(await editor.whenGrammarSettled()).toBeFalse();
    expect(editor.getBuffer().getSyntaxSnapshotToken()).toBeNull();
    expect(editor.getGrammar()).toBe(grammar);
    expect(states.at(-1).failure.code).toBe("memory-limit");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(await neighbour.whenGrammarSettled()).toBeTrue();
    expect((await neighbour.analyzeSyntax(module, "summary")).text).toBe(neighbour.getText());
    editor.setText("const repaired = 2;\n");
    editor.insertText("// still editable\n");
    editor.undo();
    expect(editor.getText()).toBe("const repaired = 2;\n");
    expect(editor.getSyntaxAvailability().available).toBeFalse();
    expect(split.retrySyntaxAnalysis()).toBeTrue();
    expect(await split.whenGrammarSettled()).toBeTrue();
    expect(states.at(-1).available).toBeTrue();
    expect((await editor.analyzeSyntax(module, "summary")).text).toBe(editor.getText());
    expect(warning).toHaveBeenCalledTimes(1);
    subscription.dispose();
  });

  it("cancels an acknowledged stream on failure and leaves package errors observable", async () => {
    const editor = open("const value = 1;\n");
    expect(await editor.whenGrammarSettled()).toBeTrue();
    const mode = editor.getBuffer().getLanguageMode();
    let started;
    const gate = new Promise((resolve) => {
      started = resolve;
    });
    const pending = editor.analyzeSyntax(module, "waitForCancellation", null, { onChunk: started });
    await gate;
    expect(await editor.analyzeSyntax(module, "wasmTrap")).toBeNull();
    expect(await pending).toBeNull();
    expect(editor.getSyntaxAvailability().failure.session).toBe(mode.session.id);
    expect(editor.retrySyntaxAnalysis()).toBeTrue();
    expect(await editor.whenGrammarSettled()).toBeTrue();
    await expectAsync(editor.analyzeSyntax(module, "missingMethod")).toBeRejectedWithError(
      /Unknown syntax analysis/,
    );
    expect(editor.getSyntaxAvailability().available).toBeTrue();
  });

  it("contains worker construction failures without throwing out of editor setup", async () => {
    spyOn(service, "clientFactory").and.throwError("Worker construction failed");
    const warning = spyOn(lumine.notifications, "addWarning").and.callThrough();
    const editor = open("const value = 1;\n");
    expect(await editor.analyzeSyntax(module, "summary")).toBeNull();
    expect(editor.getSyntaxAvailability().failure.message).toBe("Worker construction failed");
    expect(await editor.whenGrammarSettled()).toBeFalse();
    expect(warning).toHaveBeenCalledTimes(1);
    editor.insertText("// editing\n");
    expect(service.clientFactory).toHaveBeenCalledTimes(1);
  });
});
