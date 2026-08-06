// Specificity and validity for real CSS selectors -- the ones commands, keymaps
// and context menus are registered against, which are matched against DOM
// elements. Scope selectors, which look similar but address TextMate scope
// chains, live in `selectors.js`.
//
// Inlined from the archived atom/clear-cut, which ported the specificity
// calculation from keeganstreet/specificity.
//
// http://www.w3.org/TR/css3-selectors/#specificity

// Each of these assumes the selectors matched by the preceding ones have
// already been blanked out of the string.
const ATTRIBUTE_REGEX = /(\[[^\]]+\])/g;
const ID_REGEX = /(#[^\s+>~.[:]+)/g;
const CLASS_REGEX = /(\.[^\s+>~.[:]+)/g;
const PSEUDO_ELEMENT_REGEX = /(::[^\s+>~.[:]+|:first-line|:first-letter|:before|:after)/g;
const PSEUDO_CLASS_REGEX = /(:[^\s+>~.[:]+)/g;
const ELEMENT_REGEX = /([^\s+>~.[:]+)/g;
const NOT_REGEX = /:not\(([^)]*)\)/g;
const RULE_REGEX = /\{[^]*/gm;
const SEPARATOR_REGEX = /[*\s+>~]/g;
const STRAYS_REGEX = /[#.]/g;

// Count the matches of `regex` and blank them out so later, looser patterns do
// not count them again. `type` is "a" for ids, "b" for classes, attributes and
// pseudo-classes, "c" for elements and pseudo-elements.
function findMatch(regex, type, types, selector) {
  const matches = selector.match(regex);
  if (matches) {
    for (const match of matches) {
      types[type]++;
      selector = selector.replace(match, " ");
    }
  }
  return selector;
}

function calculate(selector) {
  const commaIndex = selector.indexOf(",");
  if (commaIndex !== -1) {
    selector = selector.substring(0, commaIndex);
  }

  const types = { a: 0, b: 0, c: 0 };

  // Drop `:not(...)` but keep its argument: specificity counts the argument.
  selector = selector.replace(NOT_REGEX, " $1 ");
  // Drop anything past a left brace, in case a whole rule was pasted in.
  selector = selector.replace(RULE_REGEX, " ");

  selector = findMatch(ATTRIBUTE_REGEX, "b", types, selector);
  selector = findMatch(ID_REGEX, "a", types, selector);
  selector = findMatch(CLASS_REGEX, "b", types, selector);
  selector = findMatch(PSEUDO_ELEMENT_REGEX, "c", types, selector);
  selector = findMatch(PSEUDO_CLASS_REGEX, "b", types, selector);

  // Universal selector and combinators contribute nothing.
  selector = selector.replace(SEPARATOR_REGEX, " ");
  // Stray dots or hashes, which show up while a selector is being edited.
  selector = selector.replace(STRAYS_REGEX, " ");

  findMatch(ELEMENT_REGEX, "c", types, selector);

  return types.a * 100 + types.b * 10 + types.c * 1;
}

// Maps rather than plain objects: keyed by arbitrary selector text, a plain
// object answers `toString`, `constructor` and friends from Object.prototype,
// so `calculateSpecificity('constructor')` handed back a function.
const specificityCache = new Map();
const validSelectorCache = new Map();
let testSelectorElement = null;

function calculateSpecificity(selector) {
  let specificity = specificityCache.get(selector);
  if (specificity === undefined) {
    specificity = calculate(selector);
    specificityCache.set(selector, specificity);
  }
  return specificity;
}

function isSelectorValid(selector) {
  let valid = validSelectorCache.get(selector);
  if (valid === undefined) {
    testSelectorElement ??= document.createElement("div");
    try {
      testSelectorElement.querySelector(selector);
      valid = true;
    } catch {
      valid = false;
    }
    validSelectorCache.set(selector, valid);
  }
  return valid;
}

function validateSelector(selector) {
  if (!isSelectorValid(selector)) {
    const error = new SyntaxError(`${selector} is not a valid selector`);
    error.code = "EBADSELECTOR";
    throw error;
  }
}

module.exports = { calculateSpecificity, isSelectorValid, validateSelector };
