const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const { PieceTree } = require("../../src/text-model");

test("source insertion shares oversized text, captures ranges and restores exact history", () => {
  let source = new PieceTree("ab\n".repeat(1024));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  const buffer = new TextBuffer();
  try {
    buffer.setTextInRange(buffer.getRange(), source, { normalizeLineEndings: false });
    buffer.clearUndoStack();
    const original = buffer.getTextSnapshotInRange(buffer.getRange());
    buffer.setPreferredLineEnding("\n");
    buffer.append(original);
    assert.equal(buffer.getLength(), source.length * 2);
    assert(buffer.getTextSnapshot().subtext(source.length).equals(source));
    buffer.undo();
    assert(buffer.getTextSnapshot().equals(source));
    buffer.redo();
    assert.equal(buffer.getLength(), source.length * 2);
  } finally {
    buffer.destroy();
  }
});

test("streamed edit batches preserve markers and commit selection finalizers in history", async () => {
  const buffer = new TextBuffer("a\nb\nc\n");
  const marker = buffer.markPosition([2, 1], { invalidate: "never" });
  try {
    const count = await buffer.applyTextEdits(
      [
        [
          {
            range: [
              [0, 0],
              [0, 1],
            ],
            text: "aa",
          },
        ],
        [
          {
            range: [
              [1, 0],
              [1, 1],
            ],
            text: new PieceTree("bb"),
          },
        ],
      ],
      {
        didCommit: () =>
          marker.setRange([
            [2, 0],
            [2, 0],
          ]),
      },
    );
    assert.equal(count, 2);
    assert.equal(buffer.getText(), "aa\nbb\nc\n");
    assert.equal(marker.getStartPosition().column, 0);
    buffer.undo();
    assert.equal(buffer.getText(), "a\nb\nc\n");
    assert.equal(marker.getStartPosition().column, 1);
    buffer.redo();
    assert.equal(marker.getStartPosition().column, 0);
  } finally {
    buffer.destroy();
  }
});

test("a failing selection finalizer rolls back instead of claiming that text stayed committed", async () => {
  const buffer = new TextBuffer("original");
  try {
    await assert.rejects(
      buffer.applyTextEdits([{ range: buffer.getRange(), text: "changed" }], {
        didCommit() {
          throw new Error("Finalizer failed");
        },
      }),
      (error) => error.message === "Finalizer failed" && error.committed !== true,
    );
    assert.equal(buffer.getText(), "original");
  } finally {
    buffer.destroy();
  }
});

test("a post-transaction observer failure reports an applied edit that can be undone", async () => {
  const buffer = new TextBuffer("original");
  const subscription = buffer.onDidChangeText(() => {
    throw new Error("Observer failed");
  });
  try {
    await assert.rejects(
      buffer.applyTextEdits([{ range: buffer.getRange(), text: "changed" }]),
      (error) => error.committed === true && error.code === "ERR_EDIT_OBSERVER_FAILED",
    );
    assert.equal(buffer.getText(), "changed");
    subscription.dispose();
    buffer.undo();
    assert.equal(buffer.getText(), "original");
  } finally {
    subscription.dispose();
    buffer.destroy();
  }
});
