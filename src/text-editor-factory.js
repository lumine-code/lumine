const _ = require("@lumine-code/underscore-plus");
const { Disposable, CompositeDisposable } = require("@lumine-code/event-kit");
const TextEditor = require("./text-editor");
const ScopeDescriptor = require("./scope-descriptor");

const EDITOR_PARAMS_BY_SETTING_KEY = [
  ["editor.fileEncoding", "encoding"],
  ["editor.atomicSoftTabs", "atomicSoftTabs"],
  ["editor.showInvisibles", "showInvisibles"],
  ["editor.tabLength", "tabLength"],
  ["editor.invisibles", "invisibles"],
  ["editor.showLineNumbers", "showLineNumbers"],
  ["editor.softWrap", "softWrapped"],
  ["editor.softWrapHangingIndent", "softWrapHangingIndentLength"],
  ["editor.softWrapAtPreferredLineLength", "softWrapAtPreferredLineLength"],
  ["editor.softWrapDebounceInterval", "softWrapDebounceInterval"],
  ["editor.preferredLineLength", "preferredLineLength"],
  ["editor.maxScreenLineLength", "maxScreenLineLength"],
  ["editor.autoIndent", "autoIndent"],
  ["editor.autoIndentOnPaste", "autoIndentOnPaste"],
  ["editor.scrollPastEnd", "scrollPastEnd"],
  ["editor.undoGroupingInterval", "undoGroupingInterval"],
  ["editor.scrollSensitivity", "scrollSensitivity"],
  ["editor.smoothScrolling", "smoothScrolling"],
  ["editor.wheelSmoothness", "wheelSmoothness"],
  ["editor.commandSmoothness", "commandSmoothness"],
  ["editor.altWheelMultiplier", "altWheelMultiplier"],
  ["editor.scrollCommandDistance", "scrollCommandDistance"],
];

