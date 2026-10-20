// The editor's own utilities, handed to packages as `lumine.tools` so that a
// package needing to render Markdown, match a query against a list of
// candidates, or fold diacritics does not vendor a second implementation of
// something the editor already carries.
// Completion matching shares the buffer's JS scoring kernel; fuzzyMatcher is
// the JavaScript matcher used by path and general-purpose search tools.
//
// Each is documented where it is defined: the Markdown functions and
// `removeDiacritics` under Functions in the API reference, and `fuzzyMatcher`
// in `fuzzy-matcher.js`.
const markdown = require("./markdown");
const fuzzyMatcher = require("./fuzzy-matcher");
const { removeDiacritics } = require("./diacritics");
const { createQuery } = require("./completion-matcher");

module.exports = {
  markdown,
  fuzzyMatcher,
  completionMatcher: { createQuery },
  removeDiacritics,
};
