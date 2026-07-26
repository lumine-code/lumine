const path = require("path");
const { conditionPromise, timeoutPromise, waitForAutocomplete } = require("./spec-helper");

describe("Autocomplete Manager trigger characters", () => {
  let editor, editorView, mainModule, provider;

  const registerProvider = (triggerCharacters) => {
    provider = {
      scopeSelector: "*",
      inclusionPriority: 2,
      excludeLowerPriority: true,
      triggerCharacters,
      requests: [],
      getSuggestions(options) {
        this.requests.push(options);
        return [{ text: "log" }, { text: "logGroup" }];
      },
    };
    mainModule.consumeAutocomplete(provider);
  };

  beforeEach(async () => {
    atom.workspace.project.setPaths([path.join(__dirname, "fixtures")]);
    jasmine.useRealClock();
    atom.config.set("autocomplete.autoActivationDelay", 0);
    atom.config.set("editor.fontSize", "16");
    jasmine.attachToDOM(atom.views.getView(atom.workspace));

    editor = await atom.workspace.open("");
    editorView = atom.views.getView(editor);
    mainModule = (await atom.packages.activatePackage("autocomplete")).mainModule;
    await conditionPromise(
      () => mainModule.autocompleteManager && mainModule.autocompleteManager.ready,
    );
  });

  describe("when suggestions on keystroke are off", () => {
    beforeEach(() => atom.config.set("autocomplete.enableAutoActivation", false));

    it("opens the list on a character the provider declared", async () => {
      registerProvider(new Set(["."]));

      editor.insertText("console");
      await timeoutPromise(200);
      expect(editorView.querySelectorAll(".autocomplete li").length).toBe(0);

      editor.insertText(".");
      await waitForAutocomplete(editor);
    });

    it("leaves the list closed on a character no provider declared", async () => {
      registerProvider(new Set(["."]));

      editor.insertText(":");
      await timeoutPromise(200);
      expect(editorView.querySelectorAll(".autocomplete li").length).toBe(0);
      expect(provider.requests.length).toBe(0);
    });

    it("leaves the list closed when the provider declares nothing", async () => {
      registerProvider(undefined);

      editor.insertText(".");
      await timeoutPromise(200);
      expect(editorView.querySelectorAll(".autocomplete li").length).toBe(0);
      expect(provider.requests.length).toBe(0);
    });

    it("re-reads the declared characters rather than snapshotting them", async () => {
      const characters = new Set();
      registerProvider(characters);

      editor.insertText(".");
      await timeoutPromise(200);
      expect(provider.requests.length).toBe(0);

      // A language server advertises its trigger characters only once it has
      // started, well after the provider was registered.
      characters.add(".");
      editor.insertText(".");
      await waitForAutocomplete(editor);
    });
  });

  describe("the request it makes", () => {
    beforeEach(() => atom.config.set("autocomplete.enableAutoActivation", true));

    it("reports the trigger character and its kind", async () => {
      registerProvider(new Set(["."]));

      editor.insertText("l");
      await waitForAutocomplete(editor);
      expect(provider.requests[0].triggerKind).toBe(1);
      expect(provider.requests[0].triggerCharacter).toBeNull();

      editor.insertText(".");
      await conditionPromise(() => provider.requests.length > 1);
      const request = provider.requests[provider.requests.length - 1];
      expect(request.triggerKind).toBe(2);
      expect(request.triggerCharacter).toBe(".");
    });

    it("reports an invocation when the menu is asked for by hand", async () => {
      atom.config.set("autocomplete.enableAutoConfirmSingleSuggestion", false);
      registerProvider(new Set(["."]));

      editor.insertText(".");
      await waitForAutocomplete(editor);
      expect(provider.requests[0].triggerKind).toBe(2);

      atom.commands.dispatch(editorView, "autocomplete:activate");
      await conditionPromise(() => provider.requests.length > 1);
      const request = provider.requests[provider.requests.length - 1];
      expect(request.triggerKind).toBe(1);
      expect(request.triggerCharacter).toBeNull();
    });
  });
});
