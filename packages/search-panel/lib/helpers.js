const fs = require("fs");

/**
 * Binary search with insertion point.
 * Returns index if found, or (-insertionPoint - 1) if not found.
 * @param {Array} array - Sorted array to search
 * @param {*} target - Value to find
 * @param {Function} compare - Comparator function (element, target) => number
 * @param {number} [min=0] - Start index (inclusive)
 * @param {number} [max] - End index (exclusive), defaults to array.length
 */
function binarySearch(array, target, compare, min = 0, max = array.length) {
  let low = min;
  let high = max - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const cmp = compare(array[mid], target);
    if (cmp < 0) {
      low = mid + 1;
    } else if (cmp > 0) {
      high = mid - 1;
    } else {
      return mid;
    }
  }
  return -low - 1;
}

/**
 * Escape special regex characters in a string.
 * Note: Does not escape dashes (for RegExp 'u' flag compatibility).
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Simple pluralize function.
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural] - Defaults to singular + 's'
 */
function pluralize(count, singular, plural = singular + "s") {
  return count === 1 ? singular : plural;
}

/**
 * Deep equality check for objects and primitives.
 */
function isEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => isEqual(a[key], b[key]));
}

function isSymbolicLinkSync(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

module.exports = {
  binarySearch,
  escapeRegExp,
  pluralize,
  isEqual,
  isSymbolicLinkSync,
};
