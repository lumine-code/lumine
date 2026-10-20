const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DocumentCore } = require("../../src/text-model");
function random(seed) {
  return (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
}
test("addressable edits agree with Superstring while JS history restores exact roots", () => {
  const { TextBuffer } = require("../../script/native-superstring-reference").load();
  const native = new TextBuffer("first\r\nsecond😀\nthird\r\n".repeat(150));
  const document = new DocumentCore(native.getText(), { historyLimit: 1000 });
  const next = random(7654321);
  const snapshots = [document.snapshot().text];
  const inserts = ["\r", "\n", "\r\n", "😀", "\ud800", "text", ""];
  for (let index = 0; index < 500; index++) {
    const a = native.positionForCharacterIndex(next(native.getLength() + 1));
    const start = native.characterIndexForPosition(a);
    const b = native.positionForCharacterIndex(Math.min(native.getLength(), start + next(20)));
    const end = native.characterIndexForPosition(b);
    const text = inserts[next(inserts.length)];
    native.setTextInRange({ start: a, end: b }, text);
    const batch = document.transact((draft) => draft.replace(start, end, text));
    assert.equal(document.getText(), native.getText(), `edit ${index}`);
    if (batch) snapshots.push(document.snapshot().text);
  }
  for (let index = snapshots.length - 2; index >= 0; index--) {
    document.undo();
    assert.equal(document.snapshot().text, snapshots[index]);
  }
  for (let index = 1; index < snapshots.length; index++) {
    document.redo();
    assert.equal(document.snapshot().text, snapshots[index]);
  }
});
