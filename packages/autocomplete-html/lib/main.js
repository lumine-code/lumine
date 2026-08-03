const getSuggestionsWithTreeSitter = require("./tree-sitter-provider");
const getSuggestionsWithTextMate = require("./text-mate-provider");

const provider = {
  scopeSelector: ".text.html",
  disableForScopeSelector: ".text.html .comment",
  filterSuggestions: true,

  getSuggestions(request) {
    try {
      let languageMode = request.editor.getBuffer().getLanguageMode();
      // Ask what the language mode can do, which is the idiom bracket-matcher
      // uses too. This used to compare `constructor.name` against a class name
      // that had not existed for a long time, so every buffer took the TextMate
      // branch and the Tree-sitter provider rotted unnoticed.
      if (languageMode.getSyntaxNodeAtPosition) {
        return getSuggestionsWithTreeSitter(request);
      } else {
        return getSuggestionsWithTextMate(request);
      }
    } catch (err) {
      // We avoid creating any actual error messages, as this is intended to fix
      // the case when providing completions for EJS that multiple continious
      // errors are created rapidly.
      // https://github.com/lumine-code/lumine/issues/649
      console.error(err);
      return [];
    }
  },

  onDidInsertSuggestion({ editor, suggestion }) {
    if (suggestion.type === "attribute") {
      setTimeout(this.triggerAutocomplete.bind(this, editor), 1);
    }
  },

  triggerAutocomplete(editor) {
    atom.commands.dispatch(editor.getElement(), "autocomplete:activate", {
      activatedManually: false,
    });
  },
};

module.exports = {
  activate() {},
  provideAutocomplete() {
    return provider;
  },
};
