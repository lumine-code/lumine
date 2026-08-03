module.exports = class GrammarListView {
  constructor() {
    this.autoDetect = { name: "Auto Detect" };

    this.configSubscription = atom.config.observe(
      "grammar-selector.hideDuplicateTextMateGrammars",
      (value) => {
        this.hideDuplicateGrammars = value;
      },
    );

    this.selectListView = atom.workspace.buildSelectList({
      className: "grammar-selector",
      crumb: "Grammars",
      itemsClassList: ["mark-active"],
      items: [],
      filterKeyForItem: (grammar) => grammar.name,
      elementForItem: (grammar, { highlight }) => {
        const grammarName = grammar.name || grammar.scopeName;
        const element = document.createElement("li");
        if (grammar === this.currentGrammar) {
          element.classList.add("active");
        }
        element.classList.add("grammar-item");
        element.appendChild(highlight(grammarName));
        element.dataset.grammar = grammarName;

        const div = document.createElement("div");
        div.classList.add("pull-right");

        // "Auto Detect" is a placeholder rather than a grammar, so it gets no
        // parser badge — the switch this replaced happened to return undefined
        // for it, which was load-bearing by accident.
        if (!this.hideDuplicateGrammars && grammar !== this.autoDetect) {
          // When we show all grammars, we should add a badge to each grammar
          // to distinguish them from one another in the list.
          const parser = document.createElement("span");

          let badgeText = getBadgeTextForGrammar(grammar);
          let badgeColor = getBadgeColorForGrammar(grammar);

          parser.classList.add("grammar-selector-parser", "badge", badgeColor);
          parser.textContent = badgeText;
          if (isTreeSitter(grammar)) {
            parser.setAttribute(
              "title",
              "(Recommended) A faster parser with improved syntax highlighting & code navigation support.",
            );
          }
          div.appendChild(parser);
        }

        if (grammar.scopeName) {
          const scopeName = document.createElement("span");
          scopeName.classList.add("badge", "badge-info");
          scopeName.textContent = grammar.scopeName;
          div.appendChild(scopeName);
        }

        // Appended outside the scope-name branch: a grammar without one still
        // has a parser badge to show when duplicates are listed.
        if (div.childElementCount > 0) {
          element.appendChild(div);
        }

        return element;
      },
      didConfirmSelection: (grammar) => {
        this.cancel();
        if (grammar === this.autoDetect) {
          atom.textEditors.clearGrammarOverride(this.editor);
        } else {
          atom.grammars.assignGrammar(this.editor, grammar);
        }
      },
      didCancelSelection: () => {
        this.cancel();
      },
    });
  }

  destroy() {
    this.cancel();
    this.configSubscription.dispose();
    return this.selectListView.destroy();
  }

  cancel() {
    this.currentGrammar = null;
    this.selectListView.hide();
  }

  getAllDisplayableGrammars() {
    let allGrammars = atom.grammars.getGrammars({ includeTreeSitter: true }).filter((grammar) => {
      return grammar !== atom.grammars.nullGrammar && grammar.name;
    });

    return allGrammars;
  }

  async toggle() {
    if (this.selectListView.isVisible()) {
      this.cancel();
      return;
    }

    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      this.editor = editor;
      this.currentGrammar = this.editor.getGrammar();
      if (this.currentGrammar === atom.grammars.nullGrammar) {
        this.currentGrammar = this.autoDetect;
      }

      let grammars = this.getAllDisplayableGrammars();

      grammars.sort((a, b) => {
        if (a.scopeName === "text.plain") {
          return -1;
        } else if (b.scopeName === "text.plain") {
          return 1;
        } else if (a.name === b.name) {
          return compareGrammarType(a, b);
        }
        return a.name.localeCompare(b.name);
      });

      if (this.hideDuplicateGrammars) {
        let displayedGrammars = [];
        let seenIds = new Set();

        for (let grammar of grammars) {
          if (seenIds.has(grammar.scopeName)) continue;
          seenIds.add(grammar.scopeName);
          displayedGrammars.push(grammar);
        }

        grammars = displayedGrammars;
      }

      grammars.unshift(this.autoDetect);
      this.selectListView.reset();
      await this.selectListView.update({ items: grammars });
      this.selectListView.show();
    }
  }
};

// We look up global settings here, but it's just to determine the badge
// colors. Otherwise we should be looking up these values in a scope-specific
// manner.
function getLanguageModeConfig() {
  let isTreeSitterMode = atom.config.get("language.useTreeSitterParsers");
  return isTreeSitterMode ? "tree-sitter" : "textmate";
}

// The grammar's own `type`, not `constructor.name`: the class name is a string
// that any rename silently breaks, and a bundled package must not reach into
// the editor's `src/` to get at the class for an `instanceof`. This file used
// to carry entries for a second, long-removed Tree-sitter class that nothing
// could ever match.
function isTreeSitter(grammar) {
  return grammar.type === "tree-sitter";
}

function compareGrammarType(a, b) {
  return getGrammarScore(a) - getGrammarScore(b);
}

// Given a scope name, determines the user's preferred parser type for that
// language.
function getParserPreferenceForScopeName(scopeName) {
  let useTreeSitterParsers = atom.config.get("language.useTreeSitterParsers", {
    scope: [scopeName],
  });

  if (!useTreeSitterParsers) {
    return "textmate";
  } else {
    return "tree-sitter";
  }
}

function getBadgeTextForGrammar(grammar) {
  return isTreeSitter(grammar) ? "Tree-sitter" : "TextMate";
}

// Green for the kind the user's setting prefers, blue for the other. There are
// exactly two kinds, so this is a choice rather than a lookup table — the table
// this replaced was keyed by class name and had a third, dead entry.
function getBadgeColorForGrammar(grammar) {
  let preferred = getLanguageModeConfig() === "tree-sitter";
  return isTreeSitter(grammar) === preferred ? "badge-success" : "badge-info";
}

function getGrammarScore(grammar) {
  let languageParser = getParserPreferenceForScopeName(grammar.scopeName);
  if (isTreeSitter(grammar)) return -2;
  return languageParser === "textmate" ? -3 : 0;
}
