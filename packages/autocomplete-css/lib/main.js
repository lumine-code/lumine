const provider = require("./provider.js");

module.exports = {
  activate() {},

  provideAutocomplete() {
    return provider;
  },
};
