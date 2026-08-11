module.exports = { selectorMatchesAnyScope, matcherForSelector };

const { isSubset } = require("@lumine-code/underscore-plus");

/**
 * Parse a selector into parts.
 *          If already parsed, returns the selector unmodified.
 *
 * @param selector - a {String|Array<String>} specifying what to match
 * @returns {Array<String>} The selector parts.
 * @private
 */
function parse(selector) {
  return typeof selector === "string" ? selector.replace(/^\./, "").split(".") : selector;
}

const always = (_scope) => true;

/**
 * Build a reusable test for a scope selector.
 *
 * Parsing the selector once and testing many scopes with the result is what
 * makes this worth having over `selectorMatchesAnyScope` in a loop.
 *
 * @param selector - A `String` selector such as `"source.js"`, or an `Array` of the parts it is made of. An empty selector matches everything.
 * @returns {Function} taking a scope `String` and returning a `Boolean`, true when the scope matches the selector.
 * @public
 * @api-status Essential
 */
function matcherForSelector(selector) {
  const parts = parse(selector);
  if (typeof parts === "function") return parts;
  return selector ? (scope) => isSubset(parts, parse(scope)) : always;
}

/**
 * Whether any of the given scopes matches a selector.
 *
 * @param selector - A `String` selector. An empty selector matches everything.
 * @param scopes - An `Array` of scope `Strings` to test.
 * @returns {Boolean}
 * @public
 * @api-status Essential
 */
function selectorMatchesAnyScope(selector, scopes) {
  return !selector || scopes.some(matcherForSelector(selector));
}
