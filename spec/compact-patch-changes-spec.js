const TextBuffer = require("../src/text-buffer");
const { compactPatchChanges, patchFromChanges, extentForText } = require("../src/helpers");
const { traverse } = require("../src/point-helpers");

function plain(changes) {
  return changes.map((change) => ({
    oldStart: [change.oldStart.row, change.oldStart.column],
    oldEnd: [change.oldEnd.row, change.oldEnd.column],
    newStart: [change.newStart.row, change.newStart.column],
    newEnd: [change.newEnd.row, change.newEnd.column],
    oldText: change.oldText,
    newText: change.newText,
  }));
}

describe("single-change compaction", () => {
  it("matches patch composition for independent rows in arbitrary order", () => {
    let seed = 73;
    const random = (max) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const texts = ["", "# ", "😀", "é\t", "\r", "value"];
    for (let trial = 0; trial < 100; trial++) {
      const changes = Array.from({ length: 24 }, (_, row) => {
        const column = random(8),
          oldText = texts[random(texts.length)],
          newText = texts[random(texts.length)];
        return {
          oldStart: { row, column },
          newStart: { row, column },
          oldEnd: { row, column: column + oldText.length },
          newEnd: { row, column: column + newText.length },
          oldText,
          newText,
        };
      });
      for (let i = changes.length - 1; i > 0; i--) {
        const j = random(i + 1);
        [changes[i], changes[j]] = [changes[j], changes[i]];
      }
      expect(plain(compactPatchChanges(changes))).toEqual(
        plain(patchFromChanges(changes).getChanges()),
      );
    }
  });

  it("uses full composition for overlapping edits and changes that move subsequent rows", () => {
    const first = {
      oldStart: { row: 0, column: 0 },
      oldEnd: { row: 0, column: 0 },
      newStart: { row: 0, column: 0 },
      newEnd: { row: 0, column: 2 },
      oldText: "",
      newText: "ab",
    };
    for (const second of [
      {
        oldStart: { row: 0, column: 1 },
        oldEnd: { row: 0, column: 2 },
        newStart: { row: 0, column: 1 },
        newEnd: { row: 0, column: 2 },
        oldText: "b",
        newText: "X",
      },
      {
        oldStart: { row: 1, column: 0 },
        oldEnd: { row: 1, column: 0 },
        newStart: { row: 1, column: 0 },
        newEnd: { row: 2, column: 0 },
        oldText: "",
        newText: "\r\n",
      },
    ])
      expect(plain(compactPatchChanges([first, second]))).toEqual(
        plain(patchFromChanges([first, second]).getChanges()),
      );
  });

  it("preserves markers, transaction summaries and history for a bulk column edit", () => {
    const source = "value = '🦉'\r\n".repeat(100);
    const buffer = new TextBuffer(source);
    const marker = buffer.markPosition([50, 5]);
    const transactions = [];
    buffer.onDidChangeText((event) => transactions.push(event.changes));
    try {
      buffer.transact(() => {
        for (let row = 0; row < 100; row++) buffer.insert([row, 0], "# ");
      });
      expect(marker.getHeadPosition()).toEqual([50, 7]);
      expect(transactions.length).toBe(1);
      expect(transactions[0].length).toBe(100);
      expect(transactions[0].every((change) => change.newText === "# ")).toBe(true);
      const edited = buffer.getText();
      buffer.undo();
      expect(buffer.getText()).toBe(source);
      expect(marker.getHeadPosition()).toEqual([50, 5]);
      buffer.redo();
      expect(buffer.getText()).toBe(edited);
      expect(marker.getHeadPosition()).toEqual([50, 7]);
    } finally {
      buffer.destroy();
    }
  });

  it("counts UTF-16 columns and advances rows only at LF", () => {
    for (const text of ["", "\r", "\r\n", "😀e\u0301", "a\r\nb\nc\r", "line\n".repeat(10000)]) {
      const lines = text.split("\n");
      expect(extentForText(text)).toEqual({ row: lines.length - 1, column: lines.at(-1).length });
    }
  });

  it("matches patch compaction for empty, Unicode, line-ending and rebased changes", () => {
    const texts = ["", "abc", "A😀B", "\r\n", "a\rb\nc", "a\nb\n"];
    for (const oldText of texts) {
      for (const newText of texts) {
        for (let row = 0; row < 6; row++) {
          const oldStart = { row, column: 3 };
          const newStart = { row: 6 - row, column: 7 };
          const change = {
            oldStart,
            oldEnd: traverse(oldStart, extentForText(oldText)),
            newStart,
            newEnd: traverse(newStart, extentForText(newText)),
            oldText,
            newText,
          };
          expect(plain(compactPatchChanges([change]))).toEqual(
            plain(patchFromChanges([change]).getChanges()),
          );
        }
      }
    }
  });

  it("does not freeze or alias the caller's points when the result is retained", () => {
    const change = {
      oldStart: { row: 1, column: 2 },
      oldEnd: { row: 1, column: 3 },
      newStart: { row: 0, column: 1 },
      newEnd: { row: 0, column: 3 },
      oldText: "x",
      newText: "yz",
    };
    const [result] = compactPatchChanges([change]);
    for (const key of ["oldStart", "oldEnd", "newStart", "newEnd"]) Object.freeze(result[key]);
    change.newStart.column = 9;
    expect(result.newStart.column).toBe(1);
    expect(Object.isFrozen(change.oldStart)).toBe(false);
    expect(Object.isFrozen(change.oldEnd)).toBe(false);
    expect(Object.isFrozen(change.newEnd)).toBe(false);
  });

  it("preserves coordinate coercion, saturation and negative-zero normalization", () => {
    for (const start of [
      { row: 0.5, column: 1.75 },
      { row: -0, column: -0 },
      { row: 0xfffffffe, column: 4 },
      { row: Infinity, column: 0 },
    ]) {
      const change = {
        oldStart: { row: 0, column: 0 },
        oldEnd: { row: 2, column: 2 },
        newStart: start,
        newEnd: { row: start.row, column: start.column + 1 },
        oldText: "a\nb\ncc",
        newText: "x",
      };
      expect(plain(compactPatchChanges([change]))).toEqual(
        plain(patchFromChanges([change]).getChanges()),
      );
    }
  });

  it("reports the same integer edit coordinates for a fractional insertion", () => {
    const buffer = new TextBuffer("abc");
    let change;
    buffer.onDidChangeText((event) => {
      change = event.changes[0];
    });
    try {
      buffer.insert([0, 1.75], "X");
      expect(buffer.getText()).toBe("aXbc");
      expect(change.oldRange.serialize()).toEqual([
        [0, 1],
        [0, 1],
      ]);
      expect(change.newRange.serialize()).toEqual([
        [0, 1],
        [0, 2],
      ]);
      expect(buffer.undo()).toBe(true);
      expect(buffer.getText()).toBe("abc");
    } finally {
      buffer.destroy();
    }
  });

  it("preserves grouped and stopped-changing events through nested edits, undo and redo", () => {
    const buffer = new TextBuffer("abc\r\ndef");
    const transactions = [];
    const stopped = [];
    buffer.onDidChangeText((event) => transactions.push(event.changes));
    buffer.onDidStopChanging((event) => stopped.push(event));
    try {
      buffer.transact(() => {
        buffer.insert([0, 1], "😀");
        buffer.transact(() => buffer.insert([1, 2], "\nX"));
      });
      const edited = buffer.getText();
      expect(transactions.length).toBe(1);
      expect(transactions[0].length).toBe(2);
      expect(buffer.undo()).toBe(true);
      expect(buffer.getText()).toBe("abc\r\ndef");
      expect(buffer.redo()).toBe(true);
      expect(buffer.getText()).toBe(edited);
      buffer.emitDidStopChangingEvent();
      expect(stopped.length).toBe(1);
      expect(stopped[0].transactions.length).toBe(3);
      expect(stopped[0].changes.length).toBe(2);
      expect(stopped[0].changes.map((change) => change.newText)).toEqual(["😀", "\r\nX"]);
    } finally {
      buffer.destroy();
    }
  });

  it("keeps the public checkpoint result materialized after internal transaction grouping", () => {
    const buffer = new TextBuffer("abc");
    try {
      const checkpoint = buffer.createCheckpoint();
      buffer.insert([0, 1], "X");
      const changes = buffer.groupChangesSinceCheckpoint(checkpoint);
      expect(Array.isArray(changes)).toBe(true);
      expect(changes[0].newText).toBe("X");
      expect(buffer.undo()).toBe(true);
      expect(buffer.getText()).toBe("abc");
    } finally {
      buffer.destroy();
    }
  });

  it("keeps public event ranges independent of the retained stopped-changing transaction", () => {
    const buffer = new TextBuffer("abc");
    let transaction;
    buffer.onDidChangeText((event) => {
      event.changes[0].newRange.end.column = 0;
      expect(event.changes[0].newRange.end.column).toBe(0);
    });
    buffer.onDidStopChanging((event) => {
      transaction = event.transactions[0];
    });
    try {
      buffer.insert([0, 1], "X");
      buffer.emitDidStopChangingEvent();
      expect(transaction.changes[0].newRange.end.column).toBe(2);
      expect(buffer.getText()).toBe("aXbc");
    } finally {
      buffer.destroy();
    }
  });
});
