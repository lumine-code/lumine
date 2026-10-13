const Diacritics = require("diacritic");

/**
 * @public
 * @status public
 *
 * Removes diacritical marks from a string, so that "café" can be matched by
 * typing "cafe".
 *
 * @memberof lumine.tools
 * @param {String} text - The string to fold.
 * @returns {String} The same string with its diacritics removed.
 */
function removeDiacritics(text) {
  return Diacritics.clean(text);
}

module.exports = {
  removeDiacritics,
};
