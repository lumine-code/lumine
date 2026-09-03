"use strict";

const fuzzyMatcher = require("./fuzzy-matcher");

// Internal render helpers. Packages reach this behavior through the model:
// `highlightMatches` through the `highlight` function in the `renderItem`
// context, and `createTwoLineItem` by returning a descriptor object from
// `renderItem` rather than an element.

/**
 * Computes fuzzy match indices for a text against a query.
 * @param {string} text - The text to match against
 * @param {string} query - The query to match
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.removeDiacritics=false] - Match accent-insensitively.
 *   Folding is done natively; the returned indices refer to the original `text`.
 * @returns {number[]|null} Array of character indices that matched, or null if no match
 * @private
 */
function getMatchIndices(text, query, options = {}) {
  if (!text || !query) return null;

  const result = fuzzyMatcher.match(text, query, {
    ignoreDiacritics: !!options.removeDiacritics,
    recordMatchIndexes: true,
  });

  return result?.matchIndexes ?? null;
}

function highlightMatches(text, matchIndices, options = {}) {
  const { className = "character-match" } = options;
  const fragment = document.createDocumentFragment();

  if (!matchIndices || matchIndices.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }

  // Filter out invalid indices (negative or out of range)
  const validIndices = matchIndices.filter((i) => i >= 0 && i < text.length);

  if (validIndices.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }

  let lastIndex = 0;
  let matchChars = "";

  for (const index of validIndices) {
    if (index > lastIndex) {
      if (matchChars) {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = matchChars;
        fragment.appendChild(span);
        matchChars = "";
      }
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, index)));
    }
    matchChars += text[index];
    lastIndex = index + 1;
  }

  if (matchChars) {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = matchChars;
    fragment.appendChild(span);
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

/**
 * Builds the right-hand block of a primary line. Entries may be DOM nodes,
 * `{text, className}` descriptors, or falsy so callers can inline conditionals.
 * @param {Node|Array} trailing - A node, or a list of nodes and descriptors
 * @returns {HTMLSpanElement|null} The container, or null when there is nothing to show
 * @private
 */
function createTrailingBlock(trailing) {
  const entries = (Array.isArray(trailing) ? trailing : [trailing]).filter(Boolean);
  if (entries.length === 0) return null;

  const block = document.createElement("span");
  block.classList.add("trailing-block");
  for (const entry of entries) {
    // Duck-typed rather than `instanceof Node` so the helper also runs outside a
    // browser realm, where that global does not exist.
    if (typeof entry.nodeType === "number") {
      block.appendChild(entry);
      continue;
    }
    const span = document.createElement("span");
    if (entry.className) {
      span.classList.add(...String(entry.className).split(/\s+/).filter(Boolean));
    }
    span.textContent = entry.text ?? "";
    block.appendChild(span);
  }
  return block;
}

/**
 * Creates a list item element with a primary line and an optional secondary
 * line. The `two-lines` class is only applied when there is a secondary line,
 * so the same helper builds both one- and two-line rows.
 * @param {Object} options - Configuration options
 * @param {string|Node} options.primary - Primary line content (text or DOM node)
 * @param {string|Node} [options.secondary] - Secondary line content (optional)
 * @param {string[]} [options.icon] - Icon class names to add to primary line
 * @param {string|string[]} [options.className] - Extra class names for the item
 * @param {Node|Array} [options.trailing] - Right-hand content for the primary line
 * @returns {HTMLLIElement} The created list item element
 * @private
 */
function createTwoLineItem({ primary, secondary, icon, className, trailing }) {
  const li = document.createElement("li");
  const hasSecondary = secondary !== undefined && secondary !== null;
  if (hasSecondary) {
    li.classList.add("two-lines");
  }
  if (className) {
    const names = Array.isArray(className) ? className : String(className).split(/\s+/);
    li.classList.add(...names.filter(Boolean));
  }

  const priLine = document.createElement("div");
  priLine.classList.add("primary-line");
  if (icon && icon.length > 0) {
    priLine.classList.add("icon", ...icon);
  }

  const wrapper = document.createElement("span");
  wrapper.classList.add("primary-text");
  if (typeof primary === "string") {
    wrapper.textContent = primary;
  } else if (primary) {
    wrapper.appendChild(primary);
  }
  priLine.appendChild(wrapper);

  const trailingBlock = trailing ? createTrailingBlock(trailing) : null;
  if (trailingBlock) {
    priLine.appendChild(trailingBlock);
  }
  li.appendChild(priLine);

  if (hasSecondary) {
    const secLine = document.createElement("div");
    secLine.classList.add("secondary-line");
    if (typeof secondary === "string") {
      secLine.textContent = secondary;
    } else {
      secLine.appendChild(secondary);
    }
    li.appendChild(secLine);
  }

  return li;
}

module.exports = {
  getMatchIndices,
  highlightMatches,
  createTrailingBlock,
  createTwoLineItem,
};
