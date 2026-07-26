const _ = require("@lumine-code/underscore-plus");
const { Emitter, Disposable, CompositeDisposable } = require("event-kit");
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

// Experimental: This global registry tracks registered `TextEditors`.
//
// If you want to add functionality to a wider set of text editors than just
// those appearing within workspace panes, use `atom.textEditors.observe` to
// invoke a callback for all current and future registered text editors.
//
// If you want packages to be able to add functionality to your non-pane text
// editors (such as a search field in a custom user interface element), register
// them for observation via `atom.textEditors.add`. **Important:** When you're
// done using your editor, be sure to call `dispose` on the returned disposable
// to avoid leaking editors.
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

  // Register a `TextEditor`.
  //
  // * `editor` The editor to register.
  // * `options` (optional) {Object}
  //   * `role` (optional) {String} one of `"document"` (default),
  //     `"fragment"`, or `"background"` — see the role description above.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to remove the
  // added editor. To avoid any memory leaks this should be called when the
  // editor is destroyed.
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

  // Remove a `TextEditor`.
  //
  // * `editor` The editor to remove.
  //
  // Returns a {Boolean} indicating whether the editor was successfully removed.
  remove(editor) {
    const removed = this.editors.delete(editor);
    editor.registered = false;
    if (removed) {
      this.emitter.emit("did-remove-editor", editor);
    }
    return removed;
  }

  // Get the role a `TextEditor` was registered with.
  //
  // * `editor` The editor.
  //
  // Returns a {String} role, or `null` if the editor is not registered.
  roleFor(editor) {
    const meta = this.editors.get(editor);
    return meta ? meta.role : null;
  }

  // Get all registered editors.
  //
  // Returns an {Array} of `TextEditor`s.
  getEditors() {
    return Array.from(this.editors.keys());
  }

  // Gets the currently active text editor.
  //
  // The active editor is resolved from the DOM focus upward, so this never
  // touches (or lazily instantiates) the views of other registered editors,
  // and the innermost registered editor wins when editors are nested.
  //
  // Returns the currently active text editor, or `null` if there is none.
  getActiveTextEditor() {
    let element = document.activeElement?.closest?.("atom-text-editor");
    while (element) {
      const editor = typeof element.getModel === "function" ? element.getModel() : null;
      if (editor && this.editors.has(editor)) {
        return editor;
      }
      element = element.parentElement?.closest?.("atom-text-editor");
    }
    return null;
  }

  // Invoke the given callback with all the current and future registered
  // `TextEditors`.
  //
  // * `callback` {Function} to be called with current and future text editors.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observe(callback) {
    for (const editor of this.editors.keys()) {
      callback(editor);
    }
    return this.emitter.on("did-add-editor", callback);
  }

  // Invoke the given callback whenever an editor is removed from the registry.
  //
  // * `callback` {Function} to be called with the removed editor.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveEditor(callback) {
    return this.emitter.on("did-remove-editor", callback);
  }

  // Keep a {TextEditor}'s configuration in sync with Lumine's settings.
  //
  // * `editor` The editor whose configuration will be maintained.
  //
  // Returns a {Disposable} that can be used to stop updating the editor's
  // configuration.
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
