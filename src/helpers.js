const Patch = require("./text-patch");
const Range = require("./range");
const { traverse, traversal } = require("./point-helpers");

exports.newlineRegex = /\r\n|\n|\r/g;

exports.debounce = function debounce(fn, wait) {
  let timestamp, timeout;

  function later() {
    const last = Date.now() - timestamp;
    if (last < wait && last >= 0) {
      timeout = setTimeout(later, wait - last);
    } else {
      timeout = null;
      fn();
    }
  }

  return function () {
    timestamp = Date.now();
    if (!timeout) timeout = setTimeout(later, wait);
  };
};

exports.spliceArray = function spliceArray(array, start, removedCount, insertedItems = []) {
  const oldLength = array.length;
  const insertedCount = insertedItems.length;
  removedCount = Math.min(removedCount, oldLength - start);
  const lengthDelta = insertedCount - removedCount;
  const newLength = oldLength + lengthDelta;

  if (lengthDelta > 0) {
    array.length = newLength;
    for (let i = newLength - 1, end = start + insertedCount; i >= end; i--) {
      array[i] = array[i - lengthDelta];
    }
  } else if (lengthDelta < 0) {
    for (let i = start + insertedCount, end = newLength; i < end; i++) {
      array[i] = array[i - lengthDelta];
    }
    array.length = newLength;
  }

  for (let i = 0; i < insertedItems.length; i++) {
    array[start + i] = insertedItems[i];
  }
};

exports.patchFromChanges = function patchFromChanges(changes) {
  const patch = new Patch();
  for (let i = 0; i < changes.length; i++) {
    const { oldStart, oldEnd, oldText, newStart, newEnd, newText } = changes[i];
    const oldExtent = traversal(oldEnd, oldStart);
    const newExtent = traversal(newEnd, newStart);
    patch.splice(newStart, oldExtent, newExtent, oldText, newText);
  }
  return patch;
};

// A single splice is already compact. Keep its existing JS strings instead of
// copying them into a Patch and immediately copying them back out. Undo
// updates may have different old/new starts, so anchor both ranges at newStart
// just as patchFromChanges does. Fresh points preserve the patch result's
// independence when event consumers freeze or retain their ranges.
exports.compactPatchChanges = function compactPatchChanges(changes) {
  if (changes.length !== 1) {
    const independent = compactIndependentRows(changes) ?? compactIndependentSplices(changes);
    return independent ?? exports.patchFromChanges(changes).getChanges();
  }
  const { oldStart, oldEnd, newStart, newEnd, oldText, newText } = changes[0];
  // Keep coordinate coercion and saturation for nonstandard coordinates. In
  // particular, clipPosition permits fractions even though patch edits use
  // integer coordinates. The common path only handles ordinary text splices.
  if (
    typeof oldText !== "string" ||
    typeof newText !== "string" ||
    !isOrdinaryPatchPoint(oldStart) ||
    !isOrdinaryPatchPoint(oldEnd) ||
    !isOrdinaryPatchPoint(newStart) ||
    !isOrdinaryPatchPoint(newEnd)
  )
    return exports.patchFromChanges(changes).getChanges();
  const oldExtent = traversal(oldEnd, oldStart);
  const newExtent = traversal(newEnd, newStart);
  if (!isOrdinaryPatchPoint(oldExtent) || !isOrdinaryPatchPoint(newExtent)) {
    return exports.patchFromChanges(changes).getChanges();
  }
  if (
    oldExtent.row === 0 &&
    oldExtent.column === 0 &&
    newExtent.row === 0 &&
    newExtent.column === 0
  ) {
    return [];
  }
  const rebasedOldEnd = traverse(newStart, oldExtent);
  const rebasedNewEnd = traverse(newStart, newExtent);
  if (!isOrdinaryPatchPoint(rebasedOldEnd) || !isOrdinaryPatchPoint(rebasedNewEnd)) {
    return exports.patchFromChanges(changes).getChanges();
  }
  return [
    {
      oldStart: { row: newStart.row + 0, column: newStart.column + 0 },
      oldEnd: { row: rebasedOldEnd.row + 0, column: rebasedOldEnd.column + 0 },
      newStart: { row: newStart.row + 0, column: newStart.column + 0 },
      newEnd: { row: rebasedNewEnd.row + 0, column: rebasedNewEnd.column + 0 },
      oldText,
      newText,
    },
  ];
};

