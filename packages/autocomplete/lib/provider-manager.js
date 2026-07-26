const { CompositeDisposable, Disposable } = require("atom");
const { isFunction, isString } = require("./type-helpers");
const { Selector } = require("selector-kit");
const { selectorsMatchScopeChain } = require("./scope-helpers");
const SubsequenceProvider = require("./subsequence-provider");
const ProviderMetadata = require("./provider-metadata");

module.exports = class ProviderManager {
  constructor() {
    this.defaultProvider = null;
    this.defaultProviderRegistration = null;
    this.providers = new Map();
    this.store = null;
    this.subscriptions = null;
    this.globalBlacklist = null;
    this.applicableProviders = this.applicableProviders.bind(this);
    this.toggleDefaultProvider = this.toggleDefaultProvider.bind(this);
    this.setGlobalBlacklist = this.setGlobalBlacklist.bind(this);
    this.metadataForProvider = this.metadataForProvider.bind(this);
    this.addProvider = this.addProvider.bind(this);
    this.removeProvider = this.removeProvider.bind(this);
    this.registerProvider = this.registerProvider.bind(this);
  }

  initialize() {
    this.subscriptions = new CompositeDisposable();
    this.globalBlacklist = new CompositeDisposable();
    this.subscriptions.add(this.globalBlacklist);

    this.subscriptions.add(
      atom.config.observe("autocomplete.enableBuiltinProvider", (value) =>
        this.toggleDefaultProvider(value),
      ),
    );
    this.subscriptions.add(
      atom.config.observe("autocomplete.scopeBlacklist", (value) => this.setGlobalBlacklist(value)),
    );
  }

  dispose() {
    this.toggleDefaultProvider(false);
    if (this.subscriptions && this.subscriptions.dispose) {
      this.subscriptions.dispose();
    }
    this.subscriptions = null;
    this.globalBlacklist = null;
    this.providers = null;
  }

  applicableProviders(labels, scopeDescriptor) {
    let providers = this.getProvidersForLabels(labels);
    providers = this.filterProvidersByScopeDescriptor(providers, scopeDescriptor);
    providers = this.sortProviders(providers, scopeDescriptor);
    providers = this.filterProvidersByExcludeLowerPriority(providers);
    return this.removeMetadata(providers);
  }

  getProvidersForLabels(labels) {
    let result = new Set();
    for (let label of labels) {
      if (this.providers.has(label)) {
        this.providers.get(label).forEach(result.add.bind(result));
      }
    }
    return Array.from(result);
  }

  filterProvidersByScopeDescriptor(providers, scopeDescriptor) {
    const scopeChain = scopeChainForScopeDescriptor(scopeDescriptor);
    if (!scopeChain) {
      return [];
    }
    if (
      this.globalBlacklistSelectors != null &&
      selectorsMatchScopeChain(this.globalBlacklistSelectors, scopeChain)
    ) {
      return [];
    }

    // A provider suppresses the built-in one through `excludeLowerPriority`
    // with an `inclusionPriority` above its zero — the documented route, and
    // the only one there has ever been an implementation for.
    return providers.filter((providerMetadata) => providerMetadata.matchesScopeChain(scopeChain));
  }

  sortProviders(providers, scopeDescriptor) {
    const scopeChain = scopeChainForScopeDescriptor(scopeDescriptor);
    // Array.prototype.sort is stable (ES2019); slice() keeps this non-mutating.
    return providers.slice().sort((providerA, providerB) => {
      const priorityA =
        providerA.provider.suggestionPriority != null ? providerA.provider.suggestionPriority : 1;
      const priorityB =
        providerB.provider.suggestionPriority != null ? providerB.provider.suggestionPriority : 1;
      let difference = priorityB - priorityA;
      if (difference === 0) {
        const specificityA = providerA.getSpecificity(scopeChain);
        const specificityB = providerB.getSpecificity(scopeChain);
        difference = specificityB - specificityA;
      }
      return difference;
    });
  }

  filterProvidersByExcludeLowerPriority(providers) {
    let lowestAllowedPriority = 0;
    for (let i = 0; i < providers.length; i++) {
      const providerMetadata = providers[i];
      const { provider } = providerMetadata;
      if (provider.excludeLowerPriority) {
        lowestAllowedPriority = Math.max(
          lowestAllowedPriority,
          provider.inclusionPriority != null ? provider.inclusionPriority : 0,
        );
      }
    }
    return providers
      .filter(
        (providerMetadata) =>
          (providerMetadata.provider.inclusionPriority != null
            ? providerMetadata.provider.inclusionPriority
            : 0) >= lowestAllowedPriority,
      )
      .map((providerMetadata) => providerMetadata);
  }

  removeMetadata(providers) {
    return providers.map((providerMetadata) => providerMetadata.provider);
  }

  toggleDefaultProvider(enabled) {
    if (enabled == null) return;

    if (enabled) {
      if (this.defaultProvider != null || this.defaultProviderRegistration != null) return;
      this.defaultProvider = new SubsequenceProvider();
      this.defaultProviderRegistration = this.registerProvider(this.defaultProvider);
    } else {
      if (this.defaultProviderRegistration) this.defaultProviderRegistration.dispose();
      if (this.defaultProvider) this.defaultProvider.dispose();
      this.defaultProviderRegistration = null;
      this.defaultProvider = null;
    }
  }

  setGlobalBlacklist(globalBlacklist) {
    this.globalBlacklistSelectors = null;
    if (globalBlacklist && globalBlacklist.length) {
      this.globalBlacklistSelectors = Selector.create(globalBlacklist);
    }
  }

  isValidProvider(provider) {
    return provider != null && this.providerValidationErrors(provider).length === 0;
  }

  // Returns a human-readable list of contract violations, naming the legacy
  // field when a provider still uses the pre-5.0 API so the fix is obvious.
  providerValidationErrors(provider) {
    const errors = [];
    if (!isFunction(provider.getSuggestions)) {
      errors.push("`getSuggestions` must be a function");
    }
    if (!isString(provider.scopeSelector) || !provider.scopeSelector.length) {
      if (isString(provider.selector)) {
        errors.push("`selector` is no longer supported; rename it to `scopeSelector`");
      } else {
        errors.push("`scopeSelector` must be a non-empty string");
      }
    }
    if (provider.disableForSelector != null && provider.disableForScopeSelector == null) {
      errors.push(
        "`disableForSelector` is no longer supported; rename it to `disableForScopeSelector`",
      );
    }
    return errors;
  }

  metadataForProvider(provider) {
    for (let providers of this.providers.values()) {
      for (let i = 0; i < providers.length; i++) {
        const providerMetadata = providers[i];
        if (providerMetadata.provider === provider) {
          return providerMetadata;
        }
      }
    }
    return null;
  }

  isProviderRegistered(provider) {
    return this.metadataForProvider(provider) != null;
  }

  addProvider(provider) {
    if (this.isProviderRegistered(provider)) {
      return;
    }
    let providerMetadata = new ProviderMetadata(provider);
    let labels = providerMetadata.getLabels();
    for (var label of labels) {
      if (!this.providers.has(label)) {
        this.providers.set(label, []);
      }
      this.providers.get(label).push(providerMetadata);
    }
    if (provider.dispose != null) {
      return this.subscriptions.add(provider);
    }
  }

  removeProvider(provider) {
    if (!this.providers) {
      return;
    }
    for (let providers of this.providers.values()) {
      for (let i = 0; i < providers.length; i++) {
        const providerMetadata = providers[i];
        if (providerMetadata.provider === provider) {
          providers.splice(i, 1);
          break;
        }
      }
    }
    if (provider.dispose != null) {
      if (this.subscriptions) {
        this.subscriptions.remove(provider);
      }
    }
  }

  registerProvider(provider) {
    if (provider == null) {
      return;
    }

    const validationErrors = this.providerValidationErrors(provider);
    if (validationErrors.length > 0) {
      const name = provider.constructor?.name || "Object";
      atom.notifications.addError(`Invalid autocomplete provider rejected: ${name}`, {
        description:
          "A package registered an autocomplete provider that does not satisfy " +
          "the `autocomplete.provider` service contract:\n\n" +
          validationErrors.map((error) => `- ${error}`).join("\n"),
        dismissable: true,
      });
      console.error(`Invalid autocomplete provider ${name}`, validationErrors, provider);
      return new Disposable();
    }

    if (this.isProviderRegistered(provider)) {
      return;
    }

    this.addProvider(provider);

    const disposable = new Disposable(() => {
      this.removeProvider(provider);
    });

    // When the provider is disposed, remove its registration
    const originalDispose = provider.dispose;
    if (originalDispose) {
      provider.dispose = () => {
        originalDispose.call(provider);
        disposable.dispose();
      };
    }

    return disposable;
  }
};

const scopeChainForScopeDescriptor = (scopeDescriptor) => {
  // TODO: most of this is temp code to understand #308
  const type = typeof scopeDescriptor;
  let hasScopeChain = false;
  if (type === "object" && scopeDescriptor && scopeDescriptor.getScopeChain) {
    hasScopeChain = true;
  }
  if (type === "string") {
    return scopeDescriptor;
  } else if (type === "object" && hasScopeChain) {
    const scopeChain = scopeDescriptor.getScopeChain();
    if (scopeChain != null && scopeChain.replace == null) {
      const json = JSON.stringify(scopeDescriptor);
      throw new Error(`01: ScopeChain is not correct type: ${type}; ${json}`);
    }
    return scopeChain;
  } else {
    const json = JSON.stringify(scopeDescriptor);
    throw new Error(`02: ScopeChain is not correct type: ${type}; ${json}`);
  }
};
