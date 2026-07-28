module.exports = class GrammarListView {
  constructor() {
    this.autoDetect = { name: "Auto Detect" };

    this.configSubscription = atom.config.observe(
      "grammar-selector.hideDuplicateTextMateGrammars",
      (value) => {
        this.hideDuplicateGrammars = value;
      },
    );
  }

  destroy() {
    this.configSubscription.dispose();
  }

  getAllDisplayableGrammars() {
    return atom.grammars.getGrammars({ includeTreeSitter: true }).filter((grammar) => {
      return grammar !== atom.grammars.nullGrammar && grammar.name;
    });
  }

  getGrammars() {
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
      const displayedGrammars = [];
      const seenIds = new Set();
      for (const grammar of grammars) {
        if (seenIds.has(grammar.scopeName)) continue;
        seenIds.add(grammar.scopeName);
        displayedGrammars.push(grammar);
      }
      grammars = displayedGrammars;
    }

    grammars.unshift(this.autoDetect);
    return grammars;
  }

  toggle() {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return null;

    let currentGrammar = editor.getGrammar();
    if (currentGrammar === atom.grammars.nullGrammar) currentGrammar = this.autoDetect;

    return atom.modals.toggle({
      id: "grammar-selector.grammars",
      className: "grammar-selector",
      placeholder: "Select a grammar",
      markActive: true,
      source: this.getGrammars(),
      renderer: {
        // Grammar names repeat across parsers, so identity is the object
        // itself rather than a derived string.
        entry: (grammar) => ({ id: grammar, text: grammar.name || grammar.scopeName }),
        row: (grammar) => ({
          label: grammar.name || grammar.scopeName,
          className: "grammar-item",
          active: grammar === currentGrammar,
          dataset: { grammar: grammar.name || grammar.scopeName },
          badges: this.badgesFor(grammar),
        }),
      },
      confirm: ({ item, target }) => {
        if (item === this.autoDetect) {
          atom.textEditors.clearGrammarOverride(target.editor);
        } else {
          atom.grammars.assignGrammar(target.editor, item);
        }
      },
    });
  }

  badgesFor(grammar) {
    const badges = [];
    // When every grammar is listed, the parser badge is what tells two
    // same-named entries apart.
    if (!this.hideDuplicateGrammars) {
      badges.push({
        text: getBadgeTextForGrammar(grammar),
        className: `grammar-selector-parser ${getBadgeColorForGrammar(grammar)}`,
        tooltip: isModernTreeSitter(grammar)
          ? "(Recommended) A faster parser with improved syntax highlighting & code navigation support."
          : undefined,
      });
    }
    if (grammar.scopeName) {
      badges.push({ text: grammar.scopeName, className: "badge-info" });
    }
    return badges;
  }
};

// We look up global settings here, but it's just to determine the badge
// colors. Otherwise we should be looking up these values in a scope-specific
// manner.
function getLanguageModeConfig() {
  let isTreeSitterMode = atom.config.get("language.useTreeSitterParsers");
  return isTreeSitterMode ? "web-tree-sitter" : "textmate";
}

function isModernTreeSitter(grammar) {
  return grammar.constructor.name === "WASMTreeSitterGrammar";
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
    return "web-tree-sitter";
  }
}

function getBadgeTextForGrammar(grammar) {
  switch (grammar.constructor.name) {
    case "Grammar":
      return "TextMate";
    case "WASMTreeSitterGrammar":
      return "Tree-sitter";
  }
}

const BADGE_COLORS_BY_LANGUAGE_MODE_CONFIG = {
  textmate: {
    Grammar: "badge-success",
    TreeSitterGrammar: "badge-info",
    WASMTreeSitterGrammar: "badge-info",
  },
  "web-tree-sitter": {
    WASMTreeSitterGrammar: "badge-success",
    TreeSitterGrammar: "badge-warning",
    Grammar: "badge-info",
  },
};

function getBadgeColorForGrammar(grammar) {
  let languageModeConfig = getLanguageModeConfig();
  let classNameMap = BADGE_COLORS_BY_LANGUAGE_MODE_CONFIG[languageModeConfig];
  return classNameMap[grammar.constructor.name];
}

function getGrammarScore(grammar) {
  let languageParser = getParserPreferenceForScopeName(grammar.scopeName);
  if (isModernTreeSitter(grammar)) return -2;
  return languageParser === "textmate" ? -3 : 0;
}
