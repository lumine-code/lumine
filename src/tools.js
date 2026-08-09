// The editor's own utilities, handed to packages as `lumine.tools` so that a
// package needing to render Markdown, match a query against a list of
// candidates, or fold diacritics does not vendor a second implementation of
// something the editor already carries.
//
// Each is documented where it is defined: the Markdown functions and
// `removeDiacritics` under Functions in the API reference, and `fuzzyMatcher`
// in `fuzzy-matcher.js`.
const markdown = require("./markdown");
const fuzzyMatcher = require("./fuzzy-matcher");
const { removeDiacritics } = require("./diacritics");

module.exports = {
  markdown,
  fuzzyMatcher,
  removeDiacritics,
};
