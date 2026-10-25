const fs = require("@lumine-code/fs-plus");
const Environment = require("../src/environment");
const GrammarRegistry = require("../src/grammar-registry");
const NullLanguageMode = require("../src/null-language-mode");
const TextBuffer = require("../src/text-buffer");

describe("Large file grammar policy", () => {
  const megabyte = 1048576;
  let fileSize;
  let actualGetSize;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of ["language-javascript", "language-text"]) {
      const pkg = await lumine.packages.activatePackage(name);
      await pkg.resourceLoadPromise;
    }
    fileSize = 100 * megabyte;
    actualGetSize = fs.getSizeSync.bind(fs);
    spyOn(fs, "getSizeSync").and.callFake((filePath) =>
      filePath?.endsWith("sample.js") ? fileSize : actualGetSize(filePath),
    );
    spyOn(lumine.applicationDelegate, "confirm").and.resolveTo(0);
  });

  const warning = () =>
    lumine.notifications
      .getNotifications()
      .find((notification) => notification.getMessage() === "Large file opened without a grammar");

  it("keeps separate 40 MB opening and 100 MB grammar defaults", () => {
    expect(lumine.config.get("core.warnOnLargeFileLimit")).toBe(40);
    expect(lumine.config.get("core.grammarLoadLimit")).toBe(100);
  });

  it("selects None before creating any syntax mode at the grammar limit", async () => {
    const createMode = spyOn(lumine.grammars, "languageModeForGrammarAndBuffer").and.callThrough();
    const editor = await lumine.workspace.open("sample.js");

    expect(lumine.applicationDelegate.confirm).toHaveBeenCalledTimes(1);
    expect(editor.getGrammar()).toBe(lumine.grammars.nullGrammar);
    expect(editor.getBuffer().getLanguageMode().constructor).toBe(NullLanguageMode);
    expect(createMode).not.toHaveBeenCalled();
    expect(lumine.grammars.getAssignedLanguageId(editor.getBuffer())).toBe(
      lumine.grammars.nullGrammar.scopeName,
    );
    expect(warning().getType()).toBe("warning");
    expect(warning().getDetail()).toContain("100.0 MB");
    const count = lumine.notifications.getNotifications().length;
    const split = lumine.workspace.buildTextEditor({ buffer: editor.getBuffer() });
    try {
      editor.insertText("// still editable\n");
      expect(split.getGrammar()).toBe(lumine.grammars.nullGrammar);
      expect(lumine.notifications.getNotifications().length).toBe(count);
      expect(createMode).not.toHaveBeenCalled();
    } finally {
      split.destroy();
    }
  });

  it("parses files below the grammar limit after opening confirmation", async () => {
    fileSize--;
    const editor = await lumine.workspace.open("sample.js");
    expect(lumine.applicationDelegate.confirm).toHaveBeenCalledTimes(1);
    expect(editor.getGrammar().scopeName).toBe("source.js");
    expect(warning()).toBeUndefined();
  });

  it("does not load or register a file refused at the opening gate", async () => {
    lumine.applicationDelegate.confirm.and.resolveTo(1);
    const load = spyOn(TextBuffer, "load").and.callThrough();
    expect(await lumine.workspace.open("sample.js")).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(lumine.project.getBuffers()).toEqual([]);
    expect(warning()).toBeUndefined();
  });

  it("enables and saves the detected grammar only when requested", async () => {
    const editor = await lumine.workspace.open("sample.js");
    const notification = warning();
    notification.getOptions().buttons[0].onDidClick();
    expect(editor.getGrammar().scopeName).toBe("source.js");
    expect(lumine.grammars.serialize().languageOverridesByBufferId[editor.getBuffer().id]).toBe(
      "source.js",
    );
    expect(notification.isDismissed()).toBe(true);
    await editor.getBuffer().getLanguageMode().ready;
  });

  it("allows an explicit Auto Detect choice to enable syntax", async () => {
    const editor = await lumine.workspace.open("sample.js");
    const notification = warning();
    lumine.grammars.autoAssignLanguageMode(editor.getBuffer());
    expect(editor.getGrammar().scopeName).toBe("source.js");
    expect(notification.isDismissed()).toBe(true);
  });

  it("can disable the grammar size limit independently of the opening warning", async () => {
    lumine.config.set("core.grammarLoadLimit", 0);
    const editor = await lumine.workspace.open("sample.js");
    expect(lumine.applicationDelegate.confirm).toHaveBeenCalledTimes(1);
    expect(editor.getGrammar().scopeName).toBe("source.js");
    expect(warning()).toBeUndefined();
  });

  it("keeps None across path changes and newly available grammars", async () => {
    const editor = await lumine.workspace.open("sample.js");
    const buffer = editor.getBuffer();
    buffer.setPath(`${buffer.getPath()}.txt`);
    lumine.grammars.loadGrammarSync(require.resolve("./fixtures/grammars/plain-text.json"));
    expect(editor.getGrammar()).toBe(lumine.grammars.nullGrammar);
    expect(lumine.grammars.getAssignedLanguageId(buffer)).toBe(
      lumine.grammars.nullGrammar.scopeName,
    );
  });

  it("dismisses the enabling action when its buffer is destroyed", async () => {
    const editor = await lumine.workspace.open("sample.js");
    const notification = warning();
    editor.destroy();
    expect(notification.isDismissed()).toBe(true);
    expect(() => notification.getOptions().buttons[0].onDidClick()).not.toThrow();
  });

  it("also limits buffers loaded directly through the project", async () => {
    const buffer = await lumine.project.bufferForPath(lumine.project.resolvePath("sample.js"));
    expect(buffer.getLanguageMode().constructor).toBe(NullLanguageMode);
    expect(warning()).toBeDefined();
    expect(lumine.applicationDelegate.confirm).not.toHaveBeenCalled();
  });

  for (const languageId of ["text.plain.null-grammar", "source.js"]) {
    it(`restores an explicit ${languageId} before assigning any automatic grammar`, async () => {
      const editor = await lumine.workspace.open("sample.js");
      lumine.grammars.assignLanguageMode(editor, languageId);
      const state = lumine.serialize();
      const restored = new Environment({
        applicationDelegate: lumine.applicationDelegate,
        enablePersistence: false,
      });
      restored.initialize({ document, window });
      try {
        const pkg = await restored.packages.activatePackage("language-javascript");
        await pkg.resourceLoadPromise;
        const createMode = spyOn(
          restored.grammars,
          "languageModeForGrammarAndBuffer",
        ).and.callThrough();
        await restored.deserialize(state);
        const buffer = restored.workspace.getActiveTextEditor().getBuffer();
        expect(buffer.getLanguageMode().getGrammar().scopeName).toBe(languageId);
        if (languageId === "text.plain.null-grammar") expect(createMode).not.toHaveBeenCalled();
        else
          expect(
            createMode.calls.allArgs().every(([grammar]) => grammar.scopeName === languageId),
          ).toBe(true);
        expect(
          restored.notifications
            .getNotifications()
            .some((item) => item.getMessage() === "Large file opened without a grammar"),
        ).toBe(false);
      } finally {
        restored.uninstallUncaughtErrorHandler();
        restored.destroy();
      }
    });
  }

  it("does not send the None sentinel to the syntax worker grammar catalogue", () => {
    expect(lumine.grammars.nullGrammar.name).toBe("None");
    expect(lumine.grammars.getGrammars()).not.toContain(lumine.grammars.nullGrammar);
    const registry = new GrammarRegistry({ config: lumine.config });
    try {
      expect(registry.grammarForId("text.plain.null-grammar")).toBe(lumine.grammars.nullGrammar);
    } finally {
      registry.clear();
    }
  });
});
