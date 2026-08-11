const { Point, Range } = require("./text-buffer");
const { Emitter } = require("@lumine-code/event-kit");
const _ = require("@lumine-code/underscore-plus");
const Model = require("./model");

const EmptyLineRegExp = /(\r\n[\t ]*\r\n)|(\n[\t ]*\n)/g;

/**
 * The `Cursor` class represents the little blinking line identifying
 * where text can be inserted.
 *
 * Cursors belong to {@link TextEditor TextEditors} and have some metadata attached in the form
 * of a {@link DisplayMarker}.
 *
 * @public
 * @api-status Extended
 */
module.exports = class Cursor extends Model {
  // Instantiated by a {@link TextEditor}
  constructor(params) {
    super(params);
    this.editor = params.editor;
    this.marker = params.marker;
    this.emitter = new Emitter();
  }

  destroy() {
    this.marker.destroy();
  }

  /**
   * @category Event Subscription
   */

  /**
   * Calls your `callback` when the cursor has been moved.
   *
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {Point} callback.event.oldBufferPosition
   * @param {Point} callback.event.oldScreenPosition
   * @param {Point} callback.event.newBufferPosition
   * @param {Point} callback.event.newScreenPosition
   * @param {Boolean} callback.event.textChanged
   * @param {Cursor} callback.event.cursor - that triggered the event
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidChangePosition(callback) {
    return this.emitter.on("did-change-position", callback);
  }

  /**
   * Calls your `callback` when the cursor is destroyed
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   * @public
   * @api-status Public
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @category Managing Cursor Position
   */

  /**
   * Moves a cursor to a given screen position.
   *
   * @param {Array} screenPosition - of two numbers: the screen row, and the screen column.
   * @param {Object} [options] - with the following keys:
   * @param options.autoscroll - A Boolean which, if `true`, scrolls the {@link TextEditor} to wherever the cursor moves to.
   * @public
   * @api-status Public
   */
  setScreenPosition(screenPosition, options = {}) {
    this.changePosition(options, () => {
      this.marker.setHeadScreenPosition(screenPosition, options);
    });
  }

  /**
   * @returns {Point} screen position of the cursor as a {@link Point}.
   * @public
   * @api-status Public
   */
  getScreenPosition() {
    return this.marker.getHeadScreenPosition();
  }

  /**
   * Moves a cursor to a given buffer position.
   *
   * @param {Array} bufferPosition - of two numbers: the buffer row, and the buffer column.
   * @param {Object} [options] - with the following keys:
   * @param {Boolean} options.autoscroll - indicating whether to autoscroll to the new position. Defaults to `true` if this is the most recently added cursor, `false` otherwise.
   * @public
   * @api-status Public
   */
  setBufferPosition(bufferPosition, options = {}) {
    this.changePosition(options, () => {
      this.marker.setHeadBufferPosition(bufferPosition, options);
    });
  }

  /**
   * @returns {Array} current buffer position as an Array.
   * @public
   * @api-status Public
   */
  getBufferPosition() {
    return this.marker.getHeadBufferPosition();
  }

  /**
   * @returns {Number} cursor's current screen row.
   * @public
   * @api-status Public
   */
  getScreenRow() {
    return this.getScreenPosition().row;
  }

  /**
   * @returns {Number} cursor's current screen column.
   * @public
   * @api-status Public
   */
  getScreenColumn() {
    return this.getScreenPosition().column;
  }

  /**
   * Retrieves the cursor's current buffer row.
   *
   * @public
   * @api-status Public
   */
  getBufferRow() {
    return this.getBufferPosition().row;
  }

  /**
   * @returns {Number} cursor's current buffer column.
   * @public
   * @api-status Public
   */
  getBufferColumn() {
    return this.getBufferPosition().column;
  }

  /**
   * @returns {Number} cursor's current buffer row of text excluding its line ending.
   * @public
   * @api-status Public
   */
  getCurrentBufferLine() {
    return this.editor.lineTextForBufferRow(this.getBufferRow());
  }

  /**
   * @returns {Boolean} whether the cursor is at the start of a line.
   * @public
   * @api-status Public
   */
  isAtBeginningOfLine() {
    return this.getBufferPosition().column === 0;
  }

  /**
   * @returns {Boolean} whether the cursor is on the line return character.
   * @public
   * @api-status Public
   */
  isAtEndOfLine() {
    return this.getBufferPosition().isEqual(this.getCurrentLineBufferRange().end);
  }

  /**
   * @category Cursor Position Details
   */

  /**
   * @returns {DisplayMarker} underlying {@link DisplayMarker} for the cursor. Useful with overlay {@link Decoration Decorations}.
   * @public
   * @api-status Public
   */
  getMarker() {
    return this.marker;
  }

  /**
   * Identifies if the cursor is surrounded by whitespace.
   *
   * "Surrounded" here means that the character directly before and after the
   * cursor are both whitespace.
   *
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  isSurroundedByWhitespace() {
    const { row, column } = this.getBufferPosition();
    const range = [
      [row, column - 1],
      [row, column + 1],
    ];
    return /^\s+$/.test(this.editor.getTextInBufferRange(range));
  }

  /**
   *
   * This method returns false if the character before or after the cursor is
   * whitespace.
   *
   * @returns {Boolean} Whether the cursor is between a word and non-word character. Non-word characters come from the `language.nonWordCharacters` setting.
   * @public
   * @api-status Public
   */
  isBetweenWordAndNonWord() {
    if (this.isAtBeginningOfLine() || this.isAtEndOfLine()) return false;

    const { row, column } = this.getBufferPosition();
    const range = [
      [row, column - 1],
      [row, column + 1],
    ];
    const text = this.editor.getTextInBufferRange(range);
    if (/\s/.test(text[0]) || /\s/.test(text[1])) return false;

    const nonWordCharacters = this.getNonWordCharacters();
    return nonWordCharacters.includes(text[0]) !== nonWordCharacters.includes(text[1]);
  }

  /**
   * @param {Object} [options]
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @returns {Boolean} whether this cursor is between a word's start and end.
   * @public
   * @api-status Public
   */
  isInsideWord(options) {
    const { row, column } = this.getBufferPosition();
    const range = [
      [row, column],
      [row, Infinity],
    ];
    const text = this.editor.getTextInBufferRange(range);
    return text.search((options && options.wordRegex) || this.wordRegExp()) === 0;
  }

  /**
   * @returns {Number} indentation level of the current line.
   * @public
   * @api-status Public
   */
  getIndentLevel() {
    if (this.editor.getSoftTabs()) {
      return this.getBufferColumn() / this.editor.getTabLength();
    } else {
      return this.getBufferColumn();
    }
  }

  /**
   * Retrieves the scope descriptor for the cursor's current position.
   *
   * @returns {ScopeDescriptor}
   * @public
   * @api-status Public
   */
  getScopeDescriptor() {
    return this.editor.scopeDescriptorForBufferPosition(this.getBufferPosition());
  }

  /**
   * Retrieves the syntax tree scope descriptor for the cursor's current position.
   *
   * @returns {ScopeDescriptor}
   * @public
   * @api-status Public
   */
  getSyntaxTreeScopeDescriptor() {
    return this.editor.syntaxTreeScopeDescriptorForBufferPosition(this.getBufferPosition());
  }

  /**
   * @returns {Boolean} true if this cursor has no non-whitespace characters before its current position.
   * @public
   * @api-status Public
   */
  hasPrecedingCharactersOnLine() {
    const bufferPosition = this.getBufferPosition();
    const line = this.editor.lineTextForBufferRow(bufferPosition.row);
    const firstCharacterColumn = line.search(/\S/);

    if (firstCharacterColumn === -1) {
      return false;
    } else {
      return bufferPosition.column > firstCharacterColumn;
    }
  }

  /**
   * Identifies if this cursor is the last in the {@link TextEditor}.
   *
   * "Last" is defined as the most recently added cursor.
   *
   * @returns {Boolean}
   * @public
   * @api-status Public
   */
  isLastCursor() {
    return this === this.editor.getLastCursor();
  }

  /**
   * @category Moving the Cursor
   */

  /**
   * Moves the cursor up one screen row.
   *
   * @param {Number} [rowCount] - number of rows to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the start of an
   *   existing selection.
   * @public
   * @api-status Public
   */
  moveUp(rowCount = 1, { moveToEndOfSelection } = {}) {
    let row, column;
    const range = this.marker.getScreenRange();
    if (moveToEndOfSelection && !range.isEmpty()) {
      ({ row, column } = range.start);
    } else {
      ({ row, column } = this.getScreenPosition());
    }

    if (this.goalColumn != null) column = this.goalColumn;
    this.setScreenPosition({ row: row - rowCount, column }, { skipSoftWrapIndentation: true });
    this.goalColumn = column;
  }

  /**
   * Moves the cursor down one screen row.
   *
   * @param {Number} [rowCount] - number of rows to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the end of an
   *   existing selection.
   * @public
   * @api-status Public
   */
  moveDown(rowCount = 1, { moveToEndOfSelection } = {}) {
    let row, column;
    const range = this.marker.getScreenRange();
    if (moveToEndOfSelection && !range.isEmpty()) {
      ({ row, column } = range.end);
    } else {
      ({ row, column } = this.getScreenPosition());
    }

    if (this.goalColumn != null) column = this.goalColumn;
    this.setScreenPosition({ row: row + rowCount, column }, { skipSoftWrapIndentation: true });
    this.goalColumn = column;
  }

  /**
   * Moves the cursor left one screen column.
   *
   * @param {Number} [columnCount] - number of columns to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the start of an
   *   existing selection.
   * @public
   * @api-status Public
   */
  moveLeft(columnCount = 1, { moveToEndOfSelection } = {}) {
    const range = this.marker.getScreenRange();
    if (moveToEndOfSelection && !range.isEmpty()) {
      this.setScreenPosition(range.start);
    } else {
      let { row, column } = this.getScreenPosition();

      while (columnCount > column && row > 0) {
        columnCount -= column;
        column = this.editor.lineLengthForScreenRow(--row);
        columnCount--; // subtract 1 for the row move
      }

      column = column - columnCount;
      this.setScreenPosition({ row, column }, { clipDirection: "backward" });
    }
  }

  /**
   * Moves the cursor right one screen column.
   *
   * @param {Number} [columnCount] - number of columns to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the end of an
   *   existing selection.
   * @public
   * @api-status Public
   */
  moveRight(columnCount = 1, { moveToEndOfSelection } = {}) {
    const range = this.marker.getScreenRange();
    if (moveToEndOfSelection && !range.isEmpty()) {
      this.setScreenPosition(range.end);
    } else {
      let { row, column } = this.getScreenPosition();
      const maxLines = this.editor.getScreenLineCount();
      let rowLength = this.editor.lineLengthForScreenRow(row);
      let columnsRemainingInLine = rowLength - column;

      while (columnCount > columnsRemainingInLine && row < maxLines - 1) {
        columnCount -= columnsRemainingInLine;
        columnCount--; // subtract 1 for the row move

        column = 0;
        rowLength = this.editor.lineLengthForScreenRow(++row);
        columnsRemainingInLine = rowLength;
      }

      column = column + columnCount;
      this.setScreenPosition({ row, column }, { clipDirection: "forward" });
    }
  }

  /**
   * Moves the cursor to the top of the buffer.
   *
   * @public
   * @api-status Public
   */
  moveToTop() {
    this.setBufferPosition([0, 0]);
  }

  /**
   * Moves the cursor to the bottom of the buffer.
   *
   * @public
   * @api-status Public
   */
  moveToBottom() {
    const column = this.goalColumn;
    this.setBufferPosition(this.editor.getEofBufferPosition());
    this.goalColumn = column;
  }

  /**
   * Moves the cursor to the beginning of the line.
   *
   * @public
   * @api-status Public
   */
  moveToBeginningOfScreenLine() {
    this.setScreenPosition([this.getScreenRow(), 0]);
  }

  /**
   * Moves the cursor to the beginning of the buffer line.
   *
   * @public
   * @api-status Public
   */
  moveToBeginningOfLine() {
    this.setBufferPosition([this.getBufferRow(), 0]);
  }

  /**
   * Moves the cursor to the beginning of the first character in the
   * line.
   *
   * @public
   * @api-status Public
   */
  moveToFirstCharacterOfLine() {
    let targetBufferColumn;
    const screenRow = this.getScreenRow();
    const screenLineStart = this.editor.clipScreenPosition([screenRow, 0], {
      skipSoftWrapIndentation: true,
    });
    const screenLineEnd = [screenRow, Infinity];
    const screenLineBufferRange = this.editor.bufferRangeForScreenRange([
      screenLineStart,
      screenLineEnd,
    ]);

    let firstCharacterColumn = null;
    this.editor.scanInBufferRange(/\S/, screenLineBufferRange, ({ range, stop }) => {
      firstCharacterColumn = range.start.column;
      stop();
    });

    if (firstCharacterColumn != null && firstCharacterColumn !== this.getBufferColumn()) {
      targetBufferColumn = firstCharacterColumn;
    } else {
      targetBufferColumn = screenLineBufferRange.start.column;
    }

    this.setBufferPosition([screenLineBufferRange.start.row, targetBufferColumn]);
  }

  /**
   * Moves the cursor to the end of the line.
   *
   * @public
   * @api-status Public
   */
  moveToEndOfScreenLine() {
    this.setScreenPosition([this.getScreenRow(), Infinity]);
  }

  /**
   * Moves the cursor to the end of the buffer line.
   *
   * @public
   * @api-status Public
   */
  moveToEndOfLine() {
    this.setBufferPosition([this.getBufferRow(), Infinity]);
  }

  /**
   * Moves the cursor to the beginning of the word.
   *
   * @public
   * @api-status Public
   */
  moveToBeginningOfWord() {
    this.setBufferPosition(this.getBeginningOfCurrentWordBufferPosition());
  }

  /**
   * Moves the cursor to the end of the word.
   *
   * @public
   * @api-status Public
   */
  moveToEndOfWord() {
    const position = this.getEndOfCurrentWordBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the beginning of the next word.
   *
   * @public
   * @api-status Public
   */
  moveToBeginningOfNextWord() {
    const position = this.getBeginningOfNextWordBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the previous word boundary.
   *
   * @public
   * @api-status Public
   */
  moveToPreviousWordBoundary() {
    const position = this.getPreviousWordBoundaryBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the next word boundary.
   *
   * @public
   * @api-status Public
   */
  moveToNextWordBoundary() {
    const position = this.getNextWordBoundaryBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the previous subword boundary.
   *
   * @public
   * @api-status Public
   */
  moveToPreviousSubwordBoundary() {
    const options = { wordRegex: this.subwordRegExp({ backwards: true }) };
    const position = this.getPreviousWordBoundaryBufferPosition(options);
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the next subword boundary.
   *
   * @public
   * @api-status Public
   */
  moveToNextSubwordBoundary() {
    const options = { wordRegex: this.subwordRegExp() };
    const position = this.getNextWordBoundaryBufferPosition(options);
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the beginning of the buffer line, skipping all
   * whitespace.
   *
   * @public
   * @api-status Public
   */
  skipLeadingWhitespace() {
    const position = this.getBufferPosition();
    const scanRange = this.getCurrentLineBufferRange();
    let endOfLeadingWhitespace = null;
    this.editor.scanInBufferRange(/^[ \t]*/, scanRange, ({ range }) => {
      endOfLeadingWhitespace = range.end;
    });

    if (endOfLeadingWhitespace.isGreaterThan(position))
      this.setBufferPosition(endOfLeadingWhitespace);
  }

  /**
   * Moves the cursor to the beginning of the next paragraph
   *
   * @public
   * @api-status Public
   */
  moveToBeginningOfNextParagraph() {
    const position = this.getBeginningOfNextParagraphBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * Moves the cursor to the beginning of the previous paragraph
   *
   * @public
   * @api-status Public
   */
  moveToBeginningOfPreviousParagraph() {
    const position = this.getBeginningOfPreviousParagraphBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @category Local Positions and Ranges
   */

  /**
   * @param {Object} [options] - with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp})
   * @returns {Point} buffer position of previous word boundary. It might be on the current word, or the previous word.
   * @public
   * @api-status Public
   */
  getPreviousWordBoundaryBufferPosition(options = {}) {
    const currentBufferPosition = this.getBufferPosition();
    const previousNonBlankRow = this.editor.buffer.previousNonBlankRow(currentBufferPosition.row);
    const scanRange = Range(Point(previousNonBlankRow || 0, 0), currentBufferPosition);

    const ranges = this.editor.buffer.findAllInRangeSync(
      options.wordRegex || this.wordRegExp(),
      scanRange,
    );

    const range = ranges[ranges.length - 1];
    if (range) {
      if (range.start.row < currentBufferPosition.row && currentBufferPosition.column > 0) {
        return Point(currentBufferPosition.row, 0);
      } else if (currentBufferPosition.isGreaterThan(range.end)) {
        return Point.fromObject(range.end);
      } else {
        return Point.fromObject(range.start);
      }
    } else {
      return currentBufferPosition;
    }
  }

  /**
   * @param {Object} [options] - with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp})
   * @returns {Point} buffer position of the next word boundary. It might be on the current word, or the previous word.
   * @public
   * @api-status Public
   */
  getNextWordBoundaryBufferPosition(options = {}) {
    const currentBufferPosition = this.getBufferPosition();
    const scanRange = Range(currentBufferPosition, this.editor.getEofBufferPosition());

    const range = this.editor.buffer.findInRangeSync(
      options.wordRegex || this.wordRegExp(),
      scanRange,
    );

    if (range) {
      if (range.start.row > currentBufferPosition.row) {
        return Point(range.start.row, 0);
      } else if (currentBufferPosition.isLessThan(range.start)) {
        return Point.fromObject(range.start);
      } else {
        return Point.fromObject(range.end);
      }
    } else {
      return currentBufferPosition;
    }
  }

  /**
   * Retrieves the buffer position of where the current word starts.
   *
   * @param [options] - An `Object` with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @param options.includeNonWordCharacters - A `Boolean` indicating whether to include non-word characters in the default word regex. Has no effect if wordRegex is set.
   * @param options.allowPrevious - A `Boolean` indicating whether the beginning of the previous word can be returned.
   * @returns {Range}
   * @public
   * @api-status Public
   */
  getBeginningOfCurrentWordBufferPosition(options = {}) {
    const allowPrevious = options.allowPrevious !== false;
    const position = this.getBufferPosition();

    const scanRange = allowPrevious
      ? new Range(new Point(position.row - 1, 0), position)
      : new Range(new Point(position.row, 0), position);

    const ranges = this.editor.buffer.findAllInRangeSync(
      options.wordRegex || this.wordRegExp(options),
      scanRange,
    );

    let result;
    for (let range of ranges) {
      if (position.isLessThanOrEqual(range.start)) break;
      if (allowPrevious || position.isLessThanOrEqual(range.end))
        result = Point.fromObject(range.start);
    }

    return result || (allowPrevious ? new Point(0, 0) : position);
  }

  /**
   * Retrieves the buffer position of where the current word ends.
   *
   * @param {Object} [options] - with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp})
   * @param options.includeNonWordCharacters - A Boolean indicating whether to include non-word characters in the default word regex. Has no effect if wordRegex is set.
   * @returns {Range}
   * @public
   * @api-status Public
   */
  getEndOfCurrentWordBufferPosition(options = {}) {
    const allowNext = options.allowNext !== false;
    const position = this.getBufferPosition();

    const scanRange = allowNext
      ? new Range(position, new Point(position.row + 2, 0))
      : new Range(position, new Point(position.row, Infinity));

    const ranges = this.editor.buffer.findAllInRangeSync(
      options.wordRegex || this.wordRegExp(options),
      scanRange,
    );

    for (let range of ranges) {
      if (position.isLessThan(range.start) && !allowNext) break;
      if (position.isLessThan(range.end)) return Point.fromObject(range.end);
    }

    return allowNext ? this.editor.getEofBufferPosition() : position;
  }

  /**
   * Retrieves the buffer position of where the next word starts.
   *
   * @param {Object} [options]
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @returns {Range}
   * @public
   * @api-status Public
   */
  getBeginningOfNextWordBufferPosition(options = {}) {
    const currentBufferPosition = this.getBufferPosition();
    const start = this.isInsideWord(options)
      ? this.getEndOfCurrentWordBufferPosition(options)
      : currentBufferPosition;
    const scanRange = [start, this.editor.getEofBufferPosition()];

    let beginningOfNextWordPosition;
    this.editor.scanInBufferRange(
      options.wordRegex || this.wordRegExp(),
      scanRange,
      ({ range, stop }) => {
        beginningOfNextWordPosition = range.start;
        stop();
      },
    );

    return beginningOfNextWordPosition || currentBufferPosition;
  }

  /**
   * @param {Object} [options]
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @returns {Range} buffer Range occupied by the word located under the cursor.
   * @public
   * @api-status Public
   */
  getCurrentWordBufferRange(options = {}) {
    const position = this.getBufferPosition();
    const ranges = this.editor.buffer.findAllInRangeSync(
      options.wordRegex || this.wordRegExp(options),
      new Range(new Point(position.row, 0), new Point(position.row, Infinity)),
    );
    const range = ranges.find(
      (range) => range.end.column >= position.column && range.start.column <= position.column,
    );
    return range ? Range.fromObject(range) : new Range(position, position);
  }

  /**
   * @param {Object} [options]
   * @param options.includeNewline - A `Boolean` which controls whether the Range should include the newline.
   * @returns {Range} buffer Range for the current line.
   * @public
   * @api-status Public
   */
  getCurrentLineBufferRange(options) {
    return this.editor.bufferRangeForBufferRow(this.getBufferRow(), options);
  }

  /**
   * Retrieves the range for the current paragraph.
   *
   * A paragraph is defined as a block of text surrounded by empty lines or comments.
   *
   * @returns {Range}
   * @public
   * @api-status Public
   */
  getCurrentParagraphBufferRange() {
    return this.editor.rowRangeForParagraphAtBufferRow(this.getBufferRow());
  }

  /**
   * @returns {String} characters preceding the cursor in the current word.
   * @public
   * @api-status Public
   */
  getCurrentWordPrefix() {
    return this.editor.getTextInBufferRange([
      this.getBeginningOfCurrentWordBufferPosition(),
      this.getBufferPosition(),
    ]);
  }

  /**
   * @category Visibility
   */

  /**
   * @category Comparing to another cursor
   */

  /**
   * Compare this cursor's buffer position to another cursor's buffer position.
   *
   * See {@link Point#compare} for more details.
   *
   * @param {Cursor} otherCursor - to compare against
   * @public
   * @api-status Public
   */
  compare(otherCursor) {
    return this.getBufferPosition().compare(otherCursor.getBufferPosition());
  }

  /**
   * @category Utilities
   */

  /**
   * Deselects the current selection.
   *
   * @public
   * @api-status Public
   */
  clearSelection(options) {
    if (this.selection) this.selection.clear(options);
  }

  /**
   * Get the RegExp used by the cursor to determine what a "word" is.
   *
   * @param {Object} [options] - with the following keys:
   * @param options.includeNonWordCharacters - A `Boolean` indicating whether to include non-word characters in the regex. (default: true)
   * @returns {RegExp}
   * @public
   * @api-status Public
   */
  wordRegExp(options) {
    const nonWordCharacters = _.escapeRegExp(this.getNonWordCharacters());
    let source = `^[\t ]*$|[^\\s${nonWordCharacters}]+`;
    if (!options || options.includeNonWordCharacters !== false) {
      source += `|${`[${nonWordCharacters}]+`}`;
    }
    return new RegExp(source, "g");
  }

  /**
   * Get the RegExp used by the cursor to determine what a "subword" is.
   *
   * @param {Object} [options] - with the following keys:
   * @param options.backwards - A `Boolean` indicating whether to look forwards or backwards for the next subword. (default: false)
   * @returns {RegExp}
   * @public
   * @api-status Public
   */
  subwordRegExp(options = {}) {
    const nonWordCharacters = this.getNonWordCharacters();
    const lowercaseLetters = "a-z\\u00DF-\\u00F6\\u00F8-\\u00FF";
    const uppercaseLetters = "A-Z\\u00C0-\\u00D6\\u00D8-\\u00DE";
    const snakeCamelSegment = `[${uppercaseLetters}]?[${lowercaseLetters}]+`;
    const segments = [
      "^[\t ]+",
      "[\t ]+$",
      `[${uppercaseLetters}]+(?![${lowercaseLetters}])`,
      "\\d+",
    ];
    if (options.backwards) {
      segments.push(`${snakeCamelSegment}_*`);
      segments.push(`[${_.escapeRegExp(nonWordCharacters)}]+\\s*`);
    } else {
      segments.push(`_*${snakeCamelSegment}`);
      segments.push(`\\s*[${_.escapeRegExp(nonWordCharacters)}]+`);
    }
    segments.push("_+");
    return new RegExp(segments.join("|"), "g");
  }

  /**
   * @category Private
   */

  getNonWordCharacters() {
    return this.editor.getNonWordCharacters(this.getBufferPosition());
  }

  changePosition(options, fn) {
    this.clearSelection({ autoscroll: false });
    fn();
    this.goalColumn = null;
    const autoscroll =
      options && options.autoscroll != null ? options.autoscroll : this.isLastCursor();
    if (autoscroll) this.autoscroll();
  }

  getScreenRange() {
    const { row, column } = this.getScreenPosition();
    return new Range(new Point(row, column), new Point(row, column + 1));
  }

  autoscroll(options = {}) {
    options.clip = false;
    this.editor.scrollToScreenRange(this.getScreenRange(), options);
  }

  getBeginningOfNextParagraphBufferPosition() {
    const start = this.getBufferPosition();
    const eof = this.editor.getEofBufferPosition();
    const scanRange = [start, eof];

    const { row, column } = eof;
    let position = new Point(row, column - 1);

    this.editor.scanInBufferRange(EmptyLineRegExp, scanRange, ({ range, stop }) => {
      position = range.start.traverse(Point(1, 0));
      if (!position.isEqual(start)) stop();
    });
    return position;
  }

  getBeginningOfPreviousParagraphBufferPosition() {
    const start = this.getBufferPosition();

    const { row, column } = start;
    const scanRange = [
      [row - 1, column],
      [0, 0],
    ];
    let position = new Point(0, 0);
    this.editor.backwardsScanInBufferRange(EmptyLineRegExp, scanRange, ({ range, stop }) => {
      position = range.start.traverse(Point(1, 0));
      if (!position.isEqual(start)) stop();
    });
    return position;
  }
};
