const Diacritics = require("diacritic");

/**
 * Removes diacritical marks from a string, so that "café" can be matched by
 * typing "cafe".
 *
 * @param {string} text - The string to fold.
 * @returns {string} The same string with its diacritics removed.
 */
function removeDiacritics(text) {
  return Diacritics.clean(text);
}

module.exports = {
  removeDiacritics,
};
