const { CompositeDisposable } = require("atom");
const ThemeSelector = require("./theme-selector");

let selector = null;
let subscriptions = null;

function getSelector() {
  if (!selector) selector = new ThemeSelector();
  return selector;
}

module.exports = {
  activate() {
    subscriptions = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        "theme-selector:toggle": () => getSelector().toggle(),
        "theme-selector:use-system-mode": () => getSelector().useSystemMode(),
        "theme-selector:use-light-mode": () => getSelector().useLightMode(),
        "theme-selector:use-dark-mode": () => getSelector().useDarkMode(),
      }),
    );
  },

  async deactivate() {
    subscriptions?.dispose();
    subscriptions = null;
    await selector?.destroy();
    selector = null;
  },

  getSelector,
};