// Recover original coordinates from ordered disjoint splices using the old
// and new end of the previous change, including row shifts. Overlapping or
// reordered edits retain the general composer.
function compactIndependentSplices(changes) {
  let previousOldEnd = { row: 0, column: 0 },
    previousNewEnd = previousOldEnd;
  const canonical = [];
  for (const change of changes) {
    const { oldStart, oldEnd, newStart, newEnd, oldText, newText } = change;
    if (
      ![oldStart, oldEnd, newStart, newEnd].every(isOrdinaryPatchPoint) ||
      typeof oldText !== "string" ||
      typeof newText !== "string" ||
      oldStart.row !== newStart.row ||
      oldStart.column !== newStart.column ||
      oldStart.row < previousNewEnd.row ||
      (oldStart.row === previousNewEnd.row && oldStart.column < previousNewEnd.column)
    )
      return null;
    const originalStart = traverse(previousOldEnd, traversal(oldStart, previousNewEnd));
    const originalEnd = traverse(originalStart, traversal(oldEnd, oldStart));
    canonical.push({
      oldStart: originalStart,
      oldEnd: originalEnd,
      newStart,
      newEnd,
      oldText,
      newText,
    });
    previousOldEnd = originalEnd;
    previousNewEnd = newEnd;
  }
  return Patch.fromIndependentChanges(canonical)?.getChanges() ?? null;
}

function compactIndependentRows(changes) {
  const rows = new Set();
  for (const { oldStart, oldEnd, newStart, newEnd, oldText, newText } of changes) {
    if (
      !isOrdinaryPatchPoint(oldStart) ||
      !isOrdinaryPatchPoint(oldEnd) ||
      !isOrdinaryPatchPoint(newStart) ||
      !isOrdinaryPatchPoint(newEnd) ||
      typeof oldText !== "string" ||
      typeof newText !== "string" ||
      oldStart.row !== oldEnd.row ||
      oldStart.row !== newStart.row ||
      oldStart.row !== newEnd.row ||
      oldStart.column !== newStart.column ||
      oldEnd.column - oldStart.column !== oldText.length ||
      newEnd.column - newStart.column !== newText.length ||
      oldText.includes("\n") ||
      newText.includes("\n") ||
      rows.has(oldStart.row)
    )
      return null;
    rows.add(oldStart.row);
  }
  return changes
    .filter(({ oldText, newText }) => oldText.length || newText.length)
    .map(({ oldStart, oldEnd, newStart, newEnd, oldText, newText }) => ({
      oldStart: { row: oldStart.row + 0, column: oldStart.column + 0 },
      oldEnd: { row: oldEnd.row + 0, column: oldEnd.column + 0 },
      newStart: { row: newStart.row + 0, column: newStart.column + 0 },
      newEnd: { row: newEnd.row + 0, column: newEnd.column + 0 },
      oldText,
      newText,
    }))
    .sort((a, b) => a.oldStart.row - b.oldStart.row);
}

function isOrdinaryPatchPoint(point) {
  return (
    Number.isInteger(point.row) &&
    point.row >= 0 &&
    point.row <= 0xffffffff &&
    Number.isInteger(point.column) &&
    point.column >= 0 &&
    point.column <= 0xffffffff
  );
}

exports.normalizePatchChanges = function normalizePatchChanges(changes) {
  return changes.map(
    (change) =>
      new TextChange(
        Range(change.oldStart, change.oldEnd),
        Range(change.newStart, change.newEnd),
        change.oldText,
        change.newText,
      ),
  );
};

exports.extentForText = function extentForText(text) {
  let lastLineStartIndex = 0;
  let row = 0;
  let newlineIndex = text.indexOf("\n");
  while (newlineIndex !== -1) {
    row++;
    lastLineStartIndex = newlineIndex + 1;
    newlineIndex = text.indexOf("\n", lastLineStartIndex);
  }
  return { row, column: text.length - lastLineStartIndex };
};

class TextChange {
  constructor(oldRange, newRange, oldText, newText) {
    this.oldRange = oldRange;
    this.newRange = newRange;
    this.oldText = oldText;
    this.newText = newText;
  }

  isEqual(other) {
    return (
      this.oldRange.isEqual(other.oldRange) &&
      this.newRange.isEqual(other.newRange) &&
      this.oldText === other.oldText &&
      this.newText === other.newText
    );
  }
}

Object.defineProperty(TextChange.prototype, "start", {
  get() {
    return this.newRange.start;
  },
  enumerable: false,
});

Object.defineProperty(TextChange.prototype, "oldStart", {
  get() {
    return this.oldRange.start;
  },
  enumerable: false,
});

Object.defineProperty(TextChange.prototype, "newStart", {
  get() {
    return this.newRange.start;
  },
  enumerable: false,
});

Object.defineProperty(TextChange.prototype, "oldEnd", {
  get() {
    return this.oldRange.end;
  },
  enumerable: false,
});

Object.defineProperty(TextChange.prototype, "newEnd", {
  get() {
    return this.newRange.end;
  },
  enumerable: false,
});

Object.defineProperty(TextChange.prototype, "oldExtent", {
  get() {
    return this.oldRange.getExtent();
  },
  enumerable: false,
});

Object.defineProperty(TextChange.prototype, "newExtent", {
  get() {
    return this.newRange.getExtent();
  },
  enumerable: false,
});
