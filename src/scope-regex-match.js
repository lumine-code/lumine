const { checkPredicateTextLength, QueryBudgetExceeded } = require("./tree-sitter-query-budget");

const MAX_TEXT = 65536;
const CHUNK_SIZE = 4096;
const widths = new WeakMap();

// Only a conservative, finite-width subset can be evaluated on a source
// window. Groups, alternatives, assertions, backreferences, flags and
// unbounded repetition retain the ordinary full-text semantics and budget.
function finiteWidth(regex) {
  if (widths.has(regex)) return widths.get(regex);
  const pattern = regex.source;
  let start = false;
  let end = false;
  let width = 0;
  let valid = regex.flags === "";
  for (let i = 0; valid && i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "^" && i === 0) {
      start = true;
      continue;
    }
    if (char === "$" && i === pattern.length - 1) {
      end = true;
      continue;
    }
    if (char === "\\") {
      const escaped = pattern[++i];
      if (!escaped || !/^[\\^$.*+?()[\]{}|/dDsSwWnrtfv-]$/.test(escaped)) valid = false;
    } else if (char === "[") {
      let closed = false;
      while (++i < pattern.length) {
        if (pattern[i] === "\\") i++;
        else if (pattern[i] === "]") {
          closed = true;
          break;
        }
      }
      valid = closed;
    } else if ("^$()|*+?".includes(char)) {
      valid = false;
    }
    let repetitions = 1;
    if (pattern[i + 1] === "?") {
      i++;
    } else if (pattern[i + 1] === "*") {
      valid = false;
    } else if (pattern[i + 1] === "+") {
      valid = false;
    } else if (pattern[i + 1] === "{") {
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i + 1));
      if (quantifier) {
        if (quantifier[2] === "") valid = false;
        repetitions = Number(quantifier[2] ?? quantifier[1]);
        i += quantifier[0].length;
      }
    }
    width += repetitions;
    if (width > MAX_TEXT) valid = false;
  }
  const result = valid ? { start, end, width } : null;
  widths.set(regex, result);
  return result;
}

// The returned match index is always relative to the original node. A short
// read may establish an exact first match, but never an inexact negative.
function matchScopePattern(node, regex, getSource) {
  const length = node.endIndex - node.startIndex;
  const shape = finiteWidth(regex);
  if (!shape || !Number.isSafeInteger(length) || length < 0 || length <= CHUNK_SIZE)
    return node.text.match(regex);
  const source = getSource();
  const read = (start, end) => {
    const length = end - start;
    if (length > MAX_TEXT) throw new QueryBudgetExceeded("predicate-text-limit");
    checkPredicateTextLength(length);
    return source.slice(node.startIndex + start, node.startIndex + end);
  };
  if (shape.start && shape.end) {
    // JS's $ can also match just before a final line terminator or CRLF.
    if (length > shape.width + 2) return null;
    return read(0, length).match(regex);
  }
  if (shape.start) return read(0, Math.min(length, shape.width)).match(regex);
  if (shape.end) {
    const offset = Math.max(0, length - shape.width - 2);
    const match = read(offset, length).match(regex);
    if (match) match.index += offset;
    return match;
  }
  let text = "";
  while (text.length < length) {
    const end = Math.min(length, text.length + CHUNK_SIZE, MAX_TEXT);
    checkPredicateTextLength(end);
    text += read(text.length, end);
    const match = text.match(regex);
    if (match && (end === length || match.index + shape.width <= end)) return match;
    if (end === length) return null;
    if (end === MAX_TEXT) throw new QueryBudgetExceeded("predicate-text-limit");
  }
  return null;
}

module.exports = matchScopePattern;
