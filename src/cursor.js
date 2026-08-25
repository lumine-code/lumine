const { Point, Range } = require("./text-buffer");
const { Emitter } = require("@lumine-code/event-kit");
const _ = require("@lumine-code/underscore-plus");
const Model = require("./model");

const EmptyLineRegExp = /(\r\n[\t ]*\r\n)|(\n[\t ]*\n)/g;

/**
 * @public
 * @status extended
 *
 * The `Cursor` class represents the little blinking line identifying
 * where text can be inserted.
 *
 * Cursors belong to {@link TextEditor TextEditors} and have some metadata attached in the form
 * of a {@link DisplayMarker}.
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
   * @public
   * @status public
   *
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
   */
  onDidChangePosition(callback) {
    return this.emitter.on("did-change-position", callback);
  }

  /**
   * @public
   * @status public
   *
   * Calls your `callback` when the cursor is destroyed
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @category Managing Cursor Position
   */

  /**
   * @public
   * @status public
   *
   * Moves a cursor to a given screen position.
   *
   * @param {Array} screenPosition - of two numbers: the screen row, and the screen column.
   * @param {Object} [options] - with the following keys:
   * @param options.autoscroll - A Boolean which, if `true`, scrolls the {@link TextEditor} to wherever the cursor moves to.
   */
  setScreenPosition(screenPosition, options = {}) {
    this.changePosition(options, () => {
      this.marker.setHeadScreenPosition(screenPosition, options);
    });
  }

  /**
   * @public
   * @status public
   *
   * @returns {Point} screen position of the cursor as a {@link Point}.
   */
  getScreenPosition() {
    return this.marker.getHeadScreenPosition();
  }

  /**
   * @public
   * @status public
   *
   * Moves a cursor to a given buffer position.
   *
   * @param {Array} bufferPosition - of two numbers: the buffer row, and the buffer column.
   * @param {Object} [options] - with the following keys:
   * @param {Boolean} options.autoscroll - indicating whether to autoscroll to the new position. Defaults to `true` if this is the most recently added cursor, `false` otherwise.
   */
  setBufferPosition(bufferPosition, options = {}) {
    this.changePosition(options, () => {
      this.marker.setHeadBufferPosition(bufferPosition, options);
    });
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} current buffer position as an Array.
   */
  getBufferPosition() {
    return this.marker.getHeadBufferPosition();
  }

  /**
   * @public
   * @status public
   *
   * @returns {Number} cursor's current screen row.
   */
  getScreenRow() {
    return this.getScreenPosition().row;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Number} cursor's current screen column.
   */
  getScreenColumn() {
    return this.getScreenPosition().column;
  }

  /**
   * @public
   * @status public
   *
   * Retrieves the cursor's current buffer row.
   */
  getBufferRow() {
    return this.getBufferPosition().row;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Number} cursor's current buffer column.
   */
  getBufferColumn() {
    return this.getBufferPosition().column;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Number} cursor's current buffer row of text excluding its line ending.
   */
  getCurrentBufferLine() {
    return this.editor.lineTextForBufferRow(this.getBufferRow());
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} whether the cursor is at the start of a line.
   */
  isAtBeginningOfLine() {
    return this.getBufferPosition().column === 0;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} whether the cursor is on the line return character.
   */
  isAtEndOfLine() {
    return this.getBufferPosition().isEqual(this.getCurrentLineBufferRange().end);
  }

  /**
   * @category Cursor Position Details
   */

  /**
   * @public
   * @status public
   *
   * @returns {DisplayMarker} underlying {@link DisplayMarker} for the cursor. Useful with overlay {@link Decoration Decorations}.
   */
  getMarker() {
    return this.marker;
  }

  /**
   * @public
   * @status public
   *
   * Identifies if the cursor is surrounded by whitespace.
   *
   * "Surrounded" here means that the character directly before and after the
   * cursor are both whitespace.
   *
   * @returns {Boolean}
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
   * @public
   * @status public
   *
   *
   * This method returns false if the character before or after the cursor is
   * whitespace.
   *
   * @returns {Boolean} Whether the cursor is between a word and non-word character. Non-word characters come from the `language.nonWordCharacters` setting.
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
   * @public
   * @status public
   *
   * @param {Object} [options]
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @returns {Boolean} whether this cursor is between a word's start and end.
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
   * @public
   * @status public
   *
   * @returns {Number} indentation level of the current line.
   */
  getIndentLevel() {
    if (this.editor.getSoftTabs()) {
      return this.getBufferColumn() / this.editor.getTabLength();
    } else {
      return this.getBufferColumn();
    }
  }

  /**
   * @public
   * @status public
   *
   * Retrieves the scope descriptor for the cursor's current position.
   *
   * @returns {ScopeDescriptor}
   */
  getScopeDescriptor() {
    return this.editor.scopeDescriptorForBufferPosition(this.getBufferPosition());
  }

  /**
   * @public
   * @status public
   *
   * Retrieves the syntax tree scope descriptor for the cursor's current position.
   *
   * @returns {ScopeDescriptor}
   */
  getSyntaxTreeScopeDescriptor() {
    return this.editor.syntaxTreeScopeDescriptorForBufferPosition(this.getBufferPosition());
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} true if this cursor has no non-whitespace characters before its current position.
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
   * @public
   * @status public
   *
   * Identifies if this cursor is the last in the {@link TextEditor}.
   *
   * "Last" is defined as the most recently added cursor.
   *
   * @returns {Boolean}
   */
  isLastCursor() {
    return this === this.editor.getLastCursor();
  }

  /**
   * @category Moving the Cursor
   */

  /**
   * @public
   * @status public
   *
   * Moves the cursor up one screen row.
   *
   * @param {Number} [rowCount] - number of rows to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the start of an
   *   existing selection.
   */
  moveUp(rowCount = 1, { moveToEndOfSelection } = {}) {
    let row, column;
    if (moveToEndOfSelection) {
      const range = this.marker.getScreenRange();
      if (!range.isEmpty()) {
        ({ row, column } = range.start);
      } else {
        ({ row, column } = this.getScreenPosition());
      }
    } else {
      ({ row, column } = this.getScreenPosition());
    }

    if (this.goalColumn != null) column = this.goalColumn;
    this.setScreenPosition({ row: row - rowCount, column }, { skipSoftWrapIndentation: true });
    this.goalColumn = column;
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor down one screen row.
   *
   * @param {Number} [rowCount] - number of rows to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the end of an
   *   existing selection.
   */
  moveDown(rowCount = 1, { moveToEndOfSelection } = {}) {
    let row, column;
    if (moveToEndOfSelection) {
      const range = this.marker.getScreenRange();
      if (!range.isEmpty()) {
        ({ row, column } = range.end);
      } else {
        ({ row, column } = this.getScreenPosition());
      }
    } else {
      ({ row, column } = this.getScreenPosition());
    }

    if (this.goalColumn != null) column = this.goalColumn;
    this.setScreenPosition({ row: row + rowCount, column }, { skipSoftWrapIndentation: true });
    this.goalColumn = column;
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor left one screen column.
   *
   * @param {Number} [columnCount] - number of columns to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the start of an
   *   existing selection.
   */
  moveLeft(columnCount = 1, { moveToEndOfSelection } = {}) {
    if (moveToEndOfSelection) {
      const range = this.marker.getScreenRange();
      if (!range.isEmpty()) {
        this.setScreenPosition(range.start);
        return;
      }
    }

    let { row, column } = this.getScreenPosition();

    while (columnCount > column && row > 0) {
      columnCount -= column;
      column = this.editor.lineLengthForScreenRow(--row);
      columnCount--; // subtract 1 for the row move
    }

    column = column - columnCount;
    this.setScreenPosition({ row, column }, { clipDirection: "backward" });
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor right one screen column.
   *
   * @param {Number} [columnCount] - number of columns to move (default: 1)
   * @param {Object} [options] - Movement options.
   * @param {Boolean} [options.moveToEndOfSelection] - Move to the end of an
   *   existing selection.
   */
  moveRight(columnCount = 1, { moveToEndOfSelection } = {}) {
    if (moveToEndOfSelection) {
      const range = this.marker.getScreenRange();
      if (!range.isEmpty()) {
        this.setScreenPosition(range.end);
        return;
      }
    }

    let { row, column } = this.getScreenPosition();
    let rowLength = this.editor.lineLengthForScreenRow(row);
    let columnsRemainingInLine = rowLength - column;

    while (columnCount > columnsRemainingInLine) {
      const nextRowLength = this.editor.lineLengthForScreenRow(row + 1);
      if (nextRowLength == null) break;

      columnCount -= columnsRemainingInLine;
      columnCount--; // subtract 1 for the row move

      column = 0;
      row++;
      rowLength = nextRowLength;
      columnsRemainingInLine = rowLength;
    }

    column = column + columnCount;
    this.setScreenPosition({ row, column }, { clipDirection: "forward" });
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the top of the buffer.
   */
  moveToTop() {
    this.setBufferPosition([0, 0]);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the bottom of the buffer.
   */
  moveToBottom() {
    const column = this.goalColumn;
    this.setBufferPosition(this.editor.getEofBufferPosition());
    this.goalColumn = column;
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the line.
   */
  moveToBeginningOfScreenLine() {
    this.setScreenPosition([this.getScreenRow(), 0]);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the buffer line.
   */
  moveToBeginningOfLine() {
    this.setBufferPosition([this.getBufferRow(), 0]);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the first character in the
   * line.
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
   * @public
   * @status public
   *
   * Moves the cursor to the end of the line.
   */
  moveToEndOfScreenLine() {
    this.setScreenPosition([this.getScreenRow(), Infinity]);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the end of the buffer line.
   */
  moveToEndOfLine() {
    this.setBufferPosition([this.getBufferRow(), Infinity]);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the word.
   */
  moveToBeginningOfWord() {
    this.setBufferPosition(this.getBeginningOfCurrentWordBufferPosition());
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the end of the word.
   */
  moveToEndOfWord() {
    const position = this.getEndOfCurrentWordBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the next word.
   */
  moveToBeginningOfNextWord() {
    const position = this.getBeginningOfNextWordBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the previous word boundary.
   */
  moveToPreviousWordBoundary() {
    const position = this.getPreviousWordBoundaryBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the next word boundary.
   */
  moveToNextWordBoundary() {
    const position = this.getNextWordBoundaryBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the previous subword boundary.
   */
  moveToPreviousSubwordBoundary() {
    const options = { wordRegex: this.subwordRegExp({ backwards: true }) };
    const position = this.getPreviousWordBoundaryBufferPosition(options);
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the next subword boundary.
   */
  moveToNextSubwordBoundary() {
    const options = { wordRegex: this.subwordRegExp() };
    const position = this.getNextWordBoundaryBufferPosition(options);
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the buffer line, skipping all
   * whitespace.
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
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the next paragraph
   */
  moveToBeginningOfNextParagraph() {
    const position = this.getBeginningOfNextParagraphBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @public
   * @status public
   *
   * Moves the cursor to the beginning of the previous paragraph
   */
  moveToBeginningOfPreviousParagraph() {
    const position = this.getBeginningOfPreviousParagraphBufferPosition();
    if (position) this.setBufferPosition(position);
  }

  /**
   * @category Local Positions and Ranges
   */

  /**
   * @public
   * @status public
   *
   * @param {Object} [options] - with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp})
   * @returns {Point} buffer position of previous word boundary. It might be on the current word, or the previous word.
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
   * @public
   * @status public
   *
   * @param {Object} [options] - with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp})
   * @returns {Point} buffer position of the next word boundary. It might be on the current word, or the previous word.
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
   * @public
   * @status public
   *
   * Retrieves the buffer position of where the current word starts.
   *
   * @param [options] - An `Object` with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @param options.includeNonWordCharacters - A `Boolean` indicating whether to include non-word characters in the default word regex. Has no effect if wordRegex is set.
   * @param options.allowPrevious - A `Boolean` indicating whether the beginning of the previous word can be returned.
   * @returns {Range}
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
   * @public
   * @status public
   *
   * Retrieves the buffer position of where the current word ends.
   *
   * @param {Object} [options] - with the following keys:
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp})
   * @param options.includeNonWordCharacters - A Boolean indicating whether to include non-word characters in the default word regex. Has no effect if wordRegex is set.
   * @returns {Range}
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
   * @public
   * @status public
   *
   * Retrieves the buffer position of where the next word starts.
   *
   * @param {Object} [options]
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @returns {Range}
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
   * @public
   * @status public
   *
   * @param {Object} [options]
   * @param options.wordRegex - A `RegExp` indicating what constitutes a "word" (default: {@link #wordRegExp}).
   * @returns {Range} buffer Range occupied by the word located under the cursor.
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
   * @public
   * @status public
   *
   * @param {Object} [options]
   * @param options.includeNewline - A `Boolean` which controls whether the Range should include the newline.
   * @returns {Range} buffer Range for the current line.
   */
  getCurrentLineBufferRange(options) {
    return this.editor.bufferRangeForBufferRow(this.getBufferRow(), options);
  }

  /**
   * @public
   * @status public
   *
   * Retrieves the range for the current paragraph.
   *
   * A paragraph is defined as a block of text surrounded by empty lines or comments.
   *
   * @returns {Range}
   */
  getCurrentParagraphBufferRange() {
    return this.editor.rowRangeForParagraphAtBufferRow(this.getBufferRow());
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} characters preceding the cursor in the current word.
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
   * @public
   * @status public
   *
   * Compare this cursor's buffer position to another cursor's buffer position.
   *
   * See {@link Point#compare} for more details.
   *
   * @param {Cursor} otherCursor - to compare against
   */
  compare(otherCursor) {
    return this.getBufferPosition().compare(otherCursor.getBufferPosition());
  }

  /**
   * @category Utilities
   */

  /**
   * @public
   * @status public
   *
   * Deselects the current selection.
   */
  clearSelection(options) {
    if (this.selection) this.selection.clear(options);
  }

  /**
   * @public
   * @status public
   *
   * Get the RegExp used by the cursor to determine what a "word" is.
   *
   * @param {Object} [options] - with the following keys:
   * @param options.includeNonWordCharacters - A `Boolean` indicating whether to include non-word characters in the regex. (default: true)
   * @returns {RegExp}
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
   * @public
   * @status public
   *
   * Get the RegExp used by the cursor to determine what a "subword" is.
   *
   * @param {Object} [options] - with the following keys:
   * @param options.backwards - A `Boolean` indicating whether to look forwards or backwards for the next subword. (default: false)
   * @returns {RegExp}
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