// Constructs TextEditor models and owns their scoped configuration lifecycle.
// Registration is deliberately separate: a detached model can be configured
// without participating in the window until its owner exposes it.
module.exports = class TextEditorFactory {
  constructor({ config, assert, packageManager }) {
    this.config = config;
    this.assert = assert;
    this.packageManager = packageManager;
    this.destroyed = false;
    this.subscriptions = new CompositeDisposable();
    this.scopesWithConfigSubscriptions = new Set();
    this.managedEditors = new Map();
  }

  clear() {
    if (this.destroyed) return;
    for (const entry of [...this.managedEditors.values()]) this.removeEntry(entry);
    this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();
    this.scopesWithConfigSubscriptions = new Set();
    this.managedEditors = new Map();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of [...this.managedEditors.values()]) this.removeEntry(entry);
    this.subscriptions.dispose();
  }

  build(params) {
    if (this.destroyed) throw new Error("Cannot build a TextEditor after its factory is destroyed");
    params = Object.assign({ assert: this.assert }, params);

    let scope = null;
    if (params.buffer) {
      const { grammar } = params.buffer.getLanguageMode();
      if (grammar) scope = new ScopeDescriptor({ scopes: [grammar.scopeName] });
    }
    Object.assign(params, this.textEditorParamsForScope(scope));
    return new TextEditor(params);
  }

  maintainConfig(editor) {
    if (this.destroyed) {
      throw new Error("Cannot maintain a TextEditor after its factory is destroyed");
    }
    if (!(editor instanceof TextEditor) || editor.isDestroyed()) {
      throw new TypeError("Configuration maintenance requires a live TextEditor");
    }

    let entry = this.managedEditors.get(editor);
    if (!entry) {
      entry = {
        editor,
        leases: new Set(),
        subscriptions: new CompositeDisposable(),
      };
      this.managedEditors.set(editor, entry);
      entry.subscriptions.add(editor.onDidDestroy(() => this.removeEntry(entry)));
      this.updateAndMonitorEditorSettings(entry);
      entry.subscriptions.add(
        editor.buffer.onDidChangeLanguageMode((newLanguageMode, oldLanguageMode) => {
          this.updateAndMonitorEditorSettings(entry, oldLanguageMode);
        }),
      );

      const updateTabTypes = () => {
        const configOptions = { scope: editor.getRootScopeDescriptor() };
        editor.setSoftTabs(
          shouldEditorUseSoftTabs(
            editor,
            this.config.get("editor.tabType", configOptions),
            this.config.get("editor.softTabs", configOptions),
          ),
        );
      };
      updateTabTypes();
      entry.subscriptions.add(editor.onDidTokenize(updateTabTypes));
    }

    const token = {};
    entry.leases.add(token);
    return new Disposable(() => {
      if (this.managedEditors.get(editor) !== entry) return;
      entry.leases.delete(token);
      if (entry.leases.size === 0) this.removeEntry(entry);
    });
  }

  removeEntry(entry) {
    if (this.managedEditors.get(entry.editor) !== entry) return false;
    this.managedEditors.delete(entry.editor);
    entry.leases.clear();
    entry.subscriptions.dispose();
    return true;
  }

  async updateAndMonitorEditorSettings(entry, oldLanguageMode) {
    await this.packageManager.getActivatePromise();
    if (this.managedEditors.get(entry.editor) !== entry) return;
    this.updateEditorSettingsForLanguageMode(entry.editor, oldLanguageMode);
    this.subscribeToSettingsForEditorScope(entry.editor);
  }

  updateEditorSettingsForLanguageMode(editor, oldLanguageMode) {
    const newLanguageMode = editor.buffer.getLanguageMode();
    if (oldLanguageMode) {
      const newSettings = this.textEditorParamsForScope(newLanguageMode.rootScopeDescriptor);
      const oldSettings = this.textEditorParamsForScope(oldLanguageMode.rootScopeDescriptor);
      const updatedSettings = {};
      for (const [, paramName] of EDITOR_PARAMS_BY_SETTING_KEY) {
        if (!_.isEqual(newSettings[paramName], oldSettings[paramName])) {
          updatedSettings[paramName] = newSettings[paramName];
        }
      }
      if (_.size(updatedSettings) > 0) editor.update(updatedSettings);
    } else {
      editor.update(this.textEditorParamsForScope(newLanguageMode.rootScopeDescriptor));
    }
  }

  subscribeToSettingsForEditorScope(editor) {
    const scopeDescriptor = editor.getRootScopeDescriptor();
    const scopeChain = scopeDescriptor.getScopeChain();
    if (this.scopesWithConfigSubscriptions.has(scopeChain)) return;

    this.scopesWithConfigSubscriptions.add(scopeChain);
    const configOptions = { scope: scopeDescriptor };
    for (const [settingKey, paramName] of EDITOR_PARAMS_BY_SETTING_KEY) {
      this.subscriptions.add(
        this.config.onDidChange(settingKey, configOptions, ({ newValue }) => {
          for (const maintainedEditor of this.managedEditors.keys()) {
            if (maintainedEditor.getRootScopeDescriptor().isEqual(scopeDescriptor)) {
              maintainedEditor.update({ [paramName]: newValue });
            }
          }
        }),
      );
    }

    const updateTabTypes = () => {
      const tabType = this.config.get("editor.tabType", configOptions);
      const softTabs = this.config.get("editor.softTabs", configOptions);
      for (const maintainedEditor of this.managedEditors.keys()) {
        if (maintainedEditor.getRootScopeDescriptor().isEqual(scopeDescriptor)) {
          maintainedEditor.setSoftTabs(
            shouldEditorUseSoftTabs(maintainedEditor, tabType, softTabs),
          );
        }
      }
    };
    this.subscriptions.add(
      this.config.onDidChange("editor.tabType", configOptions, updateTabTypes),
      this.config.onDidChange("editor.softTabs", configOptions, updateTabTypes),
    );
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
