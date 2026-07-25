const { CompositeDisposable } = require("atom");
const CommandPalette = require("./list");

module.exports = {
  activate(state) {
    this.list = new CommandPalette(state?.recentlyUsed);
    this.disposables = new CompositeDisposable(
      atom.commands.add("atom-workspace", {
        "command-palette:toggle": () => this.list.toggle(),
        "command-palette:show-hidden-commands": () => this.list.show(true),
        "command-palette:clear-recent": () => this.list.clearRecent(),
      }),
    );
  },

  serialize() {
    return { recentlyUsed: this.list.recentlyUsed };
  },

  async deactivate() {
    this.disposables.dispose();
    await this.list.destroy();
  },
};
