const CtagsProvider = require("./ctags-provider");

module.exports = {
  activate() {
    this.provider = new CtagsProvider();
  },

  deactivate() {
    this.provider?.destroy?.();
  },

  provideSymbol() {
    return this.provider;
  },
};
