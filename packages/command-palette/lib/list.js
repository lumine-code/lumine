const { humanizeKeystroke } = require("./humankeys");
const { SelectListView, highlightMatches } = require("@lumine-code/select-list");

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

    this.selectListView = new SelectListView({
      className: "command-palette",
      emptyMessage: "No matches found",

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
        if (this.needsUpdate) {
          this.needsUpdate = false;
          this.selectListView.update({ items: this.commands });
        }
      },

      elementForItem: (item, { matchIndices }) => {
        const li = document.createElement("li");
        li.classList.add("event", "two-lines");
        if (this.selectListView.getQuery() === "" && this.recentlyUsed.includes(item.name)) {
          li.classList.add("recent");
        }
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
        titleEl.appendChild(highlightMatches(item.displayName, matchIndices));
        leftBlock.appendChild(titleEl);

        // Secondary line: description
        if (item.description) {
          const secondaryEl = document.createElement("div");
          secondaryEl.classList.add("secondary-line");
          secondaryEl.title = item.description;
          const offset =
            item.displayName.length + (item.tags ? item.tags.join(" ").length + 1 : 0) + 1;
          secondaryEl.appendChild(
            highlightMatches(
              item.description,
              matchIndices.map((i) => i - offset),
            ),
          );
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
  }

  destroy() {
    this.configObserver.dispose();
    this.configObserver2.dispose();
    return this.selectListView.destroy();
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
      this.selectListView.update({ items: this.commands });
    }
  }
}

module.exports = CommandPalette;
