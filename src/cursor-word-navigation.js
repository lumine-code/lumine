const Range = require("./range");

function characterClasses(cursor, options = {}) {
  const nonWord = cursor.getNonWordCharacters();
  const escaped = Array.from(nonWord, (character) =>
    Array.from(
      { length: character.length },
      (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join(""),
  ).join("");
  const word = `[^\\s${escaped}]`;
  const punctuation = `[${escaped}]`;
  return {
    classify(character) {
      if (!character) return 0;
      if (nonWord.includes(character)) return options.includeNonWordCharacters === false ? 0 : 2;
      return /\s/.test(character) ? 0 : 1;
    },
    patterns: [null, word, punctuation],
  };
}

function runBoundary(source, offset, limit, pattern, direction) {
  const expression = new RegExp(direction > 0 ? `^${pattern}+` : `${pattern}+$`);
  while (offset !== limit) {
    const start = direction > 0 ? offset : Math.max(limit, offset - 32768);
    const end = direction > 0 ? Math.min(limit, offset + 32768) : offset;
    const part = source.slice(start, end);
    const match = expression.exec(part);
    const length = match ? match[0].length : 0;
    offset += direction * length;
    if (length !== part.length) break;
  }
  return offset;
}

function currentWordRange(cursor, options = {}) {
  const source = cursor.editor.buffer.getTextSnapshot();
  const position = cursor.getBufferPosition();
  const start = source.lineStart(position.row);
  const end = start + cursor.editor.buffer.lineLengthForRow(position.row);
  const offset = start + position.column;
  const classes = characterClasses(cursor, options);
  // Inclusive edges choose the preceding word, matching the first native match
  // containing the cursor when punctuation and word runs touch.
  let anchor =
    offset > start && classes.classify(source.slice(offset - 1, offset)) ? offset - 1 : offset;
  const type = anchor < end ? classes.classify(source.slice(anchor, anchor + 1)) : 0;
  if (type) {
    const left = runBoundary(source, anchor, start, classes.patterns[type], -1);
    const right = runBoundary(source, anchor, end, classes.patterns[type], 1);
    return new Range([position.row, left - start], [position.row, right - start]);
  }
  if (runBoundary(source, start, end, "[\\t ]", 1) === end)
    return new Range([position.row, 0], [position.row, end - start]);
  return new Range(position, position);
}

module.exports = { currentWordRange, characterClasses, runBoundary };
function* wordRanges(cursor, requested, options = {}, backwards = false) {
  const range = cursor.editor.buffer.clipRange(requested);
  const source = cursor.editor.buffer.getTextSnapshot();
  const classes = characterClasses(cursor, options);
  const firstRow = range.start.row,
    lastRow = range.end.row;
  for (
    let row = backwards ? lastRow : firstRow;
    backwards ? row >= firstRow : row <= lastRow;
    row += backwards ? -1 : 1
  ) {
    const lineStart = source.lineStart(row);
    const length = cursor.editor.buffer.lineLengthForRow(row);
    const start = lineStart + (row === firstRow ? range.start.column : 0);
    const end = lineStart + (row === lastRow ? range.end.column : length);
    if (
      start === lineStart &&
      end === lineStart + length &&
      runBoundary(source, start, end, "[\\t ]", 1) === end
    ) {
      yield new Range([row, 0], [row, length]);
      continue;
    }
    let offset = backwards ? end : start;
    while (backwards ? offset > start : offset < end) {
      const character = source.slice(
        backwards ? offset - 1 : offset,
        backwards ? offset : offset + 1,
      );
      const type = classes.classify(character);
      const next = runBoundary(
        source,
        offset,
        backwards ? start : end,
        type ? classes.patterns[type] : "\\s",
        backwards ? -1 : 1,
      );
      if (next === offset) {
        offset += backwards ? -1 : 1;
        continue;
      }
      if (type)
        yield new Range(
          [row, Math.min(offset, next) - lineStart],
          [row, Math.max(offset, next) - lineStart],
        );
      offset = next;
    }
  }
}

module.exports.wordRanges = wordRanges;
function paragraphBoundary(cursor, direction) {
  const buffer = cursor.editor.buffer;
  const source = buffer.getTextSnapshot();
  const position = cursor.getBufferPosition();
  const blankSeparator = (row) => {
    if (row <= 0 || row >= buffer.getLastRow()) return false;
    const start = source.lineStart(row),
      end = start + buffer.lineLengthForRow(row);
    const nextStart = source.lineStart(row + 1);
    // Preserve the existing LF/CRLF expression's alternatives exactly.
    if (source.charCodeAt(nextStart - 2) === 13 && source.charCodeAt(start - 2) !== 13)
      return false;
    return runBoundary(source, start, end, "[\\t ]", 1) === end;
  };
  if (direction > 0) {
    for (let row = position.row + 1; row < buffer.getLastRow(); row++)
      if (blankSeparator(row)) return { row, column: 0 };
    const eof = buffer.getEndPosition();
    return { row: eof.row, column: Math.max(0, eof.column - 1) };
  }
  for (let row = position.row - 2; row > 0; row--) {
    if (!blankSeparator(row)) continue;
    let first = row;
    while (blankSeparator(first - 1)) first--;
    return { row: row - ((row - first) % 2), column: 0 };
  }
  return { row: 0, column: 0 };
}

module.exports.paragraphBoundary = paragraphBoundary;
const subwordPatterns = new WeakMap();
function markSubwordRegex(regex, nonWordCharacters, backwards) {
  subwordPatterns.set(regex, { nonWordCharacters, backwards });
  return regex;
}
function isSubwordRegex(regex) {
  return subwordPatterns.has(regex);
}

// This recognizer implements Cursor.subwordRegExp's fixed regular grammar.
// Every unbounded quantifier is one character-class run; chunk boundaries never
// end a run. No lookaround/backtracking is approximated with a fixed overlap.
function* subwordRanges(cursor, requested, regex) {
  const { nonWordCharacters, backwards } = subwordPatterns.get(regex);
  const buffer = cursor.editor.buffer,
    source = buffer.getTextSnapshot();
  const range = buffer.clipRange(requested);
  let offset = source.offsetAt(range.start);
  const end = source.offsetAt(range.end);
  const lower = "[a-z\\u00DF-\\u00F6\\u00F8-\\u00FF]";
  const upper = "[A-Z\\u00C0-\\u00D6\\u00D8-\\u00DE]";
  const lowerTest = new RegExp(lower),
    upperTest = new RegExp(upper);
  const punct =
    "[" +
    Array.from(nonWordCharacters, (character) =>
      Array.from(
        { length: character.length },
        (_, i) => `\\u${character.charCodeAt(i).toString(16).padStart(4, "0")}`,
      ).join(""),
    ).join("") +
    "]";
  const punctTest = new RegExp(punct);
  const read = source.reader(4096);
  const character = (at) => (at < end ? read(at)[0] : "");
  const run = (at, pattern) => runBoundary(source, at, end, pattern, 1);
  const isEnd = (at) =>
    at === source.length ||
    source.charCodeAt(at) === 10 ||
    (source.charCodeAt(at) === 13 && source.charCodeAt(at + 1) === 10);
  while (offset < end) {
    const first = character(offset);
    let next = offset;
    if (first === " " || first === "\t") {
      const after = run(offset, "[\\t ]");
      if (offset === 0 || source.charCodeAt(offset - 1) === 10 || isEnd(after)) next = after;
    }
    if (next === offset && upperTest.test(first)) {
      next = run(offset, upper);
      if (lowerTest.test(character(next))) next--;
    }
    if (next === offset && /\d/.test(first)) next = run(offset, "\\d");
    if (next === offset) {
      let at = backwards ? offset : run(offset, "_");
      if (upperTest.test(character(at))) at++;
      if (lowerTest.test(character(at))) {
        next = run(at, lower);
        if (backwards) next = run(next, "_");
      }
    }
    if (next === offset) {
      const at = backwards ? offset : run(offset, "\\s");
      if (punctTest.test(character(at))) {
        next = run(at, punct);
        if (backwards) next = run(next, "\\s");
      }
    }
    if (next === offset && first === "_") next = run(offset, "_");
    if (next === offset) offset++;
    else {
      yield new Range(source.positionAt(offset), source.positionAt(next));
      offset = next;
    }
  }
}
module.exports.markSubwordRegex = markSubwordRegex;
module.exports.isSubwordRegex = isSubwordRegex;
module.exports.subwordRanges = subwordRanges;
function lastSubwordRange(cursor, requested, regex) {
  const settings = subwordPatterns.get(regex);
  const buffer = cursor.editor.buffer,
    source = buffer.getTextSnapshot();
  const range = buffer.clipRange(requested);
  const lower = "[a-z\\u00DF-\\u00F6\\u00F8-\\u00FF]",
    upper = "[A-Z\\u00C0-\\u00D6\\u00D8-\\u00DE]";
  const alphabet = new RegExp(`${lower}|${upper}|\\d|\\s`);
  // User punctuation overlapping a letter/digit/whitespace class can change
  // alternative priority across run boundaries; retain the full exact scan.
  if (
    !settings.backwards ||
    Array.from(settings.nonWordCharacters).some((character) => alphabet.test(character))
  ) {
    let last;
    for (const match of subwordRanges(cursor, range, regex)) last = match;
    return last;
  }
  const start = source.offsetAt(range.start),
    end = source.offsetAt(range.end);
  const escaped = Array.from(settings.nonWordCharacters, (character) =>
    Array.from(
      { length: character.length },
      (_, i) => `\\u${character.charCodeAt(i).toString(16).padStart(4, "0")}`,
    ).join(""),
  ).join("");
  const punct = `[${escaped}]`,
    punctTest = new RegExp(punct);
  const lowerTest = new RegExp(lower),
    upperTest = new RegExp(upper);
  let at = end;
  const back = (pattern) => {
    at = runBoundary(source, at, start, pattern, -1);
  };
  const before = () => (at > start ? source.slice(at - 1, at) : "");
  // Unknown code units cannot occur in any alternative and are hard token
  // boundaries. Skip them, then include complete runs participating in the
  // last candidate (punctuation+whitespace, lower+underscores, or capitals).
  let previous;
  do {
    previous = at;
    back(`[^${escaped}a-zA-Z\\u00DF-\\u00F6\\u00F8-\\u00FF\\u00C0-\\u00D6\\u00D8-\\u00DE\\d\\s_]`);
    back("\\s");
  } while (at !== previous);
  if (punctTest.test(before())) {
    back(punct);
    if (source.charCodeAt(at) === 95 && lowerTest.test(before())) {
      back(lower);
      if (upperTest.test(before())) at--;
    }
  } else {
    back("_");
    if (lowerTest.test(before())) {
      back(lower);
      if (upperTest.test(before())) at--;
    } else if (upperTest.test(before())) back(upper);
    else if (/\d/.test(before())) back("\\d");
  }
  let last;
  for (const match of subwordRanges(cursor, new Range(source.positionAt(at), range.end), regex))
    last = match;
  return last;
}
module.exports.lastSubwordRange = lastSubwordRange;
