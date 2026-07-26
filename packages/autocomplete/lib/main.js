const { CompositeDisposable } = require("atom");
const AutocompleteManager = require("./autocomplete-manager");

module.exports = {
  subscriptions: null,
  autocompleteManager: new AutocompleteManager(),

  // Public: Creates AutocompleteManager instances for all active and future editors (soon, just a single AutocompleteManager)
  activate() {
    this.subscriptions = new CompositeDisposable();
    if (!this.autocompleteManager) this.autocompleteManager = new AutocompleteManager();
    this.subscriptions.add(this.autocompleteManager);
    this.autocompleteManager.initialize();
  },

  // Public: Cleans everything up, removes all AutocompleteManager instances
  deactivate() {
    if (this.subscriptions) {
      this.subscriptions.dispose();
    }
    this.subscriptions = null;
    this.autocompleteManager = null;
  },

  provideAutocompleteWatchEditor() {
    return this.autocompleteManager.watchEditor.bind(this.autocompleteManager);
  },

  consumeSnippets(snippetsManager) {
    this.autocompleteManager.setSnippetsManager(snippetsManager);
  },

  /*
  Section: Provider API
  */

  consumeAutocomplete(providers) {
    if (!providers) {
      return;
    }
    if (!Array.isArray(providers)) {
      providers = [providers];
    }
    if (providers.length === 0) {
      return;
    }

    const registrations = new CompositeDisposable();
    for (const provider of providers) {
      registrations.add(this.autocompleteManager.providerManager.registerProvider(provider));
    }
    return registrations;
  },
};
