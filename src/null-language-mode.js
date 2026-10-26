const { Emitter } = require("@lumine-code/event-kit");
const Point = require("./point");
const Range = require("./range");
const ScopeDescriptor = require("./scope-descriptor");
const NullGrammar = require("./null-grammar");
const Token = require("./token");
const { PieceTree } = require("./text-model");
const { rangeIsBlank, leadingIndentation } = require("./text-source-helpers");

const EMPTY = [];
const NON_WHITESPACE_REGEX = /\S/;

module.exports = class NullLanguageMode {
  constructor({ buffer = null, grammar = NullGrammar } = {}) {
    this.buffer = buffer;
    this.grammar = grammar;
    this.emitter = new Emitter();
    this.rootScopeDescriptor = new ScopeDescriptor({ scopes: [grammar.scopeName] });
    this.tokenized = true;
  }

  bufferDidChange() {
    this.indentationCache?.clear();
  }
  bufferDidFinishTransaction() {}
  buildHighlightIterator() {
    return new NullHighlightIterator();
  }
  onDidChangeHighlighting(callback) {
    return this.emitter.on("did-change-highlighting", callback);
  }
  onDidTokenize(callback) {
    return this.emitter.on("did-tokenize", callback);
  }
  getLanguageId() {
    return this.grammar.scopeName;
  }
  getGrammar() {
    return this.grammar;
  }
  scopeDescriptorForPosition() {
    return this.rootScopeDescriptor;
  }
  syntaxTreeScopeDescriptorForPosition() {
    return this.rootScopeDescriptor;
  }
  bufferRangeForScopeAtPosition() {
    return null;
  }
  tokenForPosition(position) {
    if (!this.buffer) return new Token({ value: "", scopes: [this.grammar.scopeName] });
    const row = Point.fromObject(position).row;
    const length = this.buffer.lineLengthForRow(row);
    if (length === undefined) return new Token({ value: "", scopes: [this.grammar.scopeName] });
    const source = this.buffer.getTextSnapshot();
    const start = source.lineStart(row);
    return new Token({
      valueSource: source.subtext(start, start + length),
      scopes: [this.grammar.scopeName],
    });
  }
  classNameForScopeId() {
    return null;
  }
  commentStringsForPosition() {
    return {};
  }
  isRowCommented() {
    return false;
  }
  suggestedIndentForLineAtBufferRow(_row, line, tabLength) {
    const source = typeof line === "string" ? new PieceTree(line) : line;
    if (rangeIsBlank(source) && this.buffer) {
      const precedingRow = this.previousNonBlankRow(_row, tabLength);
      if (precedingRow != null) return this.indentationForRow(precedingRow, tabLength).level;
    }
    return leadingIndentation(source, 0, source.length, tabLength).level;
  }
  suggestedIndentForBufferRow(row, tabLength) {
    const precedingRow = this.previousNonBlankRow(row, tabLength);
    if (precedingRow == null) return 0;
    return this.indentationForRow(precedingRow, tabLength).level;
  }
  scanSuggestedIndentation(ranges, tabLength, options) {
    return require("./text-editor-auto-indent").scanPlainIndentation(
      this.buffer,
      ranges,
      tabLength,
      options,
    );
  }
  isFoldableAtRow(row) {
    return this.endRowForFoldAtRow(row, 1, true) != null;
  }
  isFoldableAtRowForRendering(row) {
    // A gutter query must not scan a pathological whitespace prefix or an
    // unbounded run of blank lines. Explicit fold commands retain exact reads.
    const first = this.indentationForRow(row, 1, 8192);
    if (!first || first.blank || !first.complete) return false;
    for (
      let next = row + 1, end = Math.min(this.buffer.getLineCount(), row + 65);
      next < end;
      next++
    ) {
      const info = this.indentationForRow(next, 1, 8192);
      if (!info.complete) return false;
      if (!info.blank) return info.level > first.level;
    }
    return false;
  }
  getFoldRangeForRow(row, tabLength) {
    const endRow = this.endRowForFoldAtRow(row, tabLength);
    return endRow == null ? null : Range(Point(row, Infinity), Point(endRow, Infinity));
  }
  getFoldableRangeContainingPoint(point, tabLength) {
    if (point.column >= this.buffer.lineLengthForRow(point.row)) {
      const fold = this.getFoldRangeForRow(point.row, tabLength);
      if (fold) return fold;
    }

    for (let row = point.row - 1; row >= 0; row--) {
      const endRow = this.endRowForFoldAtRow(row, tabLength);
      if (endRow != null && endRow >= point.row) {
        return Range(Point(row, Infinity), Point(endRow, Infinity));
      }
    }
    return null;
  }
  getFoldableRangesAtIndentLevel(indentLevel, tabLength) {
    const result = [];
    let row = 0;
    while (row < this.buffer.getLineCount()) {
      if (this.indentationForRow(row, tabLength).level === indentLevel) {
        const endRow = this.endRowForFoldAtRow(row, tabLength);
        if (endRow != null) {
          result.push(Range(Point(row, Infinity), Point(endRow, Infinity)));
          row = endRow + 1;
          continue;
        }
      }
      row++;
    }
    return result;
  }
  getFoldableRanges(tabLength) {
    const result = [];
    for (let row = 0; row < this.buffer.getLineCount(); row++) {
      const endRow = this.endRowForFoldAtRow(row, tabLength);
      if (endRow != null) result.push(Range(Point(row, Infinity), Point(endRow, Infinity)));
    }
    return result;
  }
  endRowForFoldAtRow(row, tabLength, existenceOnly = false) {
    const line = this.indentationForRow(row, tabLength);
    if (!line || line.blank) return;
    const startIndentLevel = line.level;
    let foldEndRow;
    for (let nextRow = row + 1; nextRow < this.buffer.getLineCount(); nextRow++) {
      const nextLine = this.indentationForRow(nextRow, tabLength);
      if (nextLine.blank) continue;
      const indentation = nextLine.level;
      if (indentation <= startIndentLevel) break;
      foldEndRow = nextRow;
      if (existenceOnly) break;
    }
    return foldEndRow;
  }
  indentLevelForLine(line, tabLength) {
    return this.suggestedIndentForLineAtBufferRow(0, line, tabLength);
  }
  indentationForRow(row, tabLength, maxUnits = Infinity) {
    if (!this.buffer || row < 0 || row >= this.buffer.getLineCount()) return null;
    const key = `${row}:${tabLength}`;
    this.indentationCache ??= new Map();
    const cached = this.indentationCache.get(key);
    if (cached) return cached;
    const source = this.buffer.getTextSnapshot();
    let offset = source.offsetAt({ row, column: 0 });
    const end = offset + this.buffer.lineLengthForRow(row);
    const limit = Math.min(end, offset + maxUnits);
    const read = source.reader(4096);
    let columns = 0,
      prefix = true,
      blank = true;
    while (offset < limit) {
      const part = read(offset).slice(0, limit - offset);
      if (prefix)
        for (const character of part) {
          if (character === " ") columns++;
          else if (character === "\t") columns += tabLength - (columns % tabLength);
          else {
            prefix = false;
            break;
          }
        }
      offset += part.length;
      if (NON_WHITESPACE_REGEX.test(part)) {
        blank = false;
        break;
      }
    }
    const result = { level: columns / tabLength, blank, complete: !blank || offset === end };
    if (result.complete) {
      if (this.indentationCache.size >= 512)
        this.indentationCache.delete(this.indentationCache.keys().next().value);
      this.indentationCache.set(key, result);
    }
    return result;
  }
  previousNonBlankRow(row, tabLength) {
    if (!this.buffer) return null;
    row = Math.min(row, this.buffer.getLastRow());
    for (let previous = row - 1; previous >= 0; previous--) {
      if (!this.indentationForRow(previous, tabLength).blank) return previous;
    }
    return null;
  }
  destroy() {
    this.emitter.dispose();
  }
};

class NullHighlightIterator {
  seek(_position) {
    return EMPTY;
  }
  compare() {
    return 1;
  }
  moveToSuccessor() {
    return false;
  }
  getPosition() {
    return Point.INFINITY;
  }
  getCloseTags() {
    return EMPTY;
  }
  getOpenTags() {
    return EMPTY;
  }
  getCloseScopeIds() {
    return EMPTY;
  }
  getOpenScopeIds() {
    return EMPTY;
  }
}
