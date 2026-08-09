const _ = require("@lumine-code/underscore-plus");
const { Emitter, Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const TextEditor = require("./text-editor");
const ScopeDescriptor = require("./scope-descriptor");

const EDITOR_PARAMS_BY_SETTING_KEY = [
  ["editor.fileEncoding", "encoding"],
  ["language.atomicSoftTabs", "atomicSoftTabs"],
  ["language.showInvisibles", "showInvisibles"],
  ["language.tabLength", "tabLength"],
  ["editor.invisibles", "invisibles"],
  ["editor.showLineNumbers", "showLineNumbers"],
  ["language.softWrap", "softWrapped"],
  ["language.softWrapHangingIndent", "softWrapHangingIndentLength"],
  ["language.softWrapAtPreferredLineLength", "softWrapAtPreferredLineLength"],
  ["editor.softWrapDebounceInterval", "softWrapDebounceInterval"],
  ["language.preferredLineLength", "preferredLineLength"],
  ["editor.maxScreenLineLength", "maxScreenLineLength"],
  ["language.autoIndent", "autoIndent"],
  ["language.autoIndentOnPaste", "autoIndentOnPaste"],
  ["editor.scrollPastEnd", "scrollPastEnd"],
  ["editor.undoGroupingInterval", "undoGroupingInterval"],
  ["editor.scrollSensitivity", "scrollSensitivity"],
  ["editor.smoothScrolling", "smoothScrolling"],
  ["editor.wheelSmoothness", "wheelSmoothness"],
  ["editor.commandSmoothness", "commandSmoothness"],
  ["editor.altWheelMultiplier", "altWheelMultiplier"],
  ["editor.scrollCommandDistance", "scrollCommandDistance"],
];

// The role of a registered editor describes how it relates to the user's
// documents, so cross-editor features (completion sourcing, linting, …) can
// treat it appropriately:
//
// - "document": a standalone document editor — workspace pane items and
//   embedded editors that hold complete content of their own. The default.
// - "fragment": a piece of a larger, composite document — a notebook cell, a
//   watch expression, a REPL input. Fragments share context with the other
//   open editors.
// - "background": an infrastructure editor mirroring content the user works
//   on through another view (e.g. the JSON source backing a notebook).
//   Registered so configuration and services apply, but excluded from
//   cross-editor features like completion sourcing.
const ROLES = new Set(["document", "fragment", "background"]);

// Public: The global registry of every {TextEditor} in the window, available as
// `lumine.textEditors`.
//
// {Workspace} holds the editors that are pane items; this registry holds all of
// them, including the ones a package builds for its own interface — a search
// field, a notebook cell, a REPL prompt. Reach for it when a feature should
// apply to editors wherever they are rather than only to open files.
//
// ## Observing every editor
//
// {::observe} calls back with every editor that is registered now and every one
// registered later:
//
// ```js
// lumine.textEditors.observe(editor => {
//   // every editor in the window, not just the ones in panes
// })
// ```
//
// ## Registering your own
//
// A package that embeds an editor registers it so everyone else's features
// reach it too. **Dispose of the returned {Disposable} when the editor goes
// away**, or the registry keeps it alive:
//
// ```js
// const editor = lumine.workspace.buildTextEditor({ mini: true })
// const registration = lumine.textEditors.add(editor, { role: 'fragment' })
// // …later
// registration.dispose()
// ```
//
// ## Roles
//
// The `role` an editor is registered with says how it relates to the user's
// documents, so a cross-editor feature can tell them apart:
//
// * `"document"` — a standalone document: a pane item, or an embedded editor
//   holding complete content of its own. The default.
// * `"fragment"` — a piece of a larger composite document: a notebook cell, a
//   watch expression, a REPL input. Fragments share context with the editors
//   around them.
// * `"background"` — an infrastructure editor mirroring content the user works
//   on through another view, such as the JSON source behind a notebook. It is
//   registered so configuration and services apply to it, but cross-editor
//   features like completion sourcing leave it alone.
module.exports = class TextEditorRegistry {
  constructor({ config, assert, grammarRegistry, packageManager }) {
    this.config = config;
    this.assert = assert;
    this.grammarRegistry = grammarRegistry;
    this.packageManager = packageManager;
    this.clear();
  }

  clear() {
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }

    this.subscriptions = new CompositeDisposable();
    this.editors = new Map(); // editor -> { role }
    this.emitter = new Emitter();
    this.scopesWithConfigSubscriptions = new Set();
    this.editorsWithMaintainedConfig = new Set();
  }

  destroy() {
    this.subscriptions.dispose();
    this.editorsWithMaintainedConfig = null;
  }

  /*
  Section: Registering Editors
  */

  // Essential: Register a {TextEditor}, so that features written against the
  // registry reach it.
  //
  // * `editor` The {TextEditor} to register.
  // * `options` (optional) {Object}
  //   * `role` (optional) {String} one of `"document"` (the default),
  //     `"fragment"` or `"background"`. See {TextEditorRegistry} for what each
  //     one means.
  //
  // Throws a {TypeError} if `role` is not one of those three.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to remove the
  // editor again. Call it when the editor is destroyed, or the registry holds
  // the editor alive.
  add(editor, { role = "document" } = {}) {
    if (!ROLES.has(role)) {
      throw new TypeError(`Unknown text editor role: ${role}`);
    }
    this.editors.set(editor, { role });
    editor.registered = role;
    this.emitter.emit("did-add-editor", editor);

    return new Disposable(() => this.remove(editor));
  }

  build(params) {
    params = Object.assign({ assert: this.assert }, params);

    let scope = null;
    if (params.buffer) {
      const { grammar } = params.buffer.getLanguageMode();
      if (grammar) {
        scope = new ScopeDescriptor({ scopes: [grammar.scopeName] });
      }
    }

    Object.assign(params, this.textEditorParamsForScope(scope));

    return new TextEditor(params);
  }

  // Public: Remove a {TextEditor} from the registry.
  //
  // Disposing the {Disposable} that {::add} returned does this for you; call it
  // directly only when you no longer hold that disposable.
  //
  // * `editor` The {TextEditor} to remove.
  //
  // Returns a {Boolean}: `true` if the editor was registered, `false` if it was
  // not.
  remove(editor) {
    const removed = this.editors.delete(editor);
    editor.registered = false;
    if (removed) {
      this.emitter.emit("did-remove-editor", editor);
    }
    return removed;
  }

  // Public: Get the role a {TextEditor} was registered with.
  //
  // Use it to tell a document apart from a notebook cell or a background
  // mirror before applying a cross-editor feature to it.
  //
  // * `editor` The {TextEditor} to look up.
  //
  // Returns a {String} role, or `null` if the editor is not registered.
  roleFor(editor) {
    const meta = this.editors.get(editor);
    return meta ? meta.role : null;
  }

  /*
  Section: Accessing Editors
  */

  // Public: Get every registered editor.
  //
  // This is a snapshot. Use {::observe} to keep up with editors registered
  // later.
  //
  // Returns an {Array} of {TextEditor}s.
  getEditors() {
    return Array.from(this.editors.keys());
  }

  // Essential: Get the editor the user is typing in, wherever it is.
  //
  // Unlike {Workspace::getActiveTextEditor} this sees editors that are not pane
  // items — a search field, a notebook cell — which is usually what a command
  // bound to the window should act on.
  //
  // The answer is resolved outward from the focused element, so it never
  // touches (or lazily builds) the views of other registered editors, and the
  // innermost registered editor wins when editors are nested.
  //
  // Returns a {TextEditor}, or `null` if focus is not in one.
  getActiveTextEditor() {
    let element = document.activeElement?.closest?.("lumine-text-editor");
    while (element) {
      const editor = typeof element.getModel === "function" ? element.getModel() : null;
      if (editor && this.editors.has(editor)) {
        return editor;
      }
      element = element.parentElement?.closest?.("lumine-text-editor");
    }
    return null;
  }

  /*
  Section: Event Subscription
  */

  // Essential: Invoke the given callback with every registered editor, now and
  // in the future.
  //
  // The callback runs synchronously for each editor already registered, then
  // again for each one registered afterwards.
  //
  // * `callback` {Function} to be called with each {TextEditor}.
  //   * `editor` The {TextEditor}.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observe(callback) {
    for (const editor of this.editors.keys()) {
      callback(editor);
    }
    return this.emitter.on("did-add-editor", callback);
  }

  // Public: Invoke the given callback when an editor is removed from the
  // registry.
  //
  // The counterpart to {::observe}: anything that attached state to an editor
  // when it arrived can release it here.
  //
  // * `callback` {Function} to be called with each removed {TextEditor}.
  //   * `editor` The {TextEditor} that was removed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveEditor(callback) {
    return this.emitter.on("did-remove-editor", callback);
  }

  /*
  Section: Configuration
  */

  // Public: Keep a {TextEditor}'s settings in sync with the user's.
  //
  // Applies the settings that match the editor's language now, and keeps
  // applying them as the user changes a setting or the editor's language mode
  // changes — soft wrap, tab length, invisibles, scroll behaviour and the rest.
  // An editor built by {Workspace::buildTextEditor} is already maintained; call
  // this for one you constructed yourself.
  //
  // A setting the user has overridden on this editor is left alone when the
  // language changes, so switching grammar does not undo their choice.
  //
  // Calling it twice for the same editor is a no-op.
  //
  // * `editor` The {TextEditor} whose configuration will be maintained.
  //
  // Returns a {Disposable} that stops updating the editor's configuration.
  maintainConfig(editor) {
    if (this.editorsWithMaintainedConfig.has(editor)) {
      return new Disposable(noop);
    }
    this.editorsWithMaintainedConfig.add(editor);

    this.updateAndMonitorEditorSettings(editor);
    const languageChangeSubscription = editor.buffer.onDidChangeLanguageMode(
      (newLanguageMode, oldLanguageMode) => {
        this.updateAndMonitorEditorSettings(editor, oldLanguageMode);
      },
    );
    this.subscriptions.add(languageChangeSubscription);

    const updateTabTypes = () => {
      const configOptions = { scope: editor.getRootScopeDescriptor() };
      editor.setSoftTabs(
        shouldEditorUseSoftTabs(
          editor,
          this.config.get("language.tabType", configOptions),
          this.config.get("language.softTabs", configOptions),
        ),
      );
    };

    updateTabTypes();
    const tokenizeSubscription = editor.onDidTokenize(updateTabTypes);
    this.subscriptions.add(tokenizeSubscription);

    return new Disposable(() => {
      this.editorsWithMaintainedConfig.delete(editor);
      tokenizeSubscription.dispose();
      languageChangeSubscription.dispose();
      this.subscriptions.remove(languageChangeSubscription);
      this.subscriptions.remove(tokenizeSubscription);
    });
  }

  // Deprecated: set a {TextEditor}'s grammar based on its path and content,
  // and continue to update its grammar as grammars are added or updated, or
  // the editor's file path changes.
  //
  // * `editor` The editor whose grammar will be maintained.
  //
  // Returns a {Disposable} that can be used to stop updating the editor's
  // grammar.
  maintainGrammar(editor) {
    return this.grammarRegistry.maintainLanguageMode(editor.getBuffer());
  }

  // Deprecated: Force a {TextEditor} to use a different grammar than the
  // one that would otherwise be selected for it.
  //
  // * `editor` The editor whose grammar will be set.
  // * `languageId` The {String} language ID for the desired {Grammar}.
  setGrammarOverride(editor, languageId) {
    this.grammarRegistry.assignLanguageMode(editor.getBuffer(), languageId);
  }

  // Deprecated: Retrieve the grammar scope name that has been set as a
  // grammar override for the given {TextEditor}.
  //
  // * `editor` The editor.
  //
  // Returns a {String} scope name, or `null` if no override has been set
  // for the given editor.
  getGrammarOverride(editor) {
    return this.grammarRegistry.getAssignedLanguageId(editor.getBuffer());
  }

  // Deprecated: Remove any grammar override that has been set for the given {TextEditor}.
  //
  // * `editor` The editor.
  clearGrammarOverride(editor) {
    this.grammarRegistry.autoAssignLanguageMode(editor.getBuffer());
  }

  async updateAndMonitorEditorSettings(editor, oldLanguageMode) {
    await this.packageManager.getActivatePromise();
    // The editor may have been un-maintained or the registry destroyed while
    // waiting for package activation.
    if (!this.editorsWithMaintainedConfig || !this.editorsWithMaintainedConfig.has(editor)) {
      return;
    }
    this.updateEditorSettingsForLanguageMode(editor, oldLanguageMode);
    this.subscribeToSettingsForEditorScope(editor);
  }

  updateEditorSettingsForLanguageMode(editor, oldLanguageMode) {
    const newLanguageMode = editor.buffer.getLanguageMode();

    if (oldLanguageMode) {
      const newSettings = this.textEditorParamsForScope(newLanguageMode.rootScopeDescriptor);
      const oldSettings = this.textEditorParamsForScope(oldLanguageMode.rootScopeDescriptor);

      const updatedSettings = {};
      for (const [, paramName] of EDITOR_PARAMS_BY_SETTING_KEY) {
        // Update the setting only if it has changed between the two language
        // modes.  This prevents user-modified settings in an editor (like
        // 'softWrapped') from being reset when the language mode changes.
        if (!_.isEqual(newSettings[paramName], oldSettings[paramName])) {
          updatedSettings[paramName] = newSettings[paramName];
        }
      }

      if (_.size(updatedSettings) > 0) {
        editor.update(updatedSettings);
      }
    } else {
      editor.update(this.textEditorParamsForScope(newLanguageMode.rootScopeDescriptor));
    }
  }

  subscribeToSettingsForEditorScope(editor) {
    const scopeDescriptor = editor.getRootScopeDescriptor();
    const scopeChain = scopeDescriptor.getScopeChain();

    if (!this.scopesWithConfigSubscriptions.has(scopeChain)) {
      this.scopesWithConfigSubscriptions.add(scopeChain);
      const configOptions = { scope: scopeDescriptor };

      for (const [settingKey, paramName] of EDITOR_PARAMS_BY_SETTING_KEY) {
        this.subscriptions.add(
          this.config.onDidChange(settingKey, configOptions, ({ newValue }) => {
            this.editorsWithMaintainedConfig.forEach((editor) => {
              if (editor.getRootScopeDescriptor().isEqual(scopeDescriptor)) {
                editor.update({ [paramName]: newValue });
              }
            });
          }),
        );
      }

      const updateTabTypes = () => {
        const tabType = this.config.get("language.tabType", configOptions);
        const softTabs = this.config.get("language.softTabs", configOptions);
        this.editorsWithMaintainedConfig.forEach((editor) => {
          if (editor.getRootScopeDescriptor().isEqual(scopeDescriptor)) {
            editor.setSoftTabs(shouldEditorUseSoftTabs(editor, tabType, softTabs));
          }
        });
      };

      this.subscriptions.add(
        this.config.onDidChange("language.tabType", configOptions, updateTabTypes),
        this.config.onDidChange("language.softTabs", configOptions, updateTabTypes),
      );
    }
  }

  textEditorParamsForScope(scopeDescriptor) {
    const result = {};
    const configOptions = { scope: scopeDescriptor };
    for (const [settingKey, paramName] of EDITOR_PARAMS_BY_SETTING_KEY) {
      result[paramName] = this.config.get(settingKey, configOptions);
    }
    return result;
  }
};

function shouldEditorUseSoftTabs(editor, tabType, softTabs) {
  switch (tabType) {
    case "hard":
      return false;
    case "soft":
      return true;
    case "auto":
      switch (editor.usesSoftTabs()) {
        case true:
          return true;
        case false:
          return false;
        default:
          return softTabs;
      }
  }
}

function noop() {}
