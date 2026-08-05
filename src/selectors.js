module.exports = { selectorMatchesAnyScope, matcherForSelector };

const { isSubset } = require("@lumine-code/underscore-plus");

// Private: Parse a selector into parts.
//          If already parsed, returns the selector unmodified.
//
// * `selector` a {String|Array<String>} specifying what to match
// Returns selector parts, an {Array<String>}.
function parse(selector) {
  return typeof selector === "string" ? selector.replace(/^\./, "").split(".") : selector;
}

const always = (_scope) => true;

// Essential: Build a reusable test for a scope selector.
//
// Parsing the selector once and testing many scopes with the result is what
// makes this worth having over {selectorMatchesAnyScope} in a loop.
//
// * `selector` A {String} selector such as `"source.js"`, or an {Array} of the
//   parts it is made of. An empty selector matches everything.
//
// Returns a {Function} taking a scope {String} and returning a {Boolean}, true
// when the scope matches the selector.
function matcherForSelector(selector) {
  const parts = parse(selector);
  if (typeof parts === "function") return parts;
  return selector ? (scope) => isSubset(parts, parse(scope)) : always;
}

// Essential: Whether any of the given scopes matches a selector.
//
// * `selector` A {String} selector. An empty selector matches everything.
// * `scopes` An {Array} of scope {String}s to test.
//
// Returns a {Boolean}.
function selectorMatchesAnyScope(selector, scopes) {
  return !selector || scopes.some(matcherForSelector(selector));
}
