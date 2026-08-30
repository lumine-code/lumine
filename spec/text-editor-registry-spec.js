const TextEditorRegistry = require("../src/text-editor-registry");
const TextEditor = require("../src/text-editor");
const TextBuffer = require("../src/text-buffer");
const { Point, Range } = TextBuffer;
const dedent = require("dedent");
const NullGrammar = require("../src/null-grammar");

function setupLanguageMode(editor) {
  let languageMode = editor.getBuffer().getLanguageMode();
  languageMode.useAsyncParsing = false;
  languageMode.useAsyncIndent = false;
  return languageMode;
}

describe("TextEditorRegistry", function () {
  let registry, editor, initialPackageActivation;

  beforeEach(function () {
    initialPackageActivation = Promise.resolve();

    registry = new TextEditorRegistry({
      assert: lumine.assert,
      config: lumine.config,
      grammarRegistry: lumine.grammars,
      packageManager: {
        getActivatePromise() {
          return initialPackageActivation;
        },
      },
    });

    editor = new TextEditor({ autoHeight: false });
    expect(lumine.grammars.assignLanguageMode(editor, "text.plain.null-grammar")).toBe(true);
  });

  afterEach(function () {
    registry.destroy();
  });

  describe(".add", function () {
    it("adds an editor to the list of registered editors with the document role", function () {
      registry.add(editor);
      expect(editor.registered).toBe("document");
      expect(registry.roleFor(editor)).toBe("document");
      expect(registry.editors.size).toBe(1);
      expect(registry.editors.has(editor)).toBe(true);
    });

    it("registers an editor with an explicit role", function () {
      registry.add(editor, { role: "fragment" });
      expect(editor.registered).toBe("fragment");
      expect(registry.roleFor(editor)).toBe("fragment");
    });

    it("rejects unknown roles", function () {
      expect(() => registry.add(editor, { role: "sidekick" })).toThrowError(TypeError);
    });

    it("returns a Disposable that can unregister the editor", function () {
      const disposable = registry.add(editor);
      expect(registry.editors.size).toBe(1);
      disposable.dispose();
      expect(registry.editors.size).toBe(0);
      expect(editor.registered).toBe(false);
      expect(registry.roleFor(editor)).toBe(null);
      expect(retainedEditorCount(registry)).toBe(0);
    });

    it("emits did-remove-editor when an editor is unregistered", function () {
      const spy = jasmine.createSpy();
      registry.onDidRemoveEditor(spy);
      const disposable = registry.add(editor);
      disposable.dispose();
      expect(spy.calls.count()).toBe(1);
      expect(spy.calls.argsFor(0)[0]).toBe(editor);
      // Removing an unregistered editor emits nothing
      registry.remove(editor);
      expect(spy.calls.count()).toBe(1);
    });
  });

  describe(".getEditors", function () {
    it("returns all registered editors", function () {
      const other = new TextEditor({ autoHeight: false });
      registry.add(editor);
      registry.add(other, { role: "fragment" });
      expect(registry.getEditors()).toEqual([editor, other]);
      other.destroy();
    });
  });

  describe(".getActiveTextEditor", function () {
    it("returns the registered editor containing the DOM focus", function () {
      registry.add(editor);
      const element = editor.getElement();
      jasmine.attachToDOM(element);
      element.focus();
      expect(registry.getActiveTextEditor()).toBe(editor);
    });

    it("returns null when the focused editor is not registered", function () {
      const other = new TextEditor({ autoHeight: false });
      const element = other.getElement();
      jasmine.attachToDOM(element);
      element.focus();
      expect(registry.getActiveTextEditor()).toBe(null);
      other.destroy();
    });

    it("resolves focus from the active detached surface document", function () {
      const frame = document.createElement("iframe");
      jasmine.attachToDOM(frame);
      const element = editor.getElement();
      frame.contentDocument.body.appendChild(element);
      registry.surfaceManager = { getActive: () => ({ document: frame.contentDocument }) };
      registry.add(editor);
      element.focus();

      try {
        expect(registry.getActiveTextEditor()).toBe(editor);
      } finally {
        document.adoptNode(element);
        registry.surfaceManager = null;
        frame.remove();
      }
    });

    it("does not instantiate views of other registered editors", function () {
      registry.add(editor); // never given an element
      expect(editor.component).toBeUndefined();
      registry.getActiveTextEditor();
      expect(editor.component).toBeUndefined();
    });
  });

  describe(".getTextEditorForElement", function () {
    it("resolves a registered editor from a descendant in another Window", function () {
      const frame = document.createElement("iframe");
      jasmine.attachToDOM(frame);
      const element = editor.getElement();
      const descendant = element.ownerDocument.createElement("span");
      element.appendChild(descendant);
      frame.contentDocument.body.appendChild(element);
      registry.add(editor);

      try {
        expect(registry.getTextEditorForElement(descendant)).toBe(editor);
      } finally {
        document.adoptNode(element);
        frame.remove();
      }
    });

    it("rejects non-elements and editors outside the registry", function () {
      const element = editor.getElement();
      expect(registry.getTextEditorForElement(element)).toBeNull();
      expect(registry.getTextEditorForElement(document)).toBeNull();
      expect(registry.getTextEditorForElement(null)).toBeNull();
    });

    it("can exclude registered mini editors", function () {
      const mini = new TextEditor({ mini: true });
      const element = mini.getElement();
      registry.add(mini);

      expect(registry.getTextEditorForElement(element)).toBe(mini);
      expect(registry.getTextEditorForElement(element, { includeMini: false })).toBeNull();
      mini.destroy();
    });
  });

  describe(".observe", function () {
    it("calls the callback for current and future editors until unsubscribed", function () {
      const spy = jasmine.createSpy();
      const [editor1, editor2, editor3] = [{}, {}, {}];
      registry.add(editor1);
      const subscription = registry.observe(spy);
      expect(spy.calls.count()).toBe(1);

      registry.add(editor2);
      expect(spy.calls.count()).toBe(2);
      expect(spy.calls.argsFor(0)[0]).toBe(editor1);
      expect(spy.calls.argsFor(1)[0]).toBe(editor2);
      subscription.dispose();

      registry.add(editor3);
      expect(spy.calls.count()).toBe(2);
    });
  });

  describe(".build", function () {
    it("constructs a TextEditor with the right parameters based on its path and text", function () {
      lumine.config.set("editor.tabLength", 8);

      const languageMode = {
        grammar: NullGrammar,
        onDidChangeHighlighting: jasmine.createSpy(),
      };

      const buffer = new TextBuffer({ filePath: "test.js" });
      buffer.setLanguageMode(languageMode);

      const editor = registry.build({
        buffer,
      });

      expect(editor.getTabLength()).toBe(8);
      expect(editor.getGrammar()).toEqual(NullGrammar);
      expect(languageMode.onDidChangeHighlighting.calls.count()).toBe(1);
    });
  });

  describe(".getActiveTextEditor", function () {
    it("gets the currently focused text editor", function () {
      const disposable = registry.add(editor);
      var editorElement = editor.getElement();
      jasmine.attachToDOM(editorElement);
      editorElement.focus();
      expect(registry.getActiveTextEditor()).toBe(editor);
      disposable.dispose();
    });
  });

  describe(".maintainConfig(editor)", function () {
    it("does not update the editor when config settings change for unrelated scope selectors", async function () {
      await lumine.packages.activatePackage("language-javascript");

      const editor2 = new TextEditor();

      lumine.grammars.assignLanguageMode(editor2, "source.js");

      registry.maintainConfig(editor);
      registry.maintainConfig(editor2);
      await initialPackageActivation;

      expect(editor.getRootScopeDescriptor().getScopesArray()).toEqual(["text.plain.null-grammar"]);
      expect(editor2.getRootScopeDescriptor().getScopesArray()).toEqual(["source.js"]);

      expect(editor.getEncoding()).toBe("utf8");
      expect(editor2.getEncoding()).toBe("utf8");

      lumine.config.set("editor.fileEncoding", "utf16le", {
        scopeSelector: ".text.plain.null-grammar",
      });
      lumine.config.set("editor.fileEncoding", "utf16be", {
        scopeSelector: ".source.js",
      });

      expect(editor.getEncoding()).toBe("utf16le");
      expect(editor2.getEncoding()).toBe("utf16be");
    });

    it("does not update the editor before the initial packages have loaded", async function () {
      let resolveActivatePromise;
      initialPackageActivation = new Promise((resolve) => {
        resolveActivatePromise = resolve;
      });

      lumine.config.set("editor.fileEncoding", "utf16le");

      registry.maintainConfig(editor);
      await Promise.resolve();
      expect(editor.getEncoding()).toBe("utf8");

      lumine.config.set("editor.fileEncoding", "utf16be");
      await Promise.resolve();
      expect(editor.getEncoding()).toBe("utf8");

      resolveActivatePromise();
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf16be");
    });

    it("updates the editor's settings when its grammar changes", async function () {
      await lumine.packages.activatePackage("language-javascript");

      registry.maintainConfig(editor);
      await initialPackageActivation;

      lumine.config.set("editor.fileEncoding", "utf16be", {
        scopeSelector: ".source.js",
      });
      expect(editor.getEncoding()).toBe("utf8");

      lumine.config.set("editor.fileEncoding", "utf16le", {
        scopeSelector: ".source.js",
      });
      expect(editor.getEncoding()).toBe("utf8");

      lumine.grammars.assignLanguageMode(editor, "source.js");
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf16le");

      lumine.config.set("editor.fileEncoding", "utf16be", {
        scopeSelector: ".source.js",
      });
      expect(editor.getEncoding()).toBe("utf16be");

      lumine.grammars.assignLanguageMode(editor, "text.plain.null-grammar");
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf8");
    });

    it("preserves editor settings that haven't changed between previous and current language modes", async function () {
      await lumine.packages.activatePackage("language-javascript");

      registry.maintainConfig(editor);
      await initialPackageActivation;

      expect(editor.getEncoding()).toBe("utf8");
      editor.setEncoding("utf16le");
      expect(editor.getEncoding()).toBe("utf16le");

      expect(editor.isSoftWrapped()).toBe(false);
      editor.setSoftWrapped(true);
      expect(editor.isSoftWrapped()).toBe(true);

      lumine.grammars.assignLanguageMode(editor, "source.js");
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf16le");
      expect(editor.isSoftWrapped()).toBe(true);
    });

    it("updates editor settings that have changed between previous and current language modes", async function () {
      await lumine.packages.activatePackage("language-javascript");

      registry.maintainConfig(editor);
      await initialPackageActivation;

      expect(editor.getEncoding()).toBe("utf8");
      lumine.config.set("editor.fileEncoding", "utf16be", {
        scopeSelector: ".text.plain.null-grammar",
      });
      lumine.config.set("editor.fileEncoding", "utf16le", {
        scopeSelector: ".source.js",
      });
      expect(editor.getEncoding()).toBe("utf16be");

      editor.setEncoding("utf8");
      expect(editor.getEncoding()).toBe("utf8");

      lumine.grammars.assignLanguageMode(editor, "source.js");
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf16le");
    });

    it("returns a disposable that can be used to stop the registry from updating the editor's config", async function () {
      await lumine.packages.activatePackage("language-javascript");

      const previousSubscriptionCount = getSubscriptionCount(editor);
      const disposable = registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(getSubscriptionCount(editor)).toBeGreaterThan(previousSubscriptionCount);
      expect(registry.editorsWithMaintainedConfig.size).toBe(1);

      lumine.config.set("editor.fileEncoding", "utf16be");
      expect(editor.getEncoding()).toBe("utf16be");
      lumine.config.set("editor.fileEncoding", "utf8");
      expect(editor.getEncoding()).toBe("utf8");

      disposable.dispose();

      lumine.config.set("editor.fileEncoding", "utf16be");
      expect(editor.getEncoding()).toBe("utf8");
      expect(getSubscriptionCount(editor)).toBe(previousSubscriptionCount);
      expect(retainedEditorCount(registry)).toBe(0);
    });

    it("sets the encoding based on the config", async function () {
      editor.update({ encoding: "utf8" });
      expect(editor.getEncoding()).toBe("utf8");

      lumine.config.set("editor.fileEncoding", "utf16le");
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf16le");

      lumine.config.set("editor.fileEncoding", "utf8");
      expect(editor.getEncoding()).toBe("utf8");
    });

    it("sets the tab length based on the config", async function () {
      editor.update({ tabLength: 4 });
      expect(editor.getTabLength()).toBe(4);

      lumine.config.set("editor.tabLength", 8);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getTabLength()).toBe(8);

      lumine.config.set("editor.tabLength", 4);
      expect(editor.getTabLength()).toBe(4);
    });

    it('enables soft tabs when the tabType config setting is "soft"', async function () {
      lumine.config.set("editor.tabType", "soft");
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftTabs()).toBe(true);
    });

    it('disables soft tabs when the tabType config setting is "hard"', async function () {
      lumine.config.set("editor.tabType", "hard");
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftTabs()).toBe(false);
    });

    describe('when the "tabType" config setting is "auto"', function () {
      it("enables or disables soft tabs based on the editor's content", async function () {
        await initialPackageActivation;
        await lumine.packages.activatePackage("language-javascript");
        lumine.grammars.assignLanguageMode(editor, "source.js");
        let languageMode = setupLanguageMode(editor);
        lumine.config.set("editor.tabType", "auto");
        await initialPackageActivation;
        await languageMode.ready;

        editor.setText(dedent`
          {
            hello;
          }
        `);
        let disposable = registry.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(true);

        editor.setText(dedent`
          {
          	hello;
          }
        `);

        disposable.dispose();
        disposable = registry.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(false);

        editor.setTextInBufferRange(
          new Range(Point.ZERO, Point.ZERO),
          dedent`
          /*
           * Comment with a leading space.
           */
        ` + "\n",
        );
        disposable.dispose();
        disposable = registry.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(false);

        editor.setText(dedent`
          /*
           * Comment with a leading space.
           */

          {
          	hello;
          }
        `);

        disposable.dispose();
        disposable = registry.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(false);

        editor.setText(dedent`
          /*
           * Comment with a leading space.
           */

          {
            hello;
          }
        `);
        disposable.dispose();
        registry.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(true);
      });
    });

    describe('when the "tabType" config setting is "auto"', function () {
      it('enables or disables soft tabs based on the "softTabs" config setting', async function () {
        registry.maintainConfig(editor);
        await initialPackageActivation;

        editor.setText("abc\ndef");
        lumine.config.set("editor.softTabs", true);
        lumine.config.set("editor.tabType", "auto");
        expect(editor.getSoftTabs()).toBe(true);

        lumine.config.set("editor.softTabs", false);
        expect(editor.getSoftTabs()).toBe(false);
      });
    });

    it("enables or disables soft tabs based on the config", async function () {
      editor.update({ softTabs: true });
      expect(editor.getSoftTabs()).toBe(true);

      lumine.config.set("editor.tabType", "hard");
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftTabs()).toBe(false);

      lumine.config.set("editor.tabType", "soft");
      expect(editor.getSoftTabs()).toBe(true);

      lumine.config.set("editor.tabType", "auto");
      lumine.config.set("editor.softTabs", true);
      expect(editor.getSoftTabs()).toBe(true);
    });

    it("enables or disables atomic soft tabs based on the config", async function () {
      editor.update({ atomicSoftTabs: true });
      expect(editor.hasAtomicSoftTabs()).toBe(true);

      lumine.config.set("editor.atomicSoftTabs", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.hasAtomicSoftTabs()).toBe(false);

      lumine.config.set("editor.atomicSoftTabs", true);
      expect(editor.hasAtomicSoftTabs()).toBe(true);
    });

    it("enables or disables line numbers based on the config", async function () {
      editor.update({ showLineNumbers: true });
      expect(editor.showLineNumbers).toBe(true);

      lumine.config.set("editor.showLineNumbers", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.showLineNumbers).toBe(false);

      lumine.config.set("editor.showLineNumbers", true);
      expect(editor.showLineNumbers).toBe(true);
    });

    it("sets the invisibles based on the config", async function () {
      const invisibles1 = { tab: "a", cr: false, eol: false, space: false };
      const invisibles2 = { tab: "b", cr: false, eol: false, space: false };

      editor.update({
        showInvisibles: true,
        invisibles: invisibles1,
      });
      expect(editor.getInvisibles()).toEqual(invisibles1);

      lumine.config.set("editor.showInvisibles", true);
      lumine.config.set("editor.invisibles", invisibles2);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getInvisibles()).toEqual(invisibles2);

      lumine.config.set("editor.invisibles", invisibles1);
      expect(editor.getInvisibles()).toEqual(invisibles1);

      lumine.config.set("editor.showInvisibles", false);
      expect(editor.getInvisibles()).toEqual({});
    });

    it("enables or disables soft wrap based on the config", async function () {
      editor.update({ softWrapped: true });
      expect(editor.isSoftWrapped()).toBe(true);

      lumine.config.set("editor.softWrap", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.isSoftWrapped()).toBe(false);

      lumine.config.set("editor.softWrap", true);
      expect(editor.isSoftWrapped()).toBe(true);
    });

    it("sets the soft wrap indent length based on the config", async function () {
      editor.update({ softWrapHangingIndentLength: 4 });
      expect(editor.getSoftWrapHangingIndentLength()).toBe(4);

      lumine.config.set("editor.softWrapHangingIndent", 2);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftWrapHangingIndentLength()).toBe(2);

      lumine.config.set("editor.softWrapHangingIndent", 4);
      expect(editor.getSoftWrapHangingIndentLength()).toBe(4);
    });

    it("enables or disables preferred line length-based soft wrap based on the config", async function () {
      editor.update({
        softWrapped: true,
        preferredLineLength: 80,
        editorWidthInChars: 120,
        softWrapAtPreferredLineLength: true,
      });

      expect(editor.getSoftWrapColumn()).toBe(80);

      lumine.config.set("editor.softWrap", true);
      lumine.config.set("editor.softWrapAtPreferredLineLength", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftWrapColumn()).toBe(120);

      lumine.config.set("editor.softWrapAtPreferredLineLength", true);
      expect(editor.getSoftWrapColumn()).toBe(80);
    });

    it("allows for custom definition of maximum soft wrap based on config", async function () {
      editor.update({
        softWrapped: false,
        maxScreenLineLength: 1500,
      });

      expect(editor.getSoftWrapColumn()).toBe(1500);

      lumine.config.set("editor.softWrap", false);
      lumine.config.set("editor.maxScreenLineLength", 500);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftWrapColumn()).toBe(500);
    });

    it("sets the preferred line length based on the config", async function () {
      editor.update({ preferredLineLength: 80 });
      expect(editor.getPreferredLineLength()).toBe(80);

      lumine.config.set("editor.preferredLineLength", 110);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getPreferredLineLength()).toBe(110);

      lumine.config.set("editor.preferredLineLength", 80);
      expect(editor.getPreferredLineLength()).toBe(80);
    });

    it("enables or disables auto-indent based on the config", async function () {
      editor.update({ autoIndent: true });
      expect(editor.shouldAutoIndent()).toBe(true);

      lumine.config.set("editor.autoIndent", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.shouldAutoIndent()).toBe(false);

      lumine.config.set("editor.autoIndent", true);
      expect(editor.shouldAutoIndent()).toBe(true);
    });

    it("enables or disables auto-indent-on-paste based on the config", async function () {
      editor.update({ autoIndentOnPaste: true });
      expect(editor.shouldAutoIndentOnPaste()).toBe(true);

      lumine.config.set("editor.autoIndentOnPaste", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.shouldAutoIndentOnPaste()).toBe(false);

      lumine.config.set("editor.autoIndentOnPaste", true);
      expect(editor.shouldAutoIndentOnPaste()).toBe(true);
    });

    it("enables or disables scrolling past the end of the buffer based on the config", async function () {
      editor.update({ scrollPastEnd: true });
      expect(editor.getScrollPastEnd()).toBe(true);

      lumine.config.set("editor.scrollPastEnd", false);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getScrollPastEnd()).toBe(false);

      lumine.config.set("editor.scrollPastEnd", true);
      expect(editor.getScrollPastEnd()).toBe(true);
    });

    it("sets the undo grouping interval based on the config", async function () {
      editor.update({ undoGroupingInterval: 300 });
      expect(editor.getUndoGroupingInterval()).toBe(300);

      lumine.config.set("editor.undoGroupingInterval", 600);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getUndoGroupingInterval()).toBe(600);

      lumine.config.set("editor.undoGroupingInterval", 300);
      expect(editor.getUndoGroupingInterval()).toBe(300);
    });

    it("sets the scroll sensitivity based on the config", async function () {
      editor.update({ scrollSensitivity: 50 });
      expect(editor.getScrollSensitivity()).toBe(50);

      lumine.config.set("editor.scrollSensitivity", 60);
      registry.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getScrollSensitivity()).toBe(60);

      lumine.config.set("editor.scrollSensitivity", 70);
      expect(editor.getScrollSensitivity()).toBe(70);
    });

    describe("when called twice with a given editor", function () {
      it("does nothing the second time", async function () {
        editor.update({ scrollSensitivity: 50 });

        const disposable1 = registry.maintainConfig(editor);
        const disposable2 = registry.maintainConfig(editor);
        await initialPackageActivation;

        lumine.config.set("editor.scrollSensitivity", 60);
        expect(editor.getScrollSensitivity()).toBe(60);

        disposable2.dispose();
        lumine.config.set("editor.scrollSensitivity", 70);
        expect(editor.getScrollSensitivity()).toBe(70);

        disposable1.dispose();
        lumine.config.set("editor.scrollSensitivity", 80);
        expect(editor.getScrollSensitivity()).toBe(70);
      });
    });
  });
});

function getSubscriptionCount(editor) {
  return (
    editor.emitter.getTotalListenerCount() +
    editor.tokenizedBuffer.emitter.getTotalListenerCount() +
    editor.buffer.emitter.getTotalListenerCount() +
    editor.displayLayer.emitter.getTotalListenerCount()
  );
}

function retainedEditorCount(registry) {
  const editors = new Set();
  for (const e of registry.editors.keys()) {
    editors.add(e);
  }
  registry.editorsWithMaintainedConfig.forEach((e) => editors.add(e));
  return editors.size;
}
