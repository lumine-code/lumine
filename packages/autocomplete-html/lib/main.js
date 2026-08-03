const getSuggestionsWithTextMate = require("./text-mate-provider");

const provider = {
  scopeSelector: ".text.html",
  disableForScopeSelector: ".text.html .comment",
  filterSuggestions: true,

  getSuggestions(request) {
    try {
      // Every buffer, Tree-sitter or not, goes through the TextMate provider.
      //
      // `lib/tree-sitter-provider.js` was written against an older
      // tree-sitter-html and no longer matches the trees the current one
      // produces: for `<` it yields `(document (ERROR))`, in which the provider
      // finds no token to complete from, so it returns nothing at all. It is
      // kept as the starting point for a rewrite, and is not wired up.
      //
      // This was already the behaviour — the branch that chose between the two
      // compared `constructor.name` against a class name that had not existed
      // for a long time, so it always fell through to here. That is now a
      // decision rather than an accident.
      return getSuggestionsWithTextMate(request);
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
