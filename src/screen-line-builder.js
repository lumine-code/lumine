const Point = require("./point");

const HARD_TAB = 1 << 0;
const LEADING_WHITESPACE = 1 << 2;
const TRAILING_WHITESPACE = 1 << 3;
const INVISIBLE_CHARACTER = 1 << 4;
const LINE_ENDING = 1 << 6;
const FOLD = 1 << 7;
const SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE = 1 << 0;

let nextScreenLineId = 1;

module.exports = class ScreenLineBuilder {
  constructor(displayLayer) {
    this.displayLayer = displayLayer;
  }

  buildScreenLines(startScreenRow, endScreenRow) {
    this.requestedStartScreenRow = startScreenRow;
    this.requestedEndScreenRow = endScreenRow;
    this.bufferLine = null;
    this.bufferLineRow = null;
    this.displayLayer.populateSpatialIndexIfNeeded(
      this.displayLayer.buffer.getLineCount(),
      endScreenRow,
    );

    // A screen-row boundary is a complete checkpoint in the spatial index and
    // `screenLineStartFlags`. Start there directly instead of replaying a
    // potentially enormous folded or soft-wrapped buffer row from column zero.
    const startScreenPosition = Point(startScreenRow, 0);
    const startBufferPosition = this.displayLayer.translateScreenPositionWithSpatialIndex(
      startScreenPosition,
      "forward",
      true,
    );
    let initialSoftWrapHunk = null;
    const hunkAtStart = this.displayLayer.spatialIndex.changeForNewPosition(startScreenPosition);
    if (
      hunkAtStart &&
      this.displayLayer.isSoftWrapHunk(hunkAtStart) &&
      hunkAtStart.newStart.row < startScreenRow &&
      hunkAtStart.newEnd.row === startScreenRow
    ) {
      initialSoftWrapHunk = hunkAtStart;
    }
    this.bufferPosition = {
      row: startBufferPosition.row,
      column: startBufferPosition.column,
    };
    this.screenRow = startScreenRow;

    const decorationIterator = this.displayLayer.buffer.languageMode.buildHighlightIterator();
    const uncachedScreenLineRanges = this.findUncachedScreenLineRanges(
      this.screenRow,
      endScreenRow,
    );
    let uncachedScreenLineRangeIndex = 0;
    let uncachedScreenLineRange = uncachedScreenLineRanges[uncachedScreenLineRangeIndex];
    let decorationIteratorNeedsSeek = true;
    let decorationIteratorEndBufferRow = null;
    const hunks = this.displayLayer.spatialIndex.getChangesInNewRange(
      Point(this.screenRow, 0),
      Point(endScreenRow, 0),
    );
    let hunkIndex = 0;
    // A non-zero continuation indent makes the range query include the hunk
    // that enters the requested row. Its mapping and indent were consumed
    // above; consuming it again would skip the row we were asked to build.
    const firstHunk = hunks[0];
    if (
      initialSoftWrapHunk &&
      firstHunk &&
      this.displayLayer.isSoftWrapHunk(firstHunk) &&
      firstHunk.oldStart.row === initialSoftWrapHunk.oldStart.row &&
      firstHunk.oldStart.column === initialSoftWrapHunk.oldStart.column &&
      firstHunk.newEnd.row === initialSoftWrapHunk.newEnd.row &&
      firstHunk.newEnd.column === initialSoftWrapHunk.newEnd.column
    ) {
      hunkIndex++;
    }

    this.containingScopeIds = [];
    this.scopeIdsToReopen = [];
    this.screenLines = [];
    this.beginLine();

    // Loop through all characters spanning the given screen row range, building
    // up screen lines based on the contents of the spatial index and the
    // buffer.
    screenRowLoop: while (this.screenRow < endScreenRow) {
      var cachedScreenLine = this.displayLayer.cachedScreenLines[this.screenRow];
      if (cachedScreenLine) {
        this.pushScreenLine(cachedScreenLine);
        decorationIteratorNeedsSeek = true;

        let nextHunk = hunks[hunkIndex];
        while (nextHunk && nextHunk.newStart.row <= this.screenRow) {
          if (nextHunk.newStart.row === this.screenRow) {
            if (nextHunk.newEnd.row > nextHunk.newStart.row) {
              this.screenRow++;
              this.bufferPosition.column = nextHunk.oldEnd.column;
              hunkIndex++;
              continue screenRowLoop;
            } else {
              this.bufferPosition.row = nextHunk.oldEnd.row;
              this.bufferPosition.column = nextHunk.oldEnd.column;
            }
          }

          hunkIndex++;
          nextHunk = hunks[hunkIndex];
        }

        this.screenRow++;
        this.screenColumn = 0;
        this.bufferPosition.row++;
        this.bufferPosition.column = 0;
        continue;
      }

      while (uncachedScreenLineRange && this.screenRow >= uncachedScreenLineRange.endScreenRow) {
        uncachedScreenLineRange = uncachedScreenLineRanges[++uncachedScreenLineRangeIndex];
      }
      if (uncachedScreenLineRange && this.screenRow === uncachedScreenLineRange.startScreenRow) {
        decorationIteratorEndBufferRow = uncachedScreenLineRange.endBufferRow;
        decorationIteratorNeedsSeek = true;
      }

      this.currentBuiltInClassNameFlags = 0;
      if (this.bufferPosition.row > this.displayLayer.buffer.getLastRow()) break;
      this.loadBufferLine();
      this.inLeadingWhitespace =
        (this.displayLayer.screenLineStartFlags[this.screenRow] &
          SCREEN_LINE_STARTS_IN_LEADING_WHITESPACE) !==
        0;
      this.inTrailingWhitespace = false;

      if (
        decorationIteratorNeedsSeek ||
        this.compareBufferPosition(decorationIterator.getPosition()) > 0
      ) {
        decorationIteratorNeedsSeek = false;
        this.scopeIdsToReopen =
          decorationIterator.seek(this.bufferPosition, decorationIteratorEndBufferRow) || [];
      }

      var prevCachedScreenLine = this.displayLayer.cachedScreenLines[this.screenRow - 1];
      if (prevCachedScreenLine && prevCachedScreenLine.softWrapIndent >= 0) {
        if (prevCachedScreenLine.softWrapIndent > 0) {
          this.emitIndentWhitespace(prevCachedScreenLine.softWrapIndent);
        }
      } else if (this.screenRow === this.requestedStartScreenRow && initialSoftWrapHunk) {
        const softWrapIndent = initialSoftWrapHunk.newEnd.column;
        if (softWrapIndent > 0) this.emitIndentWhitespace(softWrapIndent);
      }

      // This loop may visit multiple buffer rows if there are folds and
      // multiple screen rows if there are soft wraps.
      while (this.bufferPosition.column <= this.bufferLineLength) {
        // Handle folds or soft wraps at the current position.
        var nextHunk = hunks[hunkIndex];
        while (
          nextHunk &&
          nextHunk.oldStart.row === this.bufferPosition.row &&
          nextHunk.oldStart.column === this.bufferPosition.column
        ) {
          let reachedEndOfUncachedRange = false;
          if (this.displayLayer.isSoftWrapHunk(nextHunk)) {
            this.emitSoftWrap(nextHunk);
            if (this.screenRow === endScreenRow) {
              break screenRowLoop;
            }
            reachedEndOfUncachedRange = this.screenRow === uncachedScreenLineRange.endScreenRow;
          } else {
            this.emitFold(nextHunk, decorationIterator, decorationIteratorEndBufferRow);
          }

          hunkIndex++;
          nextHunk = hunks[hunkIndex];
          if (reachedEndOfUncachedRange) {
            continue screenRowLoop;
          }
        }

        var nextCharacter = this.bufferLine[this.bufferPosition.column];
        if (this.bufferPosition.column >= this.trailingWhitespaceStartColumn) {
          this.inTrailingWhitespace = true;
          this.inLeadingWhitespace = false;
        } else if (nextCharacter !== " " && nextCharacter !== "\t") {
          this.inLeadingWhitespace = false;
        }

        // Compute a token flags describing built-in decorations for the token
        // containing the next character
        var previousBuiltInTagFlags = this.currentBuiltInClassNameFlags;
        this.updateCurrentTokenFlags(nextCharacter);

        if (this.emitBuiltInTagBoundary) {
          this.emitCloseTag(this.getBuiltInScopeId(previousBuiltInTagFlags));
        }

        this.emitDecorationBoundaries(decorationIterator);

        // Are we at the end of the line?
        if (this.bufferPosition.column === this.bufferLineLength) {
          this.emitLineEnding();
          break;
        }

        if (this.emitBuiltInTagBoundary) {
          this.emitOpenTag(this.getBuiltInScopeId(this.currentBuiltInClassNameFlags));
        }

        // Emit ordinary text in runs bounded by anything that needs
        // character-level handling. Besides avoiding a native buffer call per
        // UTF-16 code unit, this keeps the common case to one substring and one
        // append per syntax segment or soft-wrapped screen line.
        if (
          this.currentBuiltInClassNameFlags === 0 &&
          !this.inLeadingWhitespace &&
          !this.inTrailingWhitespace &&
          nextCharacter !== "\t"
        ) {
          const endColumn = this.findNextTextBoundary(nextHunk, decorationIterator);
          this.emitText(this.bufferLine.slice(this.bufferPosition.column, endColumn));
          this.bufferPosition.column = endColumn;
          continue;
        }

        // Emit the next character, handling hard tabs whitespace invisibles
        // specially.
        if (nextCharacter === "\t") {
          this.emitHardTab();
        } else if (
          (this.inLeadingWhitespace || this.inTrailingWhitespace) &&
          nextCharacter === " " &&
          this.displayLayer.invisibles.space
        ) {
          this.emitText(this.displayLayer.invisibles.space);
        } else {
          this.emitText(nextCharacter);
        }
        this.bufferPosition.column++;
      }
    }

    return this.screenLines;
  }

  loadBufferLine() {
    const bufferRow = this.bufferPosition.row;
    if (this.bufferLineRow !== bufferRow) {
      this.bufferLineRow = bufferRow;
      this.bufferLine = this.displayLayer.buffer.lineForRow(bufferRow);
      this.bufferLineLength = this.bufferLine.length;
      this.trailingWhitespaceStartColumn = this.findTrailingWhitespaceStartColumn();
      this.nextTabColumn = this.bufferLine.indexOf("\t", this.bufferPosition.column);
    }
  }

  findTrailingWhitespaceStartColumn() {
    let column = this.bufferLineLength;
    while (column > 0) {
      const character = this.bufferLine[column - 1];
      if (character !== " " && character !== "\t") break;
      column--;
    }
    return column;
  }

  findNextTextBoundary(nextHunk, decorationIterator) {
    const { row, column } = this.bufferPosition;
    let endColumn = this.bufferLineLength;

    if (nextHunk && nextHunk.oldStart.row === row && nextHunk.oldStart.column > column) {
      endColumn = Math.min(endColumn, nextHunk.oldStart.column);
    }

    const decorationPosition = decorationIterator.getPosition();
    if (decorationPosition.row === row && decorationPosition.column > column) {
      endColumn = Math.min(endColumn, decorationPosition.column);
    }

    if (this.nextTabColumn >= 0 && this.nextTabColumn < column) {
      this.nextTabColumn = this.bufferLine.indexOf("\t", column);
    }
    if (this.nextTabColumn >= 0) endColumn = Math.min(endColumn, this.nextTabColumn);
    if (this.trailingWhitespaceStartColumn > column) {
      endColumn = Math.min(endColumn, this.trailingWhitespaceStartColumn);
    }

    return endColumn;
  }

  findUncachedScreenLineRanges(startScreenRow, endScreenRow) {
    const ranges = [];
    const cachedScreenLines = this.displayLayer.cachedScreenLines;
    const screenLineLengths = this.displayLayer.screenLineLengths;
    endScreenRow = Math.min(endScreenRow, screenLineLengths.length);

    let screenRow = startScreenRow;
    while (screenRow < endScreenRow) {
      if (cachedScreenLines[screenRow]) {
        screenRow++;
        continue;
      }

      const rangeStartScreenRow = screenRow;
      while (screenRow < endScreenRow && !cachedScreenLines[screenRow]) {
        screenRow++;
      }

      const lastScreenRow = screenRow - 1;
      const endOfLastScreenLine = Point(lastScreenRow, screenLineLengths[lastScreenRow]);
      ranges.push({
        startScreenRow: rangeStartScreenRow,
        endScreenRow: screenRow,
        endBufferRow: this.displayLayer.translateScreenPositionWithSpatialIndex(
          endOfLastScreenLine,
          "forward",
          false,
        ).row,
      });
    }

    return ranges;
  }

  getBuiltInScopeId(flags) {
    if (flags === 0) return 0;

    let scopeId = this.displayLayer.getBuiltInScopeId(flags);
    if (scopeId === -1) {
      let className = "";
      if (flags & INVISIBLE_CHARACTER) className += "invisible-character ";
      if (flags & HARD_TAB) className += "hard-tab ";
      if (flags & LEADING_WHITESPACE) className += "leading-whitespace ";
      if (flags & TRAILING_WHITESPACE) className += "trailing-whitespace ";
      if (flags & LINE_ENDING) className += "eol ";
      if (flags & FOLD) className += "fold-marker ";
      className = className.trim();
      scopeId = this.displayLayer.registerBuiltInScope(flags, className);
    }
    return scopeId;
  }

  beginLine() {
    this.currentScreenLineText = "";
    this.currentScreenLineTags = [];
    this.screenColumn = 0;
    this.currentTokenLength = 0;
  }

  updateCurrentTokenFlags(nextCharacter) {
    const previousBuiltInTagFlags = this.currentBuiltInClassNameFlags;
    this.currentBuiltInClassNameFlags = 0;
    this.emitBuiltInTagBoundary = false;

    if (nextCharacter === " " || nextCharacter === "\t") {
      if (this.inLeadingWhitespace) this.currentBuiltInClassNameFlags |= LEADING_WHITESPACE;
      if (this.inTrailingWhitespace) this.currentBuiltInClassNameFlags |= TRAILING_WHITESPACE;

      if (nextCharacter === " ") {
        if (
          (this.inLeadingWhitespace || this.inTrailingWhitespace) &&
          this.displayLayer.invisibles.space
        ) {
          this.currentBuiltInClassNameFlags |= INVISIBLE_CHARACTER;
        }
      } else {
        // nextCharacter === \t
        this.currentBuiltInClassNameFlags |= HARD_TAB;
        if (this.displayLayer.invisibles.tab)
          this.currentBuiltInClassNameFlags |= INVISIBLE_CHARACTER;

        this.emitBuiltInTagBoundary = true;
      }
    }

    if (!this.emitBuiltInTagBoundary) {
      this.emitBuiltInTagBoundary = this.currentBuiltInClassNameFlags !== previousBuiltInTagFlags;
    }
  }

  emitDecorationBoundaries(decorationIterator) {
    while (this.compareBufferPosition(decorationIterator.getPosition()) === 0) {
      var closeScopeIds = decorationIterator.getCloseScopeIds();
      for (let i = 0, n = closeScopeIds.length; i < n; i++) {
        this.emitCloseTag(closeScopeIds[i]);
      }

      var openScopeIds = decorationIterator.getOpenScopeIds();
      for (let i = 0, n = openScopeIds.length; i < n; i++) {
        this.emitOpenTag(openScopeIds[i]);
      }

      decorationIterator.moveToSuccessor();
    }
  }

  emitFold(nextHunk, decorationIterator, endBufferRow) {
    this.emitCloseTag(this.getBuiltInScopeId(this.currentBuiltInClassNameFlags));
    this.currentBuiltInClassNameFlags = 0;

    this.closeContainingScopes();
    this.scopeIdsToReopen.length = 0;

    this.emitOpenTag(this.getBuiltInScopeId(FOLD));
    this.emitText(this.displayLayer.foldCharacter);
    this.emitCloseTag(this.getBuiltInScopeId(FOLD));

    this.bufferPosition.row = nextHunk.oldEnd.row;
    this.bufferPosition.column = nextHunk.oldEnd.column;

    this.scopeIdsToReopen = decorationIterator.seek(this.bufferPosition, endBufferRow);

    this.loadBufferLine();
  }

  emitSoftWrap(nextHunk) {
    this.emitCloseTag(this.getBuiltInScopeId(this.currentBuiltInClassNameFlags));
    this.currentBuiltInClassNameFlags = 0;
    this.closeContainingScopes();
    this.emitNewline(nextHunk.newEnd.column);
    this.emitIndentWhitespace(nextHunk.newEnd.column);
  }

  emitLineEnding() {
    this.emitCloseTag(this.getBuiltInScopeId(this.currentBuiltInClassNameFlags));

    let lineEnding = this.displayLayer.buffer.lineEndingForRow(this.bufferPosition.row);
    const eolInvisible = this.displayLayer.eolInvisibles[lineEnding];
    if (eolInvisible) {
      const eolFlags = INVISIBLE_CHARACTER | LINE_ENDING;
      this.emitOpenTag(this.getBuiltInScopeId(eolFlags));
      this.emitText(eolInvisible, false);
      this.emitCloseTag(this.getBuiltInScopeId(eolFlags));
    }

    this.closeContainingScopes();

    // Ensure empty lines have at least one empty token to make it easier on
    // the caller
    if (this.currentScreenLineTags.length === 0) this.currentScreenLineTags.push(0);
    this.emitNewline();
    this.bufferPosition.row++;
    this.bufferPosition.column = 0;
  }

  emitNewline(softWrapIndent = -1) {
    const screenLine = {
      id: nextScreenLineId++,
      lineText: this.currentScreenLineText,
      tags: this.currentScreenLineTags,
      softWrapIndent,
    };
    this.pushScreenLine(screenLine);
    this.displayLayer.cachedScreenLines[this.screenRow] = screenLine;
    this.screenRow++;
    this.beginLine();
  }

  emitIndentWhitespace(endColumn) {
    this.emitText(" ".repeat(endColumn - this.screenColumn), false);
  }

  emitHardTab() {
    const distanceToNextTabStop =
      this.displayLayer.tabLength - (this.screenColumn % this.displayLayer.tabLength);
    if (this.displayLayer.invisibles.tab) {
      this.emitText(this.displayLayer.invisibles.tab);
      this.emitText(" ".repeat(distanceToNextTabStop - 1));
    } else {
      this.emitText(" ".repeat(distanceToNextTabStop));
    }
  }

  emitText(text, reopenTags = true) {
    if (reopenTags) this.reopenTags();
    this.currentScreenLineText += text;
    const length = text.length;
    this.screenColumn += length;
    this.currentTokenLength += length;
  }

  emitTokenBoundary() {
    if (this.currentTokenLength > 0) {
      this.currentScreenLineTags.push(this.currentTokenLength);
      this.currentTokenLength = 0;
    }
  }

  emitEmptyTokenIfNeeded() {
    const lastTag = this.currentScreenLineTags[this.currentScreenLineTags.length - 1];
    if (this.displayLayer.isOpenTag(lastTag)) {
      this.currentScreenLineTags.push(0);
    }
  }

  emitCloseTag(scopeId) {
    this.emitTokenBoundary();

    if (scopeId === 0) return;

    for (let i = this.scopeIdsToReopen.length - 1; i >= 0; i--) {
      if (this.scopeIdsToReopen[i] === scopeId) {
        this.scopeIdsToReopen.splice(i, 1);
        return;
      }
    }

    this.emitEmptyTokenIfNeeded();

    var containingScopeId;
    while ((containingScopeId = this.containingScopeIds.pop())) {
      this.currentScreenLineTags.push(this.displayLayer.closeTagForScopeId(containingScopeId));
      if (containingScopeId === scopeId) {
        return;
      } else {
        this.scopeIdsToReopen.unshift(containingScopeId);
      }
    }
  }

  emitOpenTag(scopeId, reopenTags = true) {
    if (reopenTags) this.reopenTags();
    this.emitTokenBoundary();
    if (scopeId > 0) {
      this.containingScopeIds.push(scopeId);
      this.currentScreenLineTags.push(this.displayLayer.openTagForScopeId(scopeId));
    }
  }

  closeContainingScopes() {
    if (this.containingScopeIds.length > 0) this.emitEmptyTokenIfNeeded();

    for (let i = this.containingScopeIds.length - 1; i >= 0; i--) {
      const containingScopeId = this.containingScopeIds[i];
      this.currentScreenLineTags.push(this.displayLayer.closeTagForScopeId(containingScopeId));
      this.scopeIdsToReopen.unshift(containingScopeId);
    }
    this.containingScopeIds.length = 0;
  }

  reopenTags() {
    for (let i = 0, n = this.scopeIdsToReopen.length; i < n; i++) {
      const scopeIdToReopen = this.scopeIdsToReopen[i];
      this.containingScopeIds.push(scopeIdToReopen);
      this.currentScreenLineTags.push(this.displayLayer.openTagForScopeId(scopeIdToReopen));
    }
    this.scopeIdsToReopen.length = 0;
  }

  pushScreenLine(screenLine) {
    if (
      this.requestedStartScreenRow <= this.screenRow &&
      this.screenRow < this.requestedEndScreenRow
    ) {
      this.screenLines.push(screenLine);
    }
  }

  compareBufferPosition(position) {
    const rowComparison = this.bufferPosition.row - position.row;
    return rowComparison === 0 ? this.bufferPosition.column - position.column : rowComparison;
  }
};
