const { humanizeKeystroke } = require("./humankeys");

class CommandPalette {
  constructor(recentlyUsed) {
    this.keyBindingsForActiveElement = [];
    this.commands = [];
    this.showHiddenCommands = false;
    this.recentlyUsed = recentlyUsed || [];
    this.recentCount = atom.config.get("command-palette.recentCount");

    this.configObserver = atom.config.onDidChange("command-palette.recentCount", ({ newValue }) => {
      this.recentCount = newValue;
      while (this.recentlyUsed.length > this.recentCount) this.recentlyUsed.pop();
    });
  }

  destroy() {
    this.configObserver.dispose();
  }

  // The command list depends on which element is focused, so it is gathered
  // from the target the kernel captured before the modal took focus.
  collect(target) {
    const activeElement =
      target.element && target.element !== document.body
        ? target.element
        : atom.views.getView(atom.workspace);

    this.activeElement = activeElement;
    this.keyBindingsForActiveElement = atom.keymaps.findKeyBindings({ target: activeElement });
    this.commands = atom.commands
      .findCommands({ target: activeElement })
      .filter((command) => this.showHiddenCommands === !!command.hiddenInCommandPalette);
    return this.commands;
  }

  keystrokesFor(name) {
    const seen = new Set();
    const keystrokes = [];
    for (const binding of this.keyBindingsForActiveElement) {
      if (binding.command !== name || seen.has(binding.keystrokes)) continue;
      seen.add(binding.keystrokes);
      keystrokes.push(humanizeKeystroke(binding.keystrokes));
    }
    return keystrokes;
  }

  spec() {
    return {
      id: "command-palette.commands",
      className: "command-palette",
      placeholder: "Search commands",
      emptyMessage: "No matches found",
      preserveQuery: atom.config.get("command-palette.preserveQuery"),
      source: (req) => this.collect(req.session.target),
      matcher: atom.modals.matchers.command({
        // Every displayed part is searchable, and the offsets come back split
        // per field, so each line highlights its own matches.
        fields: [
          { name: "label", get: (entry) => entry.item.displayName },
          { name: "tags", get: (entry) => (entry.item.tags ? entry.item.tags.join(" ") : "") },
          { name: "description", get: (entry) => entry.item.description ?? "" },
        ],
        // Recently used commands float to the top, but only until the user
        // types: after that, match quality is the only thing that should order
        // the list.
        order: (a, b, query) => {
          if (query.text !== "") return 0;
          const aRecent = this.recentlyUsed.indexOf(a.entry.item.name);
          const bRecent = this.recentlyUsed.indexOf(b.entry.item.name);
          if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent;
          if (aRecent !== -1) return -1;
          if (bRecent !== -1) return 1;
          return a.entry.item.displayName.localeCompare(b.entry.item.displayName);
        },
      }),
      renderer: {
        entry: (command) => ({ id: command.name, text: command.displayName }),
        row: (command, { query }) => ({
          className: [
            "event",
            query.text === "" && this.recentlyUsed.includes(command.name) ? "recent" : null,
          ],
          dataset: { eventName: command.name },
          label: { text: command.displayName, tooltip: command.name },
          detail: command.description
            ? { text: command.description, tooltip: command.description }
            : undefined,
          keybinding: this.keystrokesFor(command.name),
        }),
      },
      confirm: ({ item, target }) => {
        const index = this.recentlyUsed.indexOf(item.name);
        if (index !== -1) this.recentlyUsed.splice(index, 1);
        this.recentlyUsed.unshift(item.name);
        while (this.recentlyUsed.length > this.recentCount) this.recentlyUsed.pop();
        // Dispatched into the element that had focus before the palette
        // opened, never into the palette itself.
        target.dispatch(item.name);
      },
    };
  }

  toggle() {
    this.showHiddenCommands = false;
    return atom.modals.toggle(this.spec());
  }

  show(showHiddenCommands = false) {
    this.showHiddenCommands = showHiddenCommands;
    return atom.modals.open(this.spec());
  }

  hide() {
    const session = atom.modals.getActiveSession();
    if (session && session.rootSpec.id === "command-palette.commands") session.cancel("api");
  }

  clearRecent() {
    if (this.recentlyUsed.length === 0) return;
    this.recentlyUsed.length = 0;

    const session = atom.modals.getActiveSession();
    if (session && session.rootSpec.id === "command-palette.commands") session.refresh();
  }
}

module.exports = CommandPalette;
