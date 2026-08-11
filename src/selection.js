const { Point, Range } = require("./text-buffer");
const { pick } = require("@lumine-code/underscore-plus");
const { Emitter } = require("@lumine-code/event-kit");

const NonWhitespaceRegExp = /\S/;
let nextId = 0;

/**
 * @public
 * @status extended
 *
 * Represents a selection in the {@link TextEditor}.
 */
module.exports = class Selection {
  constructor({ cursor, marker, editor, id }) {
    this.id = id != null ? id : nextId++;
    this.cursor = cursor;
    this.marker = marker;
    this.editor = editor;
    this.emitter = new Emitter();
    this.initialScreenRange = null;
    this.wordwise = false;
    this.cursor.selection = this;
    this.decoration = this.editor.decorateMarker(this.marker, {
      type: "highlight",
      class: "selection",
    });
    this.marker.onDidChange((e) => this.markerDidChange(e));
    this.marker.onDidDestroy(() => this.markerDidDestroy());
  }

  destroy() {
    this.marker.destroy();
  }

  isLastSelection() {
    return this === this.editor.getLastSelection();
  }

  /**
   * @category Event Subscription
   */

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the selection was moved.
   *
   * @param {Function} callback
   * @param {Object} callback.event
   * @param {Range} callback.event.oldBufferRange
   * @param {Range} callback.event.oldScreenRange
   * @param {Range} callback.event.newBufferRange
   * @param {Range} callback.event.newScreenRange
   * @param {Selection} callback.event.selection - that triggered the event
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidChangeRange(callback) {
    return this.emitter.on("did-change-range", callback);
  }

  /**
   * @public
   * @status extended
   *
   * Calls your `callback` when the selection was destroyed
   *
   * @param {Function} callback
   * @returns {Disposable} on which `.dispose()` can be called to unsubscribe.
   */
  onDidDestroy(callback) {
    return this.emitter.once("did-destroy", callback);
  }

  /**
   * @category Managing the selection range
   */

  /**
   * @public
   * @status public
   *
   * @returns {Range} screen {@link Range} for the selection.
   */
  getScreenRange() {
    return this.marker.getScreenRange();
  }

  /**
   * @public
   * @status public
   *
   * Modifies the screen range for the selection.
   *
   * @param screenRange - The new {@link Range} to use.
   * @param {Object} [options] - options matching those found in {@link #setBufferRange}.
   */
  setScreenRange(screenRange, options) {
    return this.setBufferRange(this.editor.bufferRangeForScreenRange(screenRange), options);
  }

  /**
   * @public
   * @status public
   *
   * @returns {Range} buffer {@link Range} for the selection.
   */
  getBufferRange() {
    return this.marker.getBufferRange();
  }

  /**
   * @public
   * @status public
   *
   * Modifies the buffer {@link Range} for the selection.
   *
   * @param bufferRange - The new {@link Range} to select.
   * @param {Object} [options] - with the keys:
   * @param {Boolean} options.reversed - indicating whether to set the selection in a reversed orientation.
   * @param options.preserveFolds - if `true`, the fold settings are preserved after the selection moves.
   * @param {Boolean} options.autoscroll - indicating whether to autoscroll to the new range. Defaults to `true` if this is the most recently added selection, `false` otherwise.
   */
  setBufferRange(bufferRange, options = {}) {
    bufferRange = Range.fromObject(bufferRange);
    if (options.reversed == null) options.reversed = this.isReversed();
    if (!options.preserveFolds)
      this.editor.destroyFoldsContainingBufferPositions([bufferRange.start, bufferRange.end], true);
    this.modifySelection(() => {
      const needsFlash = options.flash;
      options.flash = null;
      this.marker.setBufferRange(bufferRange, options);
      const autoscroll = options.autoscroll != null ? options.autoscroll : this.isLastSelection();
      if (autoscroll) this.autoscroll();
      if (needsFlash) this.decoration.flash("flash", this.editor.selectionFlashDuration);
    });
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array<Number>} The starting and ending buffer rows highlighted by the selection.
   */
  getBufferRowRange() {
    const range = this.getBufferRange();
    const start = range.start.row;
    let end = range.end.row;
    if (range.end.column === 0) end = Math.max(start, end - 1);
    return [start, end];
  }

  getTailScreenPosition() {
    return this.marker.getTailScreenPosition();
  }

  getTailBufferPosition() {
    return this.marker.getTailBufferPosition();
  }

  getHeadScreenPosition() {
    return this.marker.getHeadScreenPosition();
  }

  getHeadBufferPosition() {
    return this.marker.getHeadBufferPosition();
  }

  /**
   * @category Info about the selection
   */

  /**
   * @public
   * @status public
   *
   * Determines if the selection contains anything.
   */
  isEmpty() {
    return this.getBufferRange().isEmpty();
  }

  /**
   * @public
   * @status public
   *
   * Determines if the ending position of a marker is greater than the
   * starting position.
   *
   * This can happen when, for example, you highlight text "up" in a {@link TextBuffer}.
   */
  isReversed() {
    return this.marker.isReversed();
  }

  /**
   * @public
   * @status public
   *
   * @returns {Boolean} whether the selection is a single line or not.
   */
  isSingleScreenLine() {
    return this.getScreenRange().isSingleLine();
  }

  /**
   * @public
   * @status public
   *
   * @returns {String} text in the selection.
   */
  getText() {
    return this.editor.buffer.getTextInRange(this.getBufferRange());
  }

  /**
   * @public
   * @status public
   *
   * Identifies if a selection intersects with a given buffer range.
   *
   * @param bufferRange - A {@link Range} to check against.
   * @returns {Boolean}
   */
  intersectsBufferRange(bufferRange) {
    return this.getBufferRange().intersectsWith(bufferRange);
  }

  intersectsScreenRowRange(startRow, endRow) {
    return this.getScreenRange().intersectsRowRange(startRow, endRow);
  }

  intersectsScreenRow(screenRow) {
    return this.getScreenRange().intersectsRow(screenRow);
  }

  /**
   * @public
   * @status public
   *
   * Identifies if a selection intersects with another selection.
   *
   * @param otherSelection - A {@link Selection} to check against.
   * @returns {Boolean}
   */
  intersectsWith(otherSelection, exclusive) {
    return this.getBufferRange().intersectsWith(otherSelection.getBufferRange(), exclusive);
  }

  /**
   * @category Modifying the selected range
   */

  /**
   * @public
   * @status public
   *
   * Clears the selection, moving the marker to the head.
   *
   * @param {Object} [options] - with the following keys:
   * @param {Boolean} options.autoscroll - indicating whether to autoscroll to the new range. Defaults to `true` if this is the most recently added selection, `false` otherwise.
   */
  clear(options) {
    this.goalScreenRange = null;
    if (!this.retainSelection) this.marker.clearTail();
    const autoscroll =
      options && options.autoscroll != null ? options.autoscroll : this.isLastSelection();
    if (autoscroll) this.autoscroll();
    this.finalize();
  }

  /**
   * @public
   * @status public
   *
   * Selects the text from the current cursor position to a given screen
   * position.
   *
   * @param position - An instance of {@link Point}, with a given `row` and `column`.
   */
  selectToScreenPosition(position, options) {
    position = Point.fromObject(position);

    this.modifySelection(() => {
      if (this.initialScreenRange) {
        if (position.isLessThan(this.initialScreenRange.start)) {
          this.marker.setScreenRange([position, this.initialScreenRange.end], {
            reversed: true,
          });
        } else {
          this.marker.setScreenRange([this.initialScreenRange.start, position], {
            reversed: false,
          });
        }
      } else {
        this.cursor.setScreenPosition(position, options);
      }

      if (this.linewise) {
        this.expandOverLine(options);
      } else if (this.wordwise) {
        this.expandOverWord(options);
      }
    });
  }

  /**
   * @public
   * @status public
   *
   * Selects the text from the current cursor position to a given buffer
   * position.
   *
   * @param position - An instance of {@link Point}, with a given `row` and `column`.
   */
  selectToBufferPosition(position) {
    this.modifySelection(() => this.cursor.setBufferPosition(position));
  }

  /**
   * @public
   * @status public
   *
   * Selects the text one position right of the cursor.
   *
   * @param {Number} [columnCount] - number of columns to select (default: 1)
   */
  selectRight(columnCount) {
    this.modifySelection(() => this.cursor.moveRight(columnCount));
  }

  /**
   * @public
   * @status public
   *
   * Selects the text one position left of the cursor.
   *
   * @param {Number} [columnCount] - number of columns to select (default: 1)
   */
  selectLeft(columnCount) {
    this.modifySelection(() => this.cursor.moveLeft(columnCount));
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text one position above the cursor.
   *
   * @param {Number} [rowCount] - number of rows to select (default: 1)
   */
  selectUp(rowCount) {
    this.modifySelection(() => this.cursor.moveUp(rowCount));
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text one position below the cursor.
   *
   * @param {Number} [rowCount] - number of rows to select (default: 1)
   */
  selectDown(rowCount) {
    this.modifySelection(() => this.cursor.moveDown(rowCount));
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the top of
   * the buffer.
   */
  selectToTop() {
    this.modifySelection(() => this.cursor.moveToTop());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the bottom
   * of the buffer.
   */
  selectToBottom() {
    this.modifySelection(() => this.cursor.moveToBottom());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text in the buffer.
   */
  selectAll() {
    this.setBufferRange(this.editor.buffer.getRange(), { autoscroll: false });
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the
   * beginning of the line.
   */
  selectToBeginningOfLine() {
    this.modifySelection(() => this.cursor.moveToBeginningOfLine());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the first
   * character of the line.
   */
  selectToFirstCharacterOfLine() {
    this.modifySelection(() => this.cursor.moveToFirstCharacterOfLine());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the end of
   * the screen line.
   */
  selectToEndOfLine() {
    this.modifySelection(() => this.cursor.moveToEndOfScreenLine());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the end of
   * the buffer line.
   */
  selectToEndOfBufferLine() {
    this.modifySelection(() => this.cursor.moveToEndOfLine());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the
   * beginning of the word.
   */
  selectToBeginningOfWord() {
    this.modifySelection(() => this.cursor.moveToBeginningOfWord());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the end of
   * the word.
   */
  selectToEndOfWord() {
    this.modifySelection(() => this.cursor.moveToEndOfWord());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the
   * beginning of the next word.
   */
  selectToBeginningOfNextWord() {
    this.modifySelection(() => this.cursor.moveToBeginningOfNextWord());
  }

  /**
   * @public
   * @status public
   *
   * Selects text to the previous word boundary.
   */
  selectToPreviousWordBoundary() {
    this.modifySelection(() => this.cursor.moveToPreviousWordBoundary());
  }

  /**
   * @public
   * @status public
   *
   * Selects text to the next word boundary.
   */
  selectToNextWordBoundary() {
    this.modifySelection(() => this.cursor.moveToNextWordBoundary());
  }

  /**
   * @public
   * @status public
   *
   * Selects text to the previous subword boundary.
   */
  selectToPreviousSubwordBoundary() {
    this.modifySelection(() => this.cursor.moveToPreviousSubwordBoundary());
  }

  /**
   * @public
   * @status public
   *
   * Selects text to the next subword boundary.
   */
  selectToNextSubwordBoundary() {
    this.modifySelection(() => this.cursor.moveToNextSubwordBoundary());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the
   * beginning of the next paragraph.
   */
  selectToBeginningOfNextParagraph() {
    this.modifySelection(() => this.cursor.moveToBeginningOfNextParagraph());
  }

  /**
   * @public
   * @status public
   *
   * Selects all the text from the current cursor position to the
   * beginning of the previous paragraph.
   */
  selectToBeginningOfPreviousParagraph() {
    this.modifySelection(() => this.cursor.moveToBeginningOfPreviousParagraph());
  }

  /**
   * @public
   * @status public
   *
   * Modifies the selection to encompass the current subword.
   *
   * @returns {Range}
   */
  selectSubword(options = {}) {
    options.wordRegex = this.cursor.subwordRegExp();
    this.setBufferRange(this.cursor.getCurrentWordBufferRange(options), options);
    this.wordwise = true;
    this.initialScreenRange = this.getScreenRange();
  }

  /**
   * @public
   * @status public
   *
   * Modifies the selection to encompass the current word.
   *
   * @returns {Range}
   */
  selectWord(options = {}) {
    if (this.cursor.isSurroundedByWhitespace()) options.wordRegex = /[\t ]*/;
    if (this.cursor.isBetweenWordAndNonWord()) {
      options.includeNonWordCharacters = false;
    }

    this.setBufferRange(this.cursor.getCurrentWordBufferRange(options), options);
    this.wordwise = true;
    this.initialScreenRange = this.getScreenRange();
  }

  /**
   * @public
   * @status public
   *
   * Expands the newest selection to include the entire word on which
   * the cursors rests.
   */
  expandOverWord(options) {
    this.setBufferRange(this.getBufferRange().union(this.cursor.getCurrentWordBufferRange()), {
      autoscroll: false,
    });
    const autoscroll =
      options && options.autoscroll != null ? options.autoscroll : this.isLastSelection();
    if (autoscroll) this.cursor.autoscroll();
  }

  /**
   * @public
   * @status public
   *
   * Selects an entire line in the buffer.
   *
   * @param row - The line `Number` to select (default: the row of the cursor).
   */
  selectLine(row, options) {
    if (row != null) {
      this.setBufferRange(
        this.editor.bufferRangeForBufferRow(row, { includeNewline: true }),
        options,
      );
    } else {
      const startRange = this.editor.bufferRangeForBufferRow(
        this.marker.getStartBufferPosition().row,
      );
      const endRange = this.editor.bufferRangeForBufferRow(this.marker.getEndBufferPosition().row, {
        includeNewline: true,
      });
      this.setBufferRange(startRange.union(endRange), options);
    }

    this.linewise = true;
    this.wordwise = false;
    this.initialScreenRange = this.getScreenRange();
  }

  /**
   * @public
   * @status public
   *
   * Expands the newest selection to include the entire line on which
   * the cursor currently rests.
   *
   * It also includes the newline character.
   */
  expandOverLine(options) {
    const range = this.getBufferRange().union(
      this.cursor.getCurrentLineBufferRange({ includeNewline: true }),
    );
    this.setBufferRange(range, { autoscroll: false });
    const autoscroll =
      options && options.autoscroll != null ? options.autoscroll : this.isLastSelection();
    if (autoscroll) this.cursor.autoscroll();
  }

  /**
   * Ensure that the {@link TextEditor} is not marked read-only before allowing a buffer modification to occur. if
   * the editor is read-only, require an explicit opt-in option to proceed (`bypassReadOnly`) or throw an Error.
   *
   * @private
   */
  ensureWritable(methodName, opts) {
    if (!opts.bypassReadOnly && this.editor.isReadOnly()) {
      if (lumine.window.isDevMode() || lumine.window.isSpecMode()) {
        const e = new Error("Attempt to mutate a read-only TextEditor through a Selection");
        e.detail =
          `Your package is attempting to call ${methodName} on a selection within an editor that has been marked ` +
          " read-only. Pass {bypassReadOnly: true} to modify it anyway, or test editors with .isReadOnly() before " +
          " attempting modifications.";
        throw e;
      }

      return false;
    }

    return true;
  }

  /**
   * @category Modifying the selected text
   */

  /**
   * @public
   * @status public
   *
   * Replaces text at the current selection.
   *
   * @param text - A `String` representing the text to add
   * @param {Object} [options] - with keys:
   * @param options.select - If `true`, selects the newly added text.
   * @param options.autoIndent - If `true`, indents all inserted text appropriately.
   * @param options.autoIndentNewline - If `true`, indent newline appropriately.
   * @param options.autoDecreaseIndent - If `true`, decreases indent level appropriately (for example, when a closing bracket is inserted).
   * @param options.preserveTrailingLineIndentation - By default, when pasting multiple lines, Lumine attempts to preserve the relative indent level between the first line and trailing lines, even if the indent level of the first line has changed from the copied text. If this option is `true`, this behavior is suppressed. level between the first lines and the trailing lines.
   * @param {Boolean} [options.normalizeLineEndings] - (default: true)
   * @param options.undo - *Deprecated* If `skip`, skips the undo stack for this operation. This property is deprecated. Call groupLastChanges() on the {@link TextBuffer} afterward instead.
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify a read-only editor. (default: false)
   */
  insertText(text, options = {}) {
    if (!this.ensureWritable("insertText", options)) return;

    let desiredIndentLevel, indentAdjustment;
    const oldBufferRange = this.getBufferRange();
    const wasReversed = this.isReversed();
    this.clear(options);

    let autoIndentFirstLine = false;
    const precedingText = this.editor.getTextInRange([
      [oldBufferRange.start.row, 0],
      oldBufferRange.start,
    ]);
    const remainingLines = text.split("\n");
    const firstInsertedLine = remainingLines.shift();

    if (options.indentBasis != null && !options.preserveTrailingLineIndentation) {
      indentAdjustment = this.editor.indentLevelForLine(precedingText) - options.indentBasis;
      this.adjustIndent(remainingLines, indentAdjustment);
    }

    const textIsAutoIndentable = text === "\n" || text === "\r\n" || NonWhitespaceRegExp.test(text);
    if (
      options.autoIndent &&
      textIsAutoIndentable &&
      !NonWhitespaceRegExp.test(precedingText) &&
      remainingLines.length > 0
    ) {
      autoIndentFirstLine = true;
      const firstLine = precedingText + firstInsertedLine;
      const languageMode = this.editor.buffer.getLanguageMode();
      desiredIndentLevel =
        languageMode.suggestedIndentForLineAtBufferRow &&
        languageMode.suggestedIndentForLineAtBufferRow(
          oldBufferRange.start.row,
          firstLine,
          this.editor.getTabLength(),
        );
      if (desiredIndentLevel != null) {
        indentAdjustment = desiredIndentLevel - this.editor.indentLevelForLine(firstLine);
        this.adjustIndent(remainingLines, indentAdjustment);
      }
    }

    text = firstInsertedLine;
    if (remainingLines.length > 0) text += `\n${remainingLines.join("\n")}`;

    const newBufferRange = this.editor.buffer.setTextInRange(
      oldBufferRange,
      text,
      pick(options, "undo", "normalizeLineEndings"),
    );

    if (options.select) {
      this.setBufferRange(newBufferRange, { reversed: wasReversed });
    } else {
      if (wasReversed) this.cursor.setBufferPosition(newBufferRange.end);
    }

    if (autoIndentFirstLine) {
      this.editor.setIndentationForBufferRow(oldBufferRange.start.row, desiredIndentLevel);
    }

    if (options.autoIndentNewline && text === "\n") {
      this.editor.autoIndentBufferRow(newBufferRange.end.row, {
        preserveLeadingWhitespace: true,
        skipBlankLines: false,
      });
    } else if (options.autoDecreaseIndent && NonWhitespaceRegExp.test(text)) {
      this.editor.autoDecreaseIndentForBufferRow(newBufferRange.start.row);
    }

    const autoscroll = options.autoscroll != null ? options.autoscroll : this.isLastSelection();
    if (autoscroll) this.autoscroll();

    return newBufferRange;
  }

  /**
   * @public
   * @status public
   *
   * Removes the first character before the selection if the selection
   * is empty otherwise it deletes the selection.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  backspace(options = {}) {
    if (!this.ensureWritable("backspace", options)) return;
    if (this.isEmpty()) this.selectLeft();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes the selection or, if nothing is selected, then all
   * characters from the start of the selection back to the previous word
   * boundary.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToPreviousWordBoundary(options = {}) {
    if (!this.ensureWritable("deleteToPreviousWordBoundary", options)) return;
    if (this.isEmpty()) this.selectToPreviousWordBoundary();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes the selection or, if nothing is selected, then all
   * characters from the start of the selection up to the next word
   * boundary.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToNextWordBoundary(options = {}) {
    if (!this.ensureWritable("deleteToNextWordBoundary", options)) return;
    if (this.isEmpty()) this.selectToNextWordBoundary();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes from the start of the selection to the beginning of the
   * current word if the selection is empty otherwise it deletes the selection.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToBeginningOfWord(options = {}) {
    if (!this.ensureWritable("deleteToBeginningOfWord", options)) return;
    if (this.isEmpty()) this.selectToBeginningOfWord();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes from the beginning of the line which the selection begins on
   * all the way through to the end of the selection.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToBeginningOfLine(options = {}) {
    if (!this.ensureWritable("deleteToBeginningOfLine", options)) return;
    if (this.isEmpty() && this.cursor.isAtBeginningOfLine()) {
      this.selectLeft();
    } else {
      this.selectToBeginningOfLine();
    }
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes the selection or the next character after the start of the
   * selection if the selection is empty.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  delete(options = {}) {
    if (!this.ensureWritable("delete", options)) return;
    if (this.isEmpty()) this.selectRight();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * If the selection is empty, removes all text from the cursor to the
   * end of the line. If the cursor is already at the end of the line, it
   * removes the following newline. If the selection isn't empty, only deletes
   * the contents of the selection.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToEndOfLine(options = {}) {
    if (!this.ensureWritable("deleteToEndOfLine", options)) return;
    if (this.isEmpty()) {
      if (this.cursor.isAtEndOfLine()) {
        this.delete(options);
        return;
      }
      this.selectToEndOfLine();
    }
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes the selection or all characters from the start of the
   * selection to the end of the current word if nothing is selected.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToEndOfWord(options = {}) {
    if (!this.ensureWritable("deleteToEndOfWord", options)) return;
    if (this.isEmpty()) this.selectToEndOfWord();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes the selection or all characters from the start of the
   * selection to the end of the current word if nothing is selected.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToBeginningOfSubword(options = {}) {
    if (!this.ensureWritable("deleteToBeginningOfSubword", options)) return;
    if (this.isEmpty()) this.selectToPreviousSubwordBoundary();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes the selection or all characters from the start of the
   * selection to the end of the current word if nothing is selected.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteToEndOfSubword(options = {}) {
    if (!this.ensureWritable("deleteToEndOfSubword", options)) return;
    if (this.isEmpty()) this.selectToNextSubwordBoundary();
    this.deleteSelectedText(options);
  }

  /**
   * @public
   * @status public
   *
   * Removes only the selected text.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteSelectedText(options = {}) {
    if (!this.ensureWritable("deleteSelectedText", options)) return;
    const bufferRange = this.getBufferRange();
    if (!bufferRange.isEmpty()) this.editor.buffer.delete(bufferRange);
    if (this.cursor) this.cursor.setBufferPosition(bufferRange.start);
  }

  /**
   * @public
   * @status public
   *
   * Removes the line at the beginning of the selection if the selection
   * is empty unless the selection spans multiple lines in which case all lines
   * are removed.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  deleteLine(options = {}) {
    if (!this.ensureWritable("deleteLine", options)) return;
    const range = this.getBufferRange();
    if (range.isEmpty()) {
      const start = this.cursor.getScreenRow();
      const range = this.editor.bufferRowsForScreenRows(start, start + 1);
      if (range[1] > range[0]) {
        this.editor.buffer.deleteRows(range[0], range[1] - 1);
      } else {
        this.editor.buffer.deleteRow(range[0]);
      }
    } else {
      const start = range.start.row;
      let end = range.end.row;
      if (end !== this.editor.buffer.getLastRow() && range.end.column === 0) end--;
      this.editor.buffer.deleteRows(start, end);
    }
    this.cursor.setBufferPosition({
      row: this.cursor.getBufferRow(),
      column: range.start.column,
    });
  }

  /**
   * @public
   * @status public
   *
   * Joins the current line with the one below it. Lines will
   * be separated by a single space.
   *
   * If there selection spans more than one line, all the lines are joined together.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  joinLines(options = {}) {
    if (!this.ensureWritable("joinLines", options)) return;
    let joinMarker;
    const selectedRange = this.getBufferRange();
    if (selectedRange.isEmpty()) {
      if (selectedRange.start.row === this.editor.buffer.getLastRow()) return;
    } else {
      joinMarker = this.editor.markBufferRange(selectedRange, {
        invalidate: "never",
      });
    }

    const rowCount = Math.max(1, selectedRange.getRowCount() - 1);
    for (let i = 0; i < rowCount; i++) {
      this.cursor.setBufferPosition([selectedRange.start.row]);
      this.cursor.moveToEndOfLine();

      // Remove trailing whitespace from the current line
      const scanRange = this.cursor.getCurrentLineBufferRange();
      let trailingWhitespaceRange = null;
      this.editor.scanInBufferRange(/[ \t]+$/, scanRange, ({ range }) => {
        trailingWhitespaceRange = range;
      });
      if (trailingWhitespaceRange) {
        this.setBufferRange(trailingWhitespaceRange);
        this.deleteSelectedText(options);
      }

      const currentRow = selectedRange.start.row;
      const nextRow = currentRow + 1;
      const insertSpace =
        nextRow <= this.editor.buffer.getLastRow() &&
        this.editor.buffer.lineLengthForRow(nextRow) > 0 &&
        this.editor.buffer.lineLengthForRow(currentRow) > 0;
      if (insertSpace) this.insertText(" ", options);

      this.cursor.moveToEndOfLine();

      // Remove leading whitespace from the line below
      this.modifySelection(() => {
        this.cursor.moveRight();
        this.cursor.moveToFirstCharacterOfLine();
      });
      this.deleteSelectedText(options);

      if (insertSpace) this.cursor.moveLeft();
    }

    if (joinMarker) {
      const newSelectedRange = joinMarker.getBufferRange();
      this.setBufferRange(newSelectedRange);
      joinMarker.destroy();
    }
  }

  /**
   * @public
   * @status public
   *
   * Removes one level of indent from the currently selected rows.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  outdentSelectedRows(options = {}) {
    if (!this.ensureWritable("outdentSelectedRows", options)) return;
    const [start, end] = this.getBufferRowRange();
    const { buffer } = this.editor;
    const leadingTabRegex = new RegExp(`^( {1,${this.editor.getTabLength()}}|\t)`);
    for (let row = start; row <= end; row++) {
      const match = buffer.lineForRow(row).match(leadingTabRegex);
      if (match && match[0].length > 0) {
        buffer.delete([
          [row, 0],
          [row, match[0].length],
        ]);
      }
    }
  }

  /**
   * @public
   * @status public
   *
   * Sets the indentation level of all selected rows to values suggested
   * by the relevant grammars.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  autoIndentSelectedRows(options = {}) {
    if (!this.ensureWritable("autoIndentSelectedRows", options)) return;
    const [start, end] = this.getBufferRowRange();
    return this.editor.autoIndentBufferRows(start, end);
  }

  /**
   * @public
   * @status public
   *
   * Wraps the selected lines in comments if they aren't currently part
   * of a comment.
   *
   * Removes the comment if they are currently wrapped in a comment.
   *
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  toggleLineComments(options = {}) {
    if (!this.ensureWritable("toggleLineComments", options)) return;
    let bufferRowRange = this.getBufferRowRange() || [null, null];
    this.editor.toggleLineCommentsForBufferRows(...bufferRowRange, {
      correctSelection: true,
      selection: this,
    });
  }

  /**
   * @public
   * @status public
   *
   * Cuts the selection until the end of the screen line.
   *
   * @param {Boolean} maintainClipboard
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  cutToEndOfLine(maintainClipboard, options = {}) {
    if (!this.ensureWritable("cutToEndOfLine", options)) return;
    if (this.isEmpty()) this.selectToEndOfLine();
    return this.cut(maintainClipboard, false, options.bypassReadOnly);
  }

  /**
   * @public
   * @status public
   *
   * Cuts the selection until the end of the buffer line.
   *
   * @param {Boolean} maintainClipboard
   * @param {Object} [options]
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  cutToEndOfBufferLine(maintainClipboard, options = {}) {
    if (!this.ensureWritable("cutToEndOfBufferLine", options)) return;
    if (this.isEmpty()) this.selectToEndOfBufferLine();
    this.cut(maintainClipboard, false, options.bypassReadOnly);
  }

  /**
   * @public
   * @status public
   *
   * Copies the selection to the clipboard and then deletes it.
   *
   * @param {Boolean} maintainClipboard - (default: false) See {@link #copy}
   * @param {Boolean} fullLine - (default: false) See {@link #copy}
   * @param {Boolean} bypassReadOnly - (default: false) Must be `true` to modify text within a read-only editor.
   */
  cut(
    maintainClipboard = false,
    fullLine = false,
    bypassReadOnly = false,
    clipboard = this.editor.constructor.clipboard,
  ) {
    if (!this.ensureWritable("cut", { bypassReadOnly })) return;
    this.copy(maintainClipboard, fullLine, clipboard);
    this.delete({ bypassReadOnly });
  }

  /**
   * @public
   * @status public
   *
   * Copies the current selection to the clipboard.
   *
   * @param {Boolean} maintainClipboard - if `true`, a specific metadata property is created to store each content copied to the clipboard. The clipboard `text` still contains the concatenation of the clipboard with the current selection. (default: false)
   * @param {Boolean} fullLine - if `true`, the copied text will always be pasted at the beginning of the line containing the cursor, regardless of the cursor's horizontal position. (default: false)
   */
  copy(maintainClipboard = false, fullLine = false, clipboard = this.editor.constructor.clipboard) {
    if (this.isEmpty()) return;
    const { start, end } = this.getBufferRange();
    const selectionText = this.editor.getTextInRange([start, end]);
    const precedingText = this.editor.getTextInRange([[start.row, 0], start]);
    const startLevel = this.editor.indentLevelForLine(precedingText);

    if (maintainClipboard) {
      let { text: clipboardText, metadata } = clipboard.readWithMetadata();
      if (!metadata) metadata = {};
      if (!metadata.selections) {
        metadata.selections = [
          {
            text: clipboardText,
            indentBasis: metadata.indentBasis,
            fullLine: metadata.fullLine,
          },
        ];
      }
      metadata.selections.push({
        text: selectionText,
        indentBasis: startLevel,
        fullLine,
      });
      clipboard.write([clipboardText, selectionText].join("\n"), metadata);
    } else {
      clipboard.write(selectionText, {
        indentBasis: startLevel,
        fullLine,
      });
    }
  }

  /**
   * @public
   * @status public
   *
   * Creates a fold containing the current selection.
   */
  fold() {
    const range = this.getBufferRange();
    if (!range.isEmpty()) {
      this.editor.foldBufferRange(range);
      this.cursor.setBufferPosition(range.end);
    }
  }

  /**
   * Increase the indentation level of the given text by given number
   * of levels. Leaves the first line unchanged.
   *
   * @private
   */
  adjustIndent(lines, indentAdjustment) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (indentAdjustment === 0 || line === "") {
        continue;
      } else if (indentAdjustment > 0) {
        lines[i] = this.editor.buildIndentString(indentAdjustment) + line;
      } else {
        const currentIndentLevel = this.editor.indentLevelForLine(lines[i]);
        const indentLevel = Math.max(0, currentIndentLevel + indentAdjustment);
        lines[i] = line.replace(/^[\t ]+/, this.editor.buildIndentString(indentLevel));
      }
    }
  }

  // Indent the current line(s).
  //
  // If the selection is empty, indents the current line if the cursor precedes
  // non-whitespace characters, and otherwise inserts a tab. If the selection is
  // non empty, calls {@link #indentSelectedRows}.
  //
  // * `options` (optional) `Object` with the keys:
  //   * `autoIndent` If `true`, the line is indented to an automatically-inferred
  //     level. Otherwise, {@link TextEditor#getTabText} is inserted.
  //   * `bypassReadOnly` (optional) `Boolean` Must be `true` to modify text within a read-only editor. (default: false)
  indent({ autoIndent, bypassReadOnly } = {}) {
    if (!this.ensureWritable("indent", { bypassReadOnly })) return;
    const { row } = this.cursor.getBufferPosition();

    if (this.isEmpty()) {
      this.cursor.skipLeadingWhitespace();
      const desiredIndent = this.editor.suggestedIndentForBufferRow(row);
      let delta = desiredIndent - this.cursor.getIndentLevel();

      if (autoIndent && delta > 0) {
        if (!this.editor.getSoftTabs()) delta = Math.max(delta, 1);
        this.insertText(this.editor.buildIndentString(delta), {
          bypassReadOnly,
        });
      } else {
        this.insertText(this.editor.buildIndentString(1, this.cursor.getBufferColumn()), {
          bypassReadOnly,
        });
      }
    } else {
      this.indentSelectedRows({ bypassReadOnly });
    }
  }

  /**
   * @public
   * @status public
   *
   * If the selection spans multiple rows, indent all of them.
   *
   * @param {Object} [options] - with the keys:
   * @param {Boolean} [options.bypassReadOnly] - Must be `true` to modify text within a read-only editor. (default: false)
   */
  indentSelectedRows(options = {}) {
    if (!this.ensureWritable("indentSelectedRows", options)) return;
    const [start, end] = this.getBufferRowRange();
    for (let row = start; row <= end; row++) {
      if (this.editor.buffer.lineLengthForRow(row) !== 0) {
        this.editor.buffer.insert([row, 0], this.editor.getTabText());
      }
    }
  }

  /**
   * @category Managing multiple selections
   */

  /**
   * @public
   * @status public
   *
   * Moves the selection down one row.
   */
  addSelectionBelow() {
    const range = this.getGoalScreenRange().copy();
    const nextRow = range.end.row + 1;

    for (let row = nextRow, end = this.editor.getLastScreenRow(); row <= end; row++) {
      range.start.row = row;
      range.end.row = row;
      const clippedRange = this.editor.clipScreenRange(range, {
        skipSoftWrapIndentation: true,
      });

      if (range.isEmpty()) {
        if (range.end.column > 0 && clippedRange.end.column === 0) continue;
      } else {
        if (clippedRange.isEmpty()) continue;
      }

      const containingSelections = this.editor.selectionsMarkerLayer.findMarkers({
        containsScreenRange: clippedRange,
      });
      if (containingSelections.length === 0) {
        const selection = this.editor.addSelectionForScreenRange(clippedRange);
        selection.setGoalScreenRange(range);
      }

      break;
    }
  }

  /**
   * @public
   * @status public
   *
   * Moves the selection up one row.
   */
  addSelectionAbove() {
    const range = this.getGoalScreenRange().copy();
    const previousRow = range.end.row - 1;

    for (let row = previousRow; row >= 0; row--) {
      range.start.row = row;
      range.end.row = row;
      const clippedRange = this.editor.clipScreenRange(range, {
        skipSoftWrapIndentation: true,
      });

      if (range.isEmpty()) {
        if (range.end.column > 0 && clippedRange.end.column === 0) continue;
      } else {
        if (clippedRange.isEmpty()) continue;
      }

      const containingSelections = this.editor.selectionsMarkerLayer.findMarkers({
        containsScreenRange: clippedRange,
      });
      if (containingSelections.length === 0) {
        const selection = this.editor.addSelectionForScreenRange(clippedRange);
        selection.setGoalScreenRange(range);
      }

      break;
    }
  }

  /**
   * @public
   * @status public
   *
   * Combines the given selection into this selection and then destroys
   * the given selection.
   *
   * @param otherSelection - A {@link Selection} to merge with.
   * @param {Object} [options] - options matching those found in {@link #setBufferRange}.
   */
  merge(otherSelection, options = {}) {
    const myGoalScreenRange = this.getGoalScreenRange();
    const otherGoalScreenRange = otherSelection.getGoalScreenRange();

    if (myGoalScreenRange && otherGoalScreenRange) {
      options.goalScreenRange = myGoalScreenRange.union(otherGoalScreenRange);
    } else {
      options.goalScreenRange = myGoalScreenRange || otherGoalScreenRange;
    }

    const bufferRange = this.getBufferRange().union(otherSelection.getBufferRange());
    this.setBufferRange(bufferRange, Object.assign({ autoscroll: false }, options));
    otherSelection.destroy();
  }

  /**
   * @category Comparing to other selections
   */

  /**
   * @public
   * @status public
   *
   * Compare this selection's buffer range to another selection's buffer
   * range.
   *
   * See {@link Range#compare} for more details.
   *
   * @param otherSelection - A {@link Selection} to compare against
   */
  compare(otherSelection) {
    return this.marker.compare(otherSelection.marker);
  }

  /**
   * @category Private Utilities
   */

  setGoalScreenRange(range) {
    this.goalScreenRange = Range.fromObject(range);
  }

  getGoalScreenRange() {
    return this.goalScreenRange || this.getScreenRange();
  }

  markerDidChange(e) {
    const { oldHeadBufferPosition, oldTailBufferPosition, newHeadBufferPosition } = e;
    const { oldHeadScreenPosition, oldTailScreenPosition, newHeadScreenPosition } = e;
    const { textChanged } = e;

    if (!oldHeadScreenPosition.isEqual(newHeadScreenPosition)) {
      this.cursor.goalColumn = null;
      const cursorMovedEvent = {
        oldBufferPosition: oldHeadBufferPosition,
        oldScreenPosition: oldHeadScreenPosition,
        newBufferPosition: newHeadBufferPosition,
        newScreenPosition: newHeadScreenPosition,
        textChanged,
        cursor: this.cursor,
      };
      this.cursor.emitter.emit("did-change-position", cursorMovedEvent);
      this.editor.cursorMoved(cursorMovedEvent);
    }

    const rangeChangedEvent = {
      oldBufferRange: new Range(oldHeadBufferPosition, oldTailBufferPosition),
      oldScreenRange: new Range(oldHeadScreenPosition, oldTailScreenPosition),
      newBufferRange: this.getBufferRange(),
      newScreenRange: this.getScreenRange(),
      selection: this,
    };
    this.emitter.emit("did-change-range", rangeChangedEvent);
    this.editor.selectionRangeChanged(rangeChangedEvent);
  }

  markerDidDestroy() {
    if (this.editor.isDestroyed()) return;

    this.destroyed = true;
    this.cursor.destroyed = true;

    this.editor.removeSelection(this);

    this.cursor.emitter.emit("did-destroy");
    this.emitter.emit("did-destroy");

    this.cursor.emitter.dispose();
    this.emitter.dispose();
  }

  finalize() {
    if (!this.initialScreenRange || !this.initialScreenRange.isEqual(this.getScreenRange())) {
      this.initialScreenRange = null;
    }
    if (this.isEmpty()) {
      this.wordwise = false;
      this.linewise = false;
    }
  }

  autoscroll(options) {
    if (this.marker.hasTail()) {
      this.editor.scrollToScreenRange(
        this.getScreenRange(),
        Object.assign({ reversed: this.isReversed() }, options),
      );
    } else {
      this.cursor.autoscroll(options);
    }
  }

  clearAutoscroll() {}

  modifySelection(fn) {
    this.retainSelection = true;
    this.plantTail();
    fn();
    this.retainSelection = false;
  }

  // Sets the marker's tail to the same position as the marker's head.
  //
  // This only works if there isn't already a tail position.
  //
  // Returns a {@link Point} representing the new tail position.
  plantTail() {
    this.marker.plantTail();
  }
};
