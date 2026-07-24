"use babel";

import { Selector } from "selector-kit";
import { selectorForScopeChain, selectorsMatchScopeChain } from "./scope-helpers";

export default class ProviderMetadata {
  constructor(provider) {
    this.provider = provider;

    this.scopeSelectors = Selector.create(this.provider.scopeSelector);

    if (this.provider.disableForScopeSelector != null) {
      this.disableForScopeSelectors = Selector.create(this.provider.disableForScopeSelector);
    }
  }

  getLabels() {
    // The default label will let the provider be used for
    // the main text editors of the workspace.
    return this.provider.labels || ["workspace-center"];
  }

  matchesScopeChain(scopeChain) {
    if (this.disableForScopeSelectors != null) {
      if (selectorsMatchScopeChain(this.disableForScopeSelectors, scopeChain)) {
        return false;
      }
    }

    if (selectorsMatchScopeChain(this.scopeSelectors, scopeChain)) {
      return true;
    } else {
      return false;
    }
  }

  shouldDisableDefaultProvider(scopeChain) {
    if (this.disableDefaultProviderSelectors != null) {
      return selectorsMatchScopeChain(this.disableDefaultProviderSelectors, scopeChain);
    } else {
      return false;
    }
  }

  getSpecificity(scopeChain) {
    const selector = selectorForScopeChain(this.scopeSelectors, scopeChain);
    if (selector) {
      return selector.getSpecificity();
    } else {
      return 0;
    }
  }
}
