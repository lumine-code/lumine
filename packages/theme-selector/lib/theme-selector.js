const { CompositeDisposable } = require("atom");

module.exports = class ThemeSelector {
  constructor() {
    this.snapshot = null;
    this.selectList = atom.workspace.buildSelectList({
      className: "theme-selector",
      items: [],
      emptyMessage: "No theme packs are registered",
      placeholderText: "Select a theme",
      filterKeyForItem: (themePack) =>
        [themePack.name, ...themePack.light, ...themePack.dark].join(" "),
      elementForItem: (themePack, { highlight }) => {
        const element = document.createElement("li");
        element.classList.add("theme-pack", "two-lines");
        if (atom.themes.isThemePackActive(themePack)) {
          element.classList.add("active");
        }

        const primaryLine = document.createElement("div");
        primaryLine.classList.add("primary-line");
        const status = document.createElement("span");
        status.classList.add("theme-pack-status", "icon", "icon-check");
        primaryLine.appendChild(status);
        const title = document.createElement("span");
        title.classList.add("theme-pack-title");
        title.appendChild(highlight(themePack.name));
        primaryLine.appendChild(title);
        element.appendChild(primaryLine);

        const secondaryLine = document.createElement("div");
        secondaryLine.classList.add("secondary-line", "no-icon");
        secondaryLine.textContent = `Light: ${themePack.light.join(" + ")} · Dark: ${themePack.dark.join(" + ")}`;
        element.appendChild(secondaryLine);
        return element;
      },
      didChangeSelection: (themePack) => this.preview(themePack),
      didConfirmSelection: (themePack) => this.confirm(themePack),
      didCancelSelection: () => this.cancel(),
    });

    this.subscriptions = new CompositeDisposable(
      atom.config.onDidChange("theme.mode", () => this.updateModeMessage()),
      atom.themes.onDidChangeThemePacks(() => {
        if (this.selectList.isVisible()) this.refresh();
      }),
    );
  }

  async destroy() {
    this.cancel();
    this.subscriptions.dispose();
    await this.selectList.destroy();
  }

  async toggle() {
    if (this.selectList.isVisible()) {
      this.cancel();
    } else {
      await this.show();
    }
  }

  async show() {
    if (this.selectList.isVisible()) return;

    this.snapshot = {
      light: this.getConfiguredPair("theme.light"),
      dark: this.getConfiguredPair("theme.dark"),
      mode: atom.config.get("theme.mode"),
    };

    this.selectList.reset();
    await this.refresh();
    this.selectList.show();
  }

  async refresh() {
    const activeThemePack = atom.themes.getActiveThemePack();
    const themePacks = atom.themes.getThemePacks();
    if (activeThemePack) {
      themePacks.splice(themePacks.indexOf(activeThemePack), 1);
      themePacks.unshift(activeThemePack);
    }

    await this.selectList.update({
      items: themePacks,
      initialSelectionIndex: activeThemePack ? 0 : undefined,
      infoMessage: this.getModeMessage(),
    });

    // Subsequent filtering should select its first result, not reuse the
    // opening index chosen above.
    this.selectList.props.initialSelectionIndex = 0;
  }

  preview(themePack) {
    if (!this.snapshot || !themePack) return;
    atom.themes.setThemePack(themePack);
  }

  confirm(themePack) {
    if (!themePack) return;
    atom.themes.setThemePack(themePack);
    this.snapshot = null;
    this.selectList.hide();
  }

  cancel() {
    const snapshot = this.snapshot;
    this.snapshot = null;
    this.selectList.hide();
    if (!snapshot) return;
    if (
      this.pairsMatch(this.getConfiguredPair("theme.light"), snapshot.light) &&
      this.pairsMatch(this.getConfiguredPair("theme.dark"), snapshot.dark) &&
      atom.config.get("theme.mode") === snapshot.mode
    ) {
      return;
    }

    atom.config.transact(() => {
      atom.config.set("theme.light", snapshot.light);
      atom.config.set("theme.dark", snapshot.dark);
      atom.config.set("theme.mode", snapshot.mode);
    });
  }

  useSystemMode() {
    atom.config.set("theme.mode", "system");
  }

  useLightMode() {
    atom.config.set("theme.mode", "light");
  }

  useDarkMode() {
    atom.config.set("theme.mode", "dark");
  }

  getConfiguredPair(keyPath) {
    const pair = atom.config.get(keyPath);
    return Array.isArray(pair) ? pair.slice() : [];
  }

  pairsMatch(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  getModeMessage() {
    const mode = atom.config.get("theme.mode");
    const effectiveMode = atom.themes.isDarkThemeMode() ? "Dark" : "Light";
    const modeLabel = mode === "system" ? `System (${effectiveMode})` : effectiveMode;
    return `Mode: ${modeLabel} · Ctrl+1: system · Ctrl+2: light · Ctrl+3: dark`;
  }

  updateModeMessage() {
    if (!this.selectList.isVisible()) return;
    this.selectList.update({ infoMessage: this.getModeMessage() });
  }
};
