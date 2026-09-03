const { Emitter } = require("@lumine-code/event-kit");
const Point = require("./point");
const Range = require("./range");
const ScopeDescriptor = require("./scope-descriptor");
const NullGrammar = require("./null-grammar");
const Token = require("./token");

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

  bufferDidChange() {}
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
  isTokenized() {
    return true;
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
    const value = this.buffer?.lineForRow(Point.fromObject(position).row) ?? "";
    return new Token({ value, scopes: [this.grammar.scopeName] });
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
    if (!NON_WHITESPACE_REGEX.test(line) && this.buffer) {
      const precedingRow = this.buffer.previousNonBlankRow(_row);
      if (precedingRow != null) {
        return this.indentLevelForLine(this.buffer.lineForRow(precedingRow), tabLength);
      }
    }
    let columns = 0;
    for (const character of line) {
      if (character === " ") {
        columns++;
      } else if (character === "\t") {
        columns += tabLength - (columns % tabLength);
      } else {
        break;
      }
    }
    return columns / tabLength;
  }
  suggestedIndentForBufferRow(row, tabLength) {
    const precedingRow = this.buffer?.previousNonBlankRow(row);
    if (precedingRow == null) return 0;
    return this.indentLevelForLine(this.buffer.lineForRow(precedingRow), tabLength);
  }
  isFoldableAtRow(row) {
    return this.endRowForFoldAtRow(row, 1, true) != null;
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
      if (this.indentLevelForLine(this.buffer.lineForRow(row), tabLength) === indentLevel) {
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
    const line = this.buffer.lineForRow(row);
    if (!NON_WHITESPACE_REGEX.test(line)) return;
    const startIndentLevel = this.indentLevelForLine(line, tabLength);
    let foldEndRow;
    for (let nextRow = row + 1; nextRow < this.buffer.getLineCount(); nextRow++) {
      const nextLine = this.buffer.lineForRow(nextRow);
      if (!NON_WHITESPACE_REGEX.test(nextLine)) continue;
      const indentation = this.indentLevelForLine(nextLine, tabLength);
      if (indentation <= startIndentLevel) break;
      foldEndRow = nextRow;
      if (existenceOnly) break;
    }
    return foldEndRow;
  }
  indentLevelForLine(line, tabLength) {
    return this.suggestedIndentForLineAtBufferRow(0, line, tabLength);
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
