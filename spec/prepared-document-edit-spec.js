const TextBuffer = require("../src/text-buffer");
const DefaultHistoryProvider = require("../src/default-history-provider");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

describe("The document edit contract", () => {
  let buffer;
  afterEach(() => buffer?.destroy());

  it("publishes replayable UTF-16 deltas and transaction revision boundaries", () => {
    buffer = new TextBuffer("a🚀\r\nb\nend");
    let replay = buffer.getText();
    let revision = buffer.getTextRevision();
    const batches = [];
    buffer.onDidApplyChanges((batch) => {
      expect(batch.beforeRevision).toBe(revision);
      expect(batch.afterRevision).toBeGreaterThan(batch.beforeRevision);
      for (const change of batch.changes) {
        expect(replay.slice(change.startIndex, change.oldEndIndex)).toBe(change.oldText);
        expect(change.newEndIndex).toBe(change.startIndex + change.newText.length);
        replay =
          replay.slice(0, change.startIndex) + change.newText + replay.slice(change.oldEndIndex);
        expect(Object.isFrozen(change)).toBe(true);
        expect(Object.isFrozen(change.oldRange)).toBe(true);
      }
      expect(batch.isCurrent()).toBe(true);
      expect(replay).toBe(buffer.getText());
      revision = batch.afterRevision;
      batches.push(batch);
    });
    buffer.transact(() => {
      buffer.insert([0, 1], "Ω\n", { normalizeLineEndings: false });
      buffer.setTextInRange(
        [
          [2, 0],
          [2, 1],
        ],
        "\ud800x",
      );
    });
    buffer.undo();
    buffer.redo();
    expect(batches.length).toBe(3);
    expect(batches[0].isCurrent()).toBe(false);
  });

  it("uses the patch history contract without provider constructor checks", () => {
    buffer = new TextBuffer("abc");
    class History extends DefaultHistoryProvider {}
    const history = new History(buffer);
    const push = spyOn(history, "pushPatch").and.callThrough();
    buffer.setHistoryProvider(history);
    buffer.insert([0, 1], "X");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.calls.mostRecent().args[0].getChanges()[0].newText).toBe("X");
    expect(buffer.undo()).toBe(true);
    expect(buffer.getText()).toBe("abc");
    expect(buffer.redo()).toBe(true);
    expect(buffer.getText()).toBe("aXbc");
  });

  it("makes pre-change observation read-only without disabling later notifications", () => {
    buffer = new TextBuffer("abc");
    let calls = 0;
    buffer.onWillChange(() => {
      calls++;
      expect(() => buffer.insert([0, 0], "unexpected")).toThrowError(/onWillChange/);
      expect(() => buffer.undo()).toThrowError(/onWillChange/);
    });
    buffer.insert([0, 1], "X");
    buffer.undo();
    buffer.redo();
    expect(calls).toBe(3);
    expect(buffer.getText()).toBe("aXbc");
  });

  it("rejects edits from synchronous language notifications and updates parser input first", () => {
    buffer = new TextBuffer("abc");
    const revision = buffer.getTextRevision();
    spyOn(buffer.languageMode, "bufferDidChange").and.callFake((change) => {
      expect(buffer.getTextRevision()).toBe(revision + 1);
      expect(buffer.getText()).toBe("aXbc");
      expect(change.startIndex).toBe(1);
      expect(() => buffer.insert([0, 0], "unexpected")).toThrowError(/synchronous edit/);
    });
    buffer.insert([0, 1], "X");
    expect(buffer.getText()).toBe("aXbc");
  });

  it("invalidates a retained batch even after its listeners unsubscribe", () => {
    buffer = new TextBuffer("abc");
    let batch;
    const subscription = buffer.onDidApplyChanges((value) => {
      batch = value;
    });
    buffer.insert([0, 0], "X");
    subscription.dispose();
    expect(batch.isCurrent()).toBe(true);
    buffer.insert([0, 0], "Y");
    expect(batch.isCurrent()).toBe(false);
  });

  it("keeps cancelled edits in the ordered stream while restoring text and history", () => {
    buffer = new TextBuffer("abc");
    const batches = [];
    buffer.onDidApplyChanges((batch) => batches.push(batch));
    buffer.transact(() => {
      buffer.insert([0, 1], "X");
      buffer.abortTransaction();
    });
    expect(buffer.getText()).toBe("abc");
    expect(buffer.undo()).toBe(false);
    // The rollback and original edit are both real applied edits.
    const changes = batches.flatMap((batch) => batch.changes);
    expect(changes.map((change) => change.newText)).toEqual(["X", ""]);
  });

  it("undoes a CR insertion immediately before LF without losing the newline", () => {
    buffer = new TextBuffer("abc\ndef");
    buffer.insert([0, 3], "\r", { normalizeLineEndings: false });
    expect(buffer.getText()).toBe("abc\r\ndef");
    buffer.undo();
    expect(buffer.getText()).toBe("abc\ndef");
    buffer.redo();
    expect(buffer.getText()).toBe("abc\r\ndef");
  });

  for (const [before, after] of [
    ["abc\ndef", "abc\r\ndef"],
    ["a\rb", "a\r\nb"],
  ]) {
    it(`publishes exact reload offsets and replays CRLF history for ${JSON.stringify(before)}`, async () => {
      jasmine.useRealClock();
      const file = path.join(os.tmpdir(), `lumine-edit-contract-${randomUUID()}.txt`);
      fs.writeFileSync(file, before);
      try {
        buffer = TextBuffer.loadSync(file);
        let revision = buffer.getTextRevision();
        let replay = before;
        let batches = 0;
        buffer.onDidApplyChanges((batch) => {
          expect(batch.beforeRevision).toBe(revision);
          for (const change of batch.changes) {
            expect(replay.slice(change.startIndex, change.oldEndIndex)).toBe(change.oldText);
            replay =
              replay.slice(0, change.startIndex) +
              change.newText +
              replay.slice(change.oldEndIndex);
          }
          expect(replay).toBe(buffer.getText());
          revision = batch.afterRevision;
          batches++;
        });
        fs.writeFileSync(file, after);
        await buffer.reload();
        expect(buffer.getText()).toBe(after);
        const loadedRevision = buffer.getTextRevision();
        await buffer.reload();
        expect(buffer.getTextRevision()).toBe(loadedRevision);
        buffer.undo();
        expect(buffer.getText()).toBe(before);
        buffer.redo();
        expect(buffer.getText()).toBe(after);
        expect(batches).toBe(3);
        const history = buffer.getHistory();
        expect(history.baseText).toBe(before);
        const restored = new TextBuffer(after);
        try {
          restored.restoreDefaultHistoryProvider(history);
          restored.undo();
          expect(restored.getText()).toBe(before);
          restored.redo();
          expect(restored.getText()).toBe(after);
        } finally {
          restored.destroy();
        }
      } finally {
        buffer?.destroy();
        fs.unlinkSync(file);
      }
    });
  }
});
