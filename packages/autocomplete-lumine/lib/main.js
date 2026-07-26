const provider = require("./provider");

module.exports = {
  activate() {
    return provider.load();
  },

  provideAutocomplete() {
    return provider;
  },
};
