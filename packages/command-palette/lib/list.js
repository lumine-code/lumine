const { humanizeKeystroke } = require("./humankeys");

class CommandPalette {
  constructor(recentlyUsed) {
    this.keyBindingsForActiveElement = [];
    this.commands = [];
    this.showHiddenCommands = false;
    this.lastShowHiddenCommands = false;
    this.lastActiveElement = null;
    this.recentlyUsed = recentlyUsed || [];
    this.recentCount = atom.config.get("command-palette.recentCount");
    this.preserveQuery = atom.config.get("command-palette.preserveQuery");
    this.needsUpdate = true;

    this.configObserver = atom.config.onDidChange("command-palette.recentCount", ({ newValue }) => {
      this.recentCount = newValue;
      while (this.recentlyUsed.length > this.recentCount) this.recentlyUsed.pop();
      this.needsUpdate = true;
    });
    this.configObserver2 = atom.config.onDidChange(
      "command-palette.preserveQuery",
      ({ newValue }) => {
        this.preserveQuery = newValue;
      },
    );

    this.selectListView = atom.workspace.buildSelectList({
      className: "command-palette",
      crumb: "Commands",
      emptyMessage: "No matches found",
      separatorIds: [],
      idForItem: (item) => (this.selectListView.getQuery() === "" ? item.name : null),

      order: (a, b) => {
        if (this.selectListView.getQuery() === "") {
          const aRecent = this.recentlyUsed.indexOf(a.name);
          const bRecent = this.recentlyUsed.indexOf(b.name);
          if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent;
          if (aRecent !== -1) return -1;
          if (bRecent !== -1) return 1;
          return a.displayName.localeCompare(b.displayName);
        }
        return 0;
      },

      // Command names are hyphenated (`editor:fold-all`) while their display
      // names are spaced (`Editor: Fold All`), so treat a typed `-` as a space.
      filterQuery: (query) => query.replace(/-/g, " "),

      filterKeyForItem: (item) => {
        let key = item.displayName;
        if (item.tags) {
          key += " " + item.tags.join(" ");
        }
        if (item.description) {
          key += " " + item.description;
        }
        return key;
      },

      willShow: () => {
        if (!this.preserveQuery) this.selectListView.reset();
        this.activeElement =
          document.activeElement === document.body
            ? atom.views.getView(atom.workspace)
            : document.activeElement;
        // The command list depends on both the focused element and the hidden
        // filter, so a change to either one invalidates the cached commands.
        if (
          this.activeElement !== this.lastActiveElement ||
          this.showHiddenCommands !== this.lastShowHiddenCommands
        ) {
          this.refreshCommands();
        }
        if (this.needsUpdate) {
          this.needsUpdate = false;
          this.selectListView.update(this.listProps());
        }
      },

      elementForItem: (item, { matchIndices, highlight }) => {
        const li = document.createElement("li");
        li.classList.add("event", "two-lines");
        li.dataset.eventName = item.name;

        // Key bindings on the right
        const rightBlock = document.createElement("div");
        rightBlock.classList.add("pull-right");
        const seen = new Set();
        this.keyBindingsForActiveElement
          .filter(({ command, keystrokes }) => {
            if (command !== item.name || seen.has(keystrokes)) return false;
            seen.add(keystrokes);
            return true;
          })
          .forEach((keyBinding) => {
            const kbd = document.createElement("kbd");
            kbd.classList.add("key-binding");
            kbd.textContent = humanizeKeystroke(keyBinding.keystrokes);
            rightBlock.appendChild(kbd);
          });
        li.appendChild(rightBlock);

        // Primary line: command name
        const leftBlock = document.createElement("div");
        const titleEl = document.createElement("div");
        titleEl.classList.add("primary-line");
        titleEl.title = item.name;
        titleEl.appendChild(highlight(item.displayName));
        leftBlock.appendChild(titleEl);

        // Secondary line: description
        if (item.description) {
          const secondaryEl = document.createElement("div");
          secondaryEl.classList.add("secondary-line");
          secondaryEl.title = item.description;
          const offset =
            item.displayName.length + (item.tags ? item.tags.join(" ").length + 1 : 0) + 1;
          const descriptionMatchIndices = (matchIndices ?? [])
            .map((index) => index - offset)
            .filter((index) => index >= 0);
          secondaryEl.appendChild(highlight(item.description, descriptionMatchIndices));
          leftBlock.appendChild(secondaryEl);
        }

        li.appendChild(leftBlock);
        return li;
      },

      didConfirmSelection: (item) => {
        this.selectListView.hide();
        const idx = this.recentlyUsed.indexOf(item.name);
        if (idx !== -1) this.recentlyUsed.splice(idx, 1);
        this.recentlyUsed.unshift(item.name);
        while (this.recentlyUsed.length > this.recentCount) this.recentlyUsed.pop();
        this.needsUpdate = true;
        const event = new CustomEvent(item.name, {
          bubbles: true,
          cancelable: true,
        });
        this.activeElement.dispatchEvent(event);
      },

      didCancelSelection: () => {
        this.selectListView.hide();
      },
    });

    // Registered in the package's own namespace on the palette element: the
    // item-actions list (F12) derives its rows — label, description,
    // keybinding — from commands the dialog contributes itself, so this is
    // what makes the mode swap discoverable from inside the palette.
    this.commandsDisposable = atom.commands.add(this.selectListView.element, {
      "command-palette:toggle-hidden-commands": {
        description: "Include the commands hidden from the palette by their packages",
        didDispatch: () => this.toggleHiddenCommands(),
      },
    });
  }

