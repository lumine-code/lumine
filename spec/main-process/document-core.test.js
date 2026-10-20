const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const PieceTree = require("../../src/piece-tree");
const { DocumentCore } = require("../../src/document-core");
const TreeSitterDocument = require("../../src/tree-sitter-document");

function random(seed) {
  return (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
}

function position(text, index) {
  const prefix = text.slice(0, index);
  return { row: prefix.split("\n").length - 1, column: index - prefix.lastIndexOf("\n") - 1 };
}

test("line lookup cursors stay local to immutable and fragmented snapshots", () => {
  const next = random(481);
  let source =
    "x".repeat(32767) +
    "\r\n" +
    Array.from(
      { length: 2500 },
      (_, row) => "😀x".repeat(row % 37) + (row % 2 ? "\n" : "\r\n"),
    ).join("");
  let tree = new PieceTree(source);
  const retained = [];
  for (let edit = 0; edit < 100; edit++) {
    if (edit % 20 === 0) retained.push([tree, source]);
    for (const [snapshot, text] of [...retained, [tree, source]]) {
      const starts = [0];
      for (let lf = text.indexOf("\n"); lf >= 0; lf = text.indexOf("\n", lf + 1))
        starts.push(lf + 1);
      for (const row of [
        0,
        starts.length - 1,
        ...Array.from({ length: 40 }, () => next(starts.length)),
      ]) {
        for (let nearby = row; nearby < Math.min(row + 4, starts.length); nearby++) {
          assert.equal(snapshot.lineStart(nearby), starts[nearby]);
          assert.equal(snapshot.offsetAt({ row: nearby, column: 0 }), starts[nearby]);
        }
      }
      assert.throws(() => snapshot.lineStart(starts.length), RangeError);
      assert.throws(() => snapshot.lineStart(0.5), RangeError);
    }
    const start = next(source.length + 1);
    const end = Math.min(source.length, start + next(400));
    const inserted = ["", "\n\n", "a\r\nb", "\ud800x\udfff"][next(4)];
    tree = tree.replace(start, end, inserted);
    source = source.slice(0, start) + inserted + source.slice(end);
  }
});

test("line-ending metadata survives edits across piece boundaries and old snapshots", () => {
  const endings = (text) =>
    new Set([
      ...(/(^|[^\r])\n/.test(text) ? ["\n"] : []),
      ...(text.includes("\r\n") ? ["\r\n"] : []),
    ]);
  const next = random(813);
  let text = "x".repeat(32767) + "\r\n" + "y".repeat(32766) + "\r\n\n\r";
  let tree = new PieceTree(text);
  const retained = [];
  for (let i = 0; i < 800; i++) {
    assert.deepEqual(tree.getLineEndings(), endings(text));
    if (i % 100 === 0) retained.push([tree, text]);
    const start = next(text.length + 1);
    const end = Math.min(text.length, start + next(1000));
    const inserted = ["", "\r", "\n", "\r\n", "x\ny", "\r\rx", "\n\n"][next(7)];
    tree = tree.replace(start, end, inserted);
    text = text.slice(0, start) + inserted + text.slice(end);
  }
  for (const [snapshot, source] of [...retained, [tree, text]]) {
    assert.deepEqual(snapshot.getLineEndings(), endings(source));
    snapshot.getLineEndings().clear();
    assert.deepEqual(snapshot.getLineEndings(), endings(source));
  }
  for (const source of ["", "\r", "\n", "\r\n", "\rX\n"]) {
    const before = new PieceTree(source);
    for (let start = 0; start <= source.length; start++)
      for (let end = start; end <= source.length; end++)
        for (const inserted of ["", "\r", "\n", "\r\n"])
          assert.deepEqual(
            before.replace(start, end, inserted).getLineEndings(),
            endings(source.slice(0, start) + inserted + source.slice(end)),
          );
  }
});

test("snapshot line readers stream exact rows across piece and CRLF boundaries", () => {
  for (const source of [
    "",
    "\n",
    "first\r\nsecond\r",
    "x".repeat(32767) + "\r\n😀\n",
    "a\nb\n\nc\r\n",
  ]) {
    const snapshot = new PieceTree(source);
    const expected = source.split(/\r?\n/);
    assert.deepEqual([...snapshot.lines()], expected);
    const line = snapshot.lineReader();
    for (const row of [0, 0, 1, expected.length - 1, 0, 1, 2, -1, expected.length])
      assert.equal(line(row), expected[row]);
    for (let start = 0; start <= expected.length; start++)
      for (let end = start; end <= expected.length; end++)
        assert.deepEqual([...snapshot.lines(start, end)], expected.slice(start, end));
    const reader = snapshot.lines();
    snapshot.replace(0, snapshot.length, "replacement");
    assert.deepEqual([...reader], expected);
  }
});

test("piece coordinates preserve CRLF, lone CR, surrogates, NUL and trailing LF", () => {
  for (const source of [
    "",
    "a\r\nb\rc\n",
    "\n\n",
    "\ud800\0😀\udfff",
    "a".repeat(32767) + "\r\n😀\n",
  ]) {
    const text = new PieceTree(source);
    assert.equal(text.toString(), source);
    assert.equal(text.lineCount, source.split("\n").length);
    for (let index = 0; index <= source.length; index++) {
      const point = position(source, index);
      assert.deepEqual(text.positionAt(index), point);
      assert.equal(text.offsetAt(point), index);
      if (index < source.length) assert.equal(text.charCodeAt(index), source.charCodeAt(index));
    }
    text.inspect();
  }
});

test("persistent piece edits match a flat string across fragmented random histories", () => {
  const inserts = ["", "\r", "\n", "\r\n", "😀", "\ud800", "\udfff", "終", "123", "\0"];
  for (const seed of [1, 42, 918273]) {
    const next = random(seed);
    let source = "line\r\n😀\n".repeat(12000);
    let text = new PieceTree(source);
    const retained = [];
    for (let edit = 0; edit < 2000; edit++) {
      if (edit % 200 === 0) retained.push([text, source]);
      const start = next(source.length + 1);
      const end = Math.min(source.length, start + next(30));
      const insertion = inserts[next(inserts.length)];
      text = text.replace(start, end, insertion);
      source = source.slice(0, start) + insertion + source.slice(end);
      assert.equal(text.length, source.length);
      for (const index of [start, next(source.length + 1), source.length]) {
        assert.deepEqual(text.positionAt(index), position(source, index));
        assert.equal(text.slice(index, index + 70), source.slice(index, index + 70));
      }
      if (edit % 40 === 0) {
        assert.equal(text.toString(), source);
        text.inspect();
      }
    }
    for (const [snapshot, expected] of retained) assert.equal(snapshot.toString(), expected);
    text.inspect();
  }
});

test("typing and deleting locally coalesces small pieces and retains old snapshots", () => {
  let text = new PieceTree("start\nend");
  const before = text;
  for (let index = 0; index < 12000; index++) text = text.replace(6 + index, 6 + index, "x");
  assert.equal(text.slice(6, 12006), "x".repeat(12000));
  assert.ok(text.inspect().pieces < 100, JSON.stringify(text.inspect()));
  text = text.replace(6, 12006, "");
  assert.equal(text.toString(), before.toString());
});

test("piece readers support nonsequential reads and boundaries inside Unicode and CRLF", () => {
  const source = "a".repeat(32767) + "😀\r\n" + "b".repeat(40000);
  const text = new PieceTree(source).replace(32768, 32768, "\n");
  const expected = source.slice(0, 32768) + "\n" + source.slice(32768);
  const read = text.reader(4096);
  for (const start of [32768, 0, 65535, 32767, 12, expected.length]) {
    const result = read(start);
    assert.ok(result.length <= 4096);
    assert.equal(result, expected.slice(start, start + result.length));
  }
  let result = "";
  for (let index = 0; index < text.length;) {
    const chunk = read(index);
    assert.ok(chunk.length > 0);
    result += chunk;
    index += chunk.length;
  }
  assert.equal(result, expected);
  assert.equal(read(text.length + 100), "");
  assert.throws(() => text.reader(0), RangeError);
  assert.throws(() => text.positionAt(-1), RangeError);
  assert.throws(() => text.offsetAt({ row: 0, column: Infinity }), RangeError);
  assert.throws(() => text.replace(5, 2, ""), RangeError);
});

test("a draft publishes one revision and sequential exact deltas only on commit", () => {
  const document = new DocumentCore("a\r\nb😀");
  const events = [];
  document.onDidApplyChanges((event) => events.push(event));
  const initial = document.snapshot();
  const draft = document.begin();
  draft.replace(2, 2, "x").replace(0, 1, "\ud800");
  assert.equal(document.snapshot(), initial);
  assert.equal(events.length, 0);
  const batch = draft.commit();
  assert.equal(batch.beforeRevision, 0);
  assert.equal(batch.afterRevision, 1);
  assert.equal(events.length, 1);
  let replay = initial.text.toString();
  for (const edit of batch.changes) {
    assert.deepEqual(edit.oldRange.start, position(replay, edit.startIndex));
    assert.deepEqual(edit.oldRange.end, position(replay, edit.oldEndIndex));
    assert.equal(edit.oldText, replay.slice(edit.startIndex, edit.oldEndIndex));
    replay = replay.slice(0, edit.startIndex) + edit.newText + replay.slice(edit.oldEndIndex);
    assert.deepEqual(edit.newRange.end, position(replay, edit.newEndIndex));
  }
  assert.equal(document.getText(), replay);
  assert.equal(initial.text.toString(), "a\r\nb😀");
  assert.equal(document.getTextRevision(), 1);
  assert.throws(() => draft.commit(), /closed/);
});

test("abort, invalid batches and stale drafts cannot publish partial changes", () => {
  const document = new DocumentCore("abcdef");
  let events = 0;
  document.onDidApplyChanges(() => events++);
  const before = document.snapshot();
  const aborted = document.begin().replace(0, 1, "X");
  aborted.abort();
  assert.equal(document.snapshot(), before);
  assert.throws(() => aborted.commit(), /closed/);
  assert.throws(
    () =>
      document.transact((draft) => {
        draft.replace(0, 1, "X");
        throw new Error("stop");
      }),
    /stop/,
  );
  const invalid = document.begin();
  assert.throws(
    () =>
      invalid.replaceAll([
        { start: 0, end: 3, text: "x" },
        { start: 2, end: 4, text: "y" },
      ]),
    /overlap/,
  );
  assert.equal(invalid.text, before.text);
  document.transact((draft) => draft.replace(0, 0, "prefix"));
  assert.throws(() => invalid.replace(0, 1, "Y").commit(), /stale/);
  assert.equal(events, 1);
  assert.equal(document.getText(), "prefixabcdef");
});

test("batch edits use base offsets, undo shares the old root and redo advances revision", () => {
  const document = new DocumentCore("one\ntwo\nthree");
  const first = document.snapshot();
  const batch = document.transact((draft) =>
    draft.replaceAll([
      { start: 0, end: 3, text: "ONE!" },
      { start: 8, end: 13, text: "3" },
    ]),
  );
  const second = document.snapshot();
  assert.equal(document.getText(), "ONE!\ntwo\n3");
  assert.equal(batch.changeSet.mapIndex(4), 5);
  assert.equal(batch.changeSet.mapIndex(8, "left"), 9);
  const undo = document.undo();
  assert.equal(document.snapshot().text, first.text);
  assert.equal(document.getTextRevision(), 2);
  let replay = second.text.toString();
  for (const edit of undo.changes)
    replay = replay.slice(0, edit.startIndex) + edit.newText + replay.slice(edit.oldEndIndex);
  assert.equal(replay, first.text.toString());
  document.redo();
  assert.equal(document.snapshot().text, second.text);
  assert.equal(document.getTextRevision(), 3);
  document.undo();
  document.transact((draft) => draft.replace(0, 0, "new"));
  assert.equal(document.redo(), null);
});

test("bulk tree assembly matches sequential edits and exact deltas across fragmented sources", () => {
  for (let seed = 1; seed <= 6; seed++) {
    const next = random(seed);
    const document = new DocumentCore("a😀b\r\n".repeat(18000));
    for (let iteration = 0; iteration < 30; iteration++) {
      const before = document.snapshot();
      const original = before.text.toString();
      const width = Math.floor(original.length / 12);
      const edits = Array.from({ length: 12 }, (_, i) => {
        const start = i * width + next(Math.max(1, width - 30));
        return {
          start,
          end: start + next(20),
          text: ["", "new\nline", "\r\n", "😀\ud800", "x".repeat(1100)][next(5)],
        };
      });
      const batch = document.transact((draft) => draft.replaceAll(edits.slice().reverse()));
      let expected = original;
      for (const edit of edits.slice().reverse())
        expected = expected.slice(0, edit.start) + edit.text + expected.slice(edit.end);
      assert.equal(document.getText(), expected);
      document.getTextSnapshot().inspect();
      assert.equal(before.text.toString(), original);
      let replay = original;
      for (const edit of batch.changes) {
        assert.equal(replay.slice(edit.startIndex, edit.oldEndIndex), edit.oldText);
        assert.deepEqual(edit.oldRange, {
          start: position(replay, edit.startIndex),
          end: position(replay, edit.oldEndIndex),
        });
        replay = replay.slice(0, edit.startIndex) + edit.newText + replay.slice(edit.oldEndIndex);
        assert.deepEqual(edit.newRange, {
          start: position(replay, edit.startIndex),
          end: position(replay, edit.newEndIndex),
        });
      }
      assert.equal(replay, expected);
      document.undo();
      assert.equal(document.getTextSnapshot(), before.text);
      document.redo();
      assert.equal(document.getText(), expected);
      document.clearHistory();
    }
  }
});

test("no-op transactions retain revisions and history limits release undo entries", () => {
  const document = new DocumentCore("x", { historyLimit: 2 });
  assert.equal(
    document.transact((draft) => draft.replace(0, 1, "x")),
    null,
  );
  assert.equal(document.getTextRevision(), 0);
  for (const text of ["a", "b", "c"]) document.transact((draft) => draft.replace(0, 1, text));
  document.undo();
  document.undo();
  assert.equal(document.getText(), "a");
  assert.equal(document.undo(), null);
  document.clearHistory();
  assert.equal(document.redo(), null);
});

test("reentrant observers receive commits in order and errors cannot drop deliveries", () => {
  const document = new DocumentCore("x");
  const received = [];
  document.onDidApplyChanges((batch) => {
    if (batch.afterRevision === 1) {
      document.transact((draft) => draft.replace(0, 1, "z"));
      throw new Error("observer");
    }
  });
  document.onDidApplyChanges((batch) =>
    received.push([batch.afterRevision, batch.isCurrent(), batch.snapshot.text.toString()]),
  );
  assert.throws(() => document.transact((draft) => draft.replace(0, 1, "y")), AggregateError);
  assert.deepEqual(received, [
    [1, false, "y"],
    [2, true, "z"],
  ]);
  assert.equal(document.getText(), "z");
});

test("the parser journal captures piece roots without materializing the document", () => {
  const document = new DocumentCore("value\r\n".repeat(20000));
  document.getText = () => {
    throw new Error("Full document read");
  };
  const reader = new TreeSitterDocument(document);
  const before = reader.capture();
  document.transact((draft) => draft.replace(0, 5, "changed"));
  const after = reader.capture(before);
  assert.equal(after.text, document.snapshot().text);
  assert.equal(after.previous, before);
  assert.equal(after.edits.length, 1);
  assert.equal(after.edits[0].newText.toString(), "changed");
  document.undo();
  assert.equal(reader.capture().text, before.text);
  reader.close();
});

test("document core loads and edits without loading any native addon", () => {
  const modulePath = require.resolve("../../src/document-core");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.CI;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { DocumentCore } = require(${JSON.stringify(modulePath)});
    const doc = new DocumentCore('abc');
    doc.transact(draft => draft.replace(1, 2, 'XYZ'));
    if (doc.getText() !== 'aXYZc') throw Error('incorrect edit');
    if (Object.keys(require.cache).some(path => path.endsWith('.node'))) throw Error('native addon');
  `,
    ],
    { encoding: "utf8", env, windowsHide: true, timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test("random transactions including exceptions and history branches match a string oracle", () => {
  const document = new DocumentCore("initial\r\n", { historyLimit: 10000 });
  let expected = document.getText();
  const undo = [];
  const redo = [];
  const next = random(2345);
  for (let iteration = 0; iteration < 1500; iteration++) {
    const action = next(10);
    if (action === 0 && undo.length) {
      redo.push(expected);
      expected = undo.pop();
      document.undo();
    } else if (action === 1 && redo.length) {
      undo.push(expected);
      expected = redo.pop();
      document.redo();
    } else {
      const draft = document.begin();
      let planned = expected;
      let changed = false;
      for (let edit = 0, count = next(5) + 1; edit < count; edit++) {
        const start = next(planned.length + 1);
        const end = Math.min(planned.length, start + next(5));
        const inserted = ["", "a\r\n", "\ud800", "😀"][next(4)];
        changed ||= planned.slice(start, end) !== inserted;
        planned = planned.slice(0, start) + inserted + planned.slice(end);
        draft.replace(start, end, inserted);
      }
      if (action === 2) draft.abort();
      else {
        draft.commit();
        if (changed) {
          undo.push(expected);
          redo.length = 0;
        }
        expected = planned;
      }
    }
    assert.equal(document.getText(), expected, `transaction ${iteration}`);
    document.getTextSnapshot().inspect();
  }
});
