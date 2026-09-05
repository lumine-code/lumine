const TextEditorRegistry = require("../src/text-editor-registry");
const TextEditorFactory = require("../src/text-editor-factory");
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
  let registry, factory, editor, initialPackageActivation;

  beforeEach(function () {
    initialPackageActivation = Promise.resolve();

    registry = new TextEditorRegistry();
    factory = new TextEditorFactory({
      assert: lumine.assert,
      config: lumine.config,
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
    factory.destroy();
  });

  describe(".add", function () {
    it("adds an editor with an explicit role", function () {
      registry.add(editor, { role: "document" });
      expect(registry.roleFor(editor)).toBe("document");
      expect(registry.editors.size).toBe(1);
      expect(registry.editors.has(editor)).toBe(true);
    });

    it("registers an editor with an explicit role", function () {
      registry.add(editor, { role: "fragment" });
      expect(registry.roleFor(editor)).toBe("fragment");
    });

    it("rejects missing and unknown roles", function () {
      expect(() => registry.add(editor)).toThrowError(TypeError);
      expect(() => registry.add(editor, { role: "sidekick" })).toThrowError(TypeError);
    });

    it("rejects values that are not live TextEditors", function () {
      expect(() => registry.add({}, { role: "document" })).toThrowError(TypeError);
      const destroyed = new TextEditor();
      destroyed.destroy();
      expect(() => registry.add(destroyed, { role: "document" })).toThrowError(TypeError);
    });

    it("returns a Disposable that can unregister the editor", function () {
      const disposable = registry.add(editor, { role: "document" });
      expect(registry.editors.size).toBe(1);
      disposable.dispose();
      expect(registry.editors.size).toBe(0);
      expect(registry.roleFor(editor)).toBe(null);
    });

    it("emits did-remove-editor when an editor is unregistered", function () {
      const spy = jasmine.createSpy();
      registry.onDidRemoveEditor(spy);
      const disposable = registry.add(editor, { role: "document" });
      disposable.dispose();
      expect(spy.calls.count()).toBe(1);
      expect(spy.calls.argsFor(0)[0]).toBe(editor);
      disposable.dispose();
      expect(spy.calls.count()).toBe(1);
    });

    it("leases one logical registration to multiple owners", function () {
      const added = jasmine.createSpy();
      const removed = jasmine.createSpy();
      registry.observe(added);
      registry.onDidRemoveEditor(removed);

      const first = registry.add(editor, { role: "fragment" });
      const second = registry.add(editor, { role: "fragment" });
      expect(added.calls.count()).toBe(1);
      expect(registry.getEditors()).toEqual([editor]);

      first.dispose();
      expect(registry.roleFor(editor)).toBe("fragment");
      expect(removed).not.toHaveBeenCalled();
      second.dispose();
      expect(registry.roleFor(editor)).toBeNull();
      expect(removed.calls.count()).toBe(1);
    });

    it("rejects conflicting roles for the same editor", function () {
      registry.add(editor, { role: "document" });
      expect(() => registry.add(editor, { role: "viewer" })).toThrowError(/already registered/);
      expect(registry.roleFor(editor)).toBe("document");
    });

    it("unregisters an editor destroyed synchronously by an observer", function () {
      const removed = jasmine.createSpy();
      registry.onDidRemoveEditor(removed);
      registry.observe((added) => added.destroy());

      const lease = registry.add(editor, { role: "viewer" });

      expect(registry.getEditors()).toEqual([]);
      expect(removed).toHaveBeenCalledWith(editor);
      expect(() => lease.dispose()).not.toThrow();
    });

    it("makes leases from before clear harmless to later registrations", function () {
      const stale = registry.add(editor, { role: "input" });
      registry.clear();
      const current = registry.add(editor, { role: "fragment" });

      stale.dispose();
      expect(registry.roleFor(editor)).toBe("fragment");
      current.dispose();
    });

    it("releases entries and refuses new registrations after destroy", function () {
      const lease = registry.add(editor, { role: "document" });
      registry.destroy();

      expect(registry.getEditors()).toEqual([]);
      expect(() => lease.dispose()).not.toThrow();
      expect(() => registry.add(editor, { role: "document" })).toThrowError(/destroyed/);
    });
  });

  describe(".getEditors", function () {
    it("returns all registered editors", function () {
      const other = new TextEditor({ autoHeight: false });
      registry.add(editor, { role: "document" });
      registry.add(other, { role: "fragment" });
      expect(registry.getEditors()).toEqual([editor, other]);
      other.destroy();
    });
  });

  describe(".observe", function () {
    it("calls the callback for current and future editors until unsubscribed", function () {
      const spy = jasmine.createSpy();
      const [editor1, editor2, editor3] = [new TextEditor(), new TextEditor(), new TextEditor()];
      registry.add(editor1, { role: "document" });
      const subscription = registry.observe(spy);
      expect(spy.calls.count()).toBe(1);

      registry.add(editor2, { role: "viewer" });
      expect(spy.calls.count()).toBe(2);
      expect(spy.calls.argsFor(0)[0]).toBe(editor1);
      expect(spy.calls.argsFor(1)[0]).toBe(editor2);
      subscription.dispose();

      registry.add(editor3, { role: "input" });
      expect(spy.calls.count()).toBe(2);
      editor1.destroy();
      editor2.destroy();
      editor3.destroy();
    });
  });

  describe("TextEditorFactory.build", function () {
    it("constructs a TextEditor with the right parameters based on its path and text", function () {
      lumine.config.set("editor.tabLength", 8);

      const languageMode = {
        grammar: NullGrammar,
        onDidChangeHighlighting: jasmine.createSpy(),
      };

      const buffer = new TextBuffer({ filePath: "test.js" });
      buffer.setLanguageMode(languageMode);

      const editor = factory.build({
        buffer,
      });

      expect(editor.getTabLength()).toBe(8);
      expect(editor.getGrammar()).toEqual(NullGrammar);
      expect(languageMode.onDidChangeHighlighting.calls.count()).toBe(1);
    });
  });

  describe("TextEditorFactory.maintainConfig(editor)", function () {
    it("rejects values that are not live TextEditors", function () {
      expect(() => factory.maintainConfig({})).toThrowError(TypeError);
      const destroyed = new TextEditor();
      destroyed.destroy();
      expect(() => factory.maintainConfig(destroyed)).toThrowError(TypeError);
    });

    it("makes leases from before clear harmless to later maintenance", function () {
      const stale = factory.maintainConfig(editor);
      factory.clear();
      const current = factory.maintainConfig(editor);

      stale.dispose();
      expect(factory.managedEditors.has(editor)).toBe(true);
      current.dispose();
    });

    it("does not update the editor when config settings change for unrelated scope selectors", async function () {
      await lumine.packages.activatePackage("language-javascript");

      const editor2 = new TextEditor();

      lumine.grammars.assignLanguageMode(editor2, "source.js");

      factory.maintainConfig(editor);
      factory.maintainConfig(editor2);
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

      factory.maintainConfig(editor);
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

      factory.maintainConfig(editor);
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

      factory.maintainConfig(editor);
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

      factory.maintainConfig(editor);
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
      const disposable = factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(getSubscriptionCount(editor)).toBeGreaterThan(previousSubscriptionCount);
      expect(factory.managedEditors.size).toBe(1);

      lumine.config.set("editor.fileEncoding", "utf16be");
      expect(editor.getEncoding()).toBe("utf16be");
      lumine.config.set("editor.fileEncoding", "utf8");
      expect(editor.getEncoding()).toBe("utf8");

      disposable.dispose();

      lumine.config.set("editor.fileEncoding", "utf16be");
      expect(editor.getEncoding()).toBe("utf8");
      expect(getSubscriptionCount(editor)).toBe(previousSubscriptionCount);
      expect(retainedEditorCount(factory)).toBe(0);
    });

    it("sets the encoding based on the config", async function () {
      editor.update({ encoding: "utf8" });
      expect(editor.getEncoding()).toBe("utf8");

      lumine.config.set("editor.fileEncoding", "utf16le");
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getEncoding()).toBe("utf16le");

      lumine.config.set("editor.fileEncoding", "utf8");
      expect(editor.getEncoding()).toBe("utf8");
    });

    it("sets the tab length based on the config", async function () {
      editor.update({ tabLength: 4 });
      expect(editor.getTabLength()).toBe(4);

      lumine.config.set("editor.tabLength", 8);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getTabLength()).toBe(8);

      lumine.config.set("editor.tabLength", 4);
      expect(editor.getTabLength()).toBe(4);
    });

    it('enables soft tabs when the tabType config setting is "soft"', async function () {
      lumine.config.set("editor.tabType", "soft");
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftTabs()).toBe(true);
    });

    it('disables soft tabs when the tabType config setting is "hard"', async function () {
      lumine.config.set("editor.tabType", "hard");
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftTabs()).toBe(false);
    });

    describe('when "tabType" is "auto" and content determines indentation', function () {
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
        let disposable = factory.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(true);

        editor.setText(dedent`
          {
          	hello;
          }
        `);

        disposable.dispose();
        disposable = factory.maintainConfig(editor);
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
        disposable = factory.maintainConfig(editor);
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
        disposable = factory.maintainConfig(editor);
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
        factory.maintainConfig(editor);
        expect(editor.getSoftTabs()).toBe(true);
      });
    });

    describe('when "tabType" is "auto" and "softTabs" supplies the fallback', function () {
      it('enables or disables soft tabs based on the "softTabs" config setting', async function () {
        factory.maintainConfig(editor);
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
      factory.maintainConfig(editor);
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
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.hasAtomicSoftTabs()).toBe(false);

      lumine.config.set("editor.atomicSoftTabs", true);
      expect(editor.hasAtomicSoftTabs()).toBe(true);
    });

    it("enables or disables line numbers based on the config", async function () {
      editor.update({ showLineNumbers: true });
      expect(editor.showLineNumbers).toBe(true);

      lumine.config.set("editor.showLineNumbers", false);
      factory.maintainConfig(editor);
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
      factory.maintainConfig(editor);
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
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.isSoftWrapped()).toBe(false);

      lumine.config.set("editor.softWrap", true);
      expect(editor.isSoftWrapped()).toBe(true);
    });

    it("sets the soft wrap indent length based on the config", async function () {
      editor.update({ softWrapHangingIndentLength: 4 });
      expect(editor.getSoftWrapHangingIndentLength()).toBe(4);

      lumine.config.set("editor.softWrapHangingIndent", 2);
      factory.maintainConfig(editor);
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
      factory.maintainConfig(editor);
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
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getSoftWrapColumn()).toBe(500);
    });

    it("sets the preferred line length based on the config", async function () {
      editor.update({ preferredLineLength: 80 });
      expect(editor.getPreferredLineLength()).toBe(80);

      lumine.config.set("editor.preferredLineLength", 110);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getPreferredLineLength()).toBe(110);

      lumine.config.set("editor.preferredLineLength", 80);
      expect(editor.getPreferredLineLength()).toBe(80);
    });

    it("enables or disables auto-indent based on the config", async function () {
      editor.update({ autoIndent: true });
      expect(editor.shouldAutoIndent()).toBe(true);

      lumine.config.set("editor.autoIndent", false);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.shouldAutoIndent()).toBe(false);

      lumine.config.set("editor.autoIndent", true);
      expect(editor.shouldAutoIndent()).toBe(true);
    });

    it("enables or disables auto-indent-on-paste based on the config", async function () {
      editor.update({ autoIndentOnPaste: true });
      expect(editor.shouldAutoIndentOnPaste()).toBe(true);

      lumine.config.set("editor.autoIndentOnPaste", false);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.shouldAutoIndentOnPaste()).toBe(false);

      lumine.config.set("editor.autoIndentOnPaste", true);
      expect(editor.shouldAutoIndentOnPaste()).toBe(true);
    });

    it("enables or disables scrolling past the end of the buffer based on the config", async function () {
      editor.update({ scrollPastEnd: true });
      expect(editor.getScrollPastEnd()).toBe(true);

      lumine.config.set("editor.scrollPastEnd", false);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getScrollPastEnd()).toBe(false);

      lumine.config.set("editor.scrollPastEnd", true);
      expect(editor.getScrollPastEnd()).toBe(true);
    });

    it("sets the undo grouping interval based on the config", async function () {
      editor.update({ undoGroupingInterval: 300 });
      expect(editor.getUndoGroupingInterval()).toBe(300);

      lumine.config.set("editor.undoGroupingInterval", 600);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getUndoGroupingInterval()).toBe(600);

      lumine.config.set("editor.undoGroupingInterval", 300);
      expect(editor.getUndoGroupingInterval()).toBe(300);
    });

    it("sets the scroll sensitivity based on the config", async function () {
      editor.update({ scrollSensitivity: 50 });
      expect(editor.getScrollSensitivity()).toBe(50);

      lumine.config.set("editor.scrollSensitivity", 60);
      factory.maintainConfig(editor);
      await initialPackageActivation;
      expect(editor.getScrollSensitivity()).toBe(60);

      lumine.config.set("editor.scrollSensitivity", 70);
      expect(editor.getScrollSensitivity()).toBe(70);
    });

    describe("when called twice with a given editor", function () {
      it("does nothing the second time", async function () {
        editor.update({ scrollSensitivity: 50 });

        const disposable1 = factory.maintainConfig(editor);
        const disposable2 = factory.maintainConfig(editor);
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
    editor.languageMode.emitter.getTotalListenerCount() +
    editor.buffer.emitter.getTotalListenerCount() +
    editor.displayLayer.emitter.getTotalListenerCount()
  );
}

function retainedEditorCount(factory) {
  return factory.managedEditors.size;
}