  destroy() {
    this.configObserver.dispose();
    this.configObserver2.dispose();
    this.commandsDisposable.dispose();
    return this.selectListView.destroy();
  }

  // Recomputes the command list and its keybindings for the current active
  // element and hidden filter; `needsUpdate` marks the result for the next
  // update push.
  refreshCommands() {
    this.lastActiveElement = this.activeElement;
    this.lastShowHiddenCommands = this.showHiddenCommands;
    this.keyBindingsForActiveElement = atom.keymaps.findKeyBindings({
      target: this.activeElement,
    });
    this.commands = atom.commands
      .findCommands({ target: this.activeElement })
      .filter((command) => this.showHiddenCommands === !!command.hiddenInCommandPalette);
    this.needsUpdate = true;
  }

  recentSeparatorIds() {
    const recentNames = new Set(this.recentlyUsed);
    if (!this.commands.some((command) => recentNames.has(command.name))) return [];

    const firstNonRecent = this.commands
      .filter((command) => !recentNames.has(command.name))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))[0];
    return firstNonRecent ? [firstNonRecent.name] : [];
  }

  listProps() {
    return {
      items: this.commands,
      separatorIds: this.recentSeparatorIds(),
    };
  }

  // Swaps the open palette between the visible commands and the ones packages
  // hide from it, keeping the commands of the originally focused element.
  toggleHiddenCommands() {
    if (!this.selectListView.isVisible()) return;
    this.showHiddenCommands = !this.showHiddenCommands;
    this.refreshCommands();
    this.needsUpdate = false;
    this.selectListView.update(this.listProps());
  }

  toggle() {
    this.showHiddenCommands = false;
    return this.selectListView.toggle();
  }

  show(showHiddenCommands = false) {
    this.showHiddenCommands = showHiddenCommands;
    return this.selectListView.show();
  }

  hide() {
    return this.selectListView.hide();
  }

  clearRecent() {
    if (this.recentlyUsed.length === 0) return;

    this.recentlyUsed.length = 0;
    this.needsUpdate = true;

    if (this.selectListView.isVisible?.()) {
      this.selectListView.update(this.listProps());
    }
  }
}

module.exports = CommandPalette;
