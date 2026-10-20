const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const TextStore = require("../../src/text-store");
const Patch = require("../../src/text-patch");

test("diff marks deadline fallbacks as coarse while retaining common prefix and suffix", (t) => {
  const before = "prefix\nbefore\nunchanged\nafter\nsuffix";
  const after = "prefix\nBEFORE\nunchanged\nAFTER\nsuffix";
  const store = new TextStore(before);
  assert.notEqual(store.diff(after).isCoarse, true);
  let now = 0;
  t.mock.method(Date, "now", () => (now += 2000));

  const patch = store.diff(after);
  assert.equal(patch.isCoarse, true);
  const [change] = patch.getChanges();
  assert.equal(patch.getChangeCount(), 1);
  assert.deepEqual(change.oldStart, { row: 1, column: 0 });
  assert.deepEqual(change.oldEnd, { row: 3, column: 5 });
  assert.equal(change.oldText, "before\nunchanged\nafter");
  assert.equal(change.newText, "BEFORE\nunchanged\nAFTER");
  assert.equal(store.getText(), before);
  assert.notEqual(store.diff(before).isCoarse, true);
  assert.notEqual(new TextStore("prefix suffix").diff("prefix new suffix").isCoarse, true);
  assert.notEqual(new TextStore("prefix old suffix").diff("prefix suffix").isCoarse, true);
});

test("completion preserves Unicode words and indices across chunk boundaries and case expansion", async () => {
  const word = "𐐀abc";
  const matches = await new TextStore(" ".repeat(32767) + word).findWordsWithSubsequence(
    "abc",
    "",
    5,
  );
  assert.equal(matches[0].word, word);
  assert.deepEqual(matches[0].positions, [{ row: 0, column: 32767 }]);
  assert.deepEqual(matches[0].matchIndices, [2, 3, 4]);
  for (const query of ["i", "İ", "ist"]) {
    const result = await new TextStore("İstanbul").findWordsWithSubsequence(query, "", 5);
    assert.equal(result[0].word, "İstanbul");
    assert.deepEqual(
      result[0].matchIndices,
      Array.from({ length: query.length }, (_, i) => i),
    );
  }
});

test("range searches retain real line boundaries and standard word-boundary matches", () => {
  const store = new TextStore("first\n  \r\nsecond");
  assert.deepEqual(
    store.findInRangeSync(/^/m, { start: { row: 0, column: 5 }, end: { row: 1, column: 0 } }),
    { start: { row: 1, column: 0 }, end: { row: 1, column: 0 } },
  );
  assert.deepEqual(
    store.findAllInRangeSync(/^[\t ]*$/g, {
      start: { row: 0, column: 0 },
      end: { row: 2, column: 0 },
    }),
    [{ start: { row: 1, column: 0 }, end: { row: 1, column: 2 } }],
  );
  assert.deepEqual(
    new TextStore("one two").findAllSync(/\b/g).map(({ start }) => start.column),
    [0, 3, 4, 7],
  );
});

test("Unicode regex searches never return context before a range starting inside a surrogate pair", () => {
  const store = new TextStore("😀x");
  const range = { start: { row: 0, column: 1 }, end: { row: 0, column: 3 } };
  assert.deepEqual(store.findAllInRangeSync(/./gu, range), [
    { start: { row: 0, column: 2 }, end: { row: 0, column: 3 } },
  ]);
  assert.deepEqual(store.findAllInRangeSync(/(?=.)/gu, range), [
    { start: { row: 0, column: 2 }, end: { row: 0, column: 2 } },
  ]);
});

test("asynchronous searches own the invocation snapshot and let queued work run first", async () => {
  const store = new TextStore("first old\nsecond old");
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const matches = store.findAll(/old/);
  const words = store.findWordsWithSubsequence("old", "", 10);
  store.setText("new contents");
  assert.deepEqual(await matches, [
    { start: { row: 0, column: 6 }, end: { row: 0, column: 9 } },
    { start: { row: 1, column: 7 }, end: { row: 1, column: 10 } },
  ]);
  assert.equal(yielded, true);
  assert.equal((await words)[0].word, "old");
});

test("dense asynchronous regex searches yield between match batches", async () => {
  const store = new TextStore("needle\r\n".repeat(100000));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    const matches = await store.findAll(/needle/g);
    assert.equal(matches.length, 100000);
    assert.deepEqual(matches.at(-1), {
      start: { row: 99999, column: 0 },
      end: { row: 99999, column: 6 },
    });
    assert(ticks > 1, "search must yield during scanning, not only before it starts");
  } finally {
    clearInterval(timer);
  }
});

test("ordered search endpoints preserve multiline, CRLF and Unicode positions", () => {
  const text = "prefix😀\r\nfirst needle\nsecond needle\r\nlast😀";
  const store = new TextStore(text);
  for (const regex of [/needle/g, /first[\s\S]+second/g, /\r?\n/g, /(?=.)/gu, /😀/gu]) {
    const expected = Array.from(text.matchAll(regex), (match) => ({
      start: store.positionForCharacterIndex(match.index),
      end: store.positionForCharacterIndex(match.index + match[0].length),
    }));
    assert.deepEqual(store.findAllSync(regex), expected, regex.toString());
  }
  assert.deepEqual(
    store.findAllInRangeSync(/needle/g, {
      start: { row: 1, column: 4 },
      end: { row: 2, column: 13 },
    }),
    [
      { start: { row: 1, column: 6 }, end: { row: 1, column: 12 } },
      { start: { row: 2, column: 7 }, end: { row: 2, column: 13 } },
    ],
  );
});

test("prepared JS edits retain exact snapshots, reject stale commits and invert CRLF changes", () => {
  const store = new TextStore("first\n😀second\r\n");
  const initial = store.getTextSnapshot();
  const edit = store.prepareEdit(
    { start: { row: 0, column: 5 }, end: { row: 0, column: 5 } },
    "\r",
  );
  const stale = store.prepareEdit(
    { start: { row: 0, column: 0 }, end: { row: 0, column: 1 } },
    "X",
  );
  const patch = edit.createPatch();
  assert.equal(edit.getChange().oldText, "\n");
  assert.equal(edit.getChange().newText, "\r\n");
  edit.commit();
  edit.dispose();
  assert.equal(store.getText(), "first\r\n😀second\r\n");
  assert.equal(initial.toString(), "first\n😀second\r\n");
  assert.throws(() => stale.commit(), { code: "ERR_STALE_EDIT" });
  stale.dispose();
  for (const change of patch.invert().getChanges()) store.prepareEditFromChange(change).commit();
  assert.equal(store.isModified(), false);
  assert.equal(store.getText(), initial.toString());
});

test("piece summaries recognize surrogate pairs formed and split at edit and buffer boundaries", () => {
  const store = new TextStore("x".repeat(32767) + "\ud83d\ude00");
  assert.equal(store.hasAstral(), true);
  const before = store.getTextSnapshot();
  store.setTextInRange({ start: { row: 0, column: 32768 }, end: { row: 0, column: 32768 } }, "_");
  assert.equal(store.hasAstral(), false);
  assert.equal(before.hasAstral, true);
  store.setTextInRange({ start: { row: 0, column: 32768 }, end: { row: 0, column: 32769 } }, "");
  assert.equal(store.hasAstral(), true);
});

test("cached line reads remain current after edits, history replay, eviction and reset", () => {
  const store = new TextStore(Array.from({ length: 300 }, (_, i) => `line ${i}\r\n`).join(""));
  const verify = () => {
    const lines = store.getText().split("\n");
    for (let row = lines.length - 1; row >= 0; row--) {
      const ending = row === lines.length - 1 ? "" : lines[row].endsWith("\r") ? "\r\n" : "\n";
      const text = ending === "\r\n" ? lines[row].slice(0, -1) : lines[row];
      assert.equal(store.lineForRow(row), text);
      assert.equal(store.lineForRow(row), text);
      assert.equal(store.lineLengthForRow(row), text.length);
      assert.equal(store.lineEndingForRow(row), ending);
    }
  };
  verify();
  const prepared = store.prepareEdit(
    { start: { row: 1, column: 2 }, end: { row: 298, column: 3 } },
    "new\ncontent",
  );
  const inverse = prepared.createPatch().invert();
  prepared.commit();
  prepared.dispose();
  verify();
  for (const change of inverse.getChanges()) {
    const edit = store.prepareEditFromChange(change);
    edit.commit();
    edit.dispose();
  }
  verify();
  store.reset("replacement\r\nlast");
  verify();
});

test("stored changes and history serialize UTF-16 payloads without native objects", () => {
  const store = new TextStore("one\r\ntwo\n");
  store.setTextInRange({ start: { row: 1, column: 0 }, end: { row: 1, column: 3 } }, "\ud800終");
  const other = new TextStore("one\r\ntwo\n");
  other.deserializeChanges(store.serializeChanges());
  assert.equal(other.getText(), store.getText());
  const patch = Patch.deserialize(store.serializeChanges());
  for (const change of patch.invert().getChanges()) other.prepareEditFromChange(change).commit();
  assert.equal(other.isModified(), false);
});

test("file streams preserve split surrogate pairs and saving snapshots leaves later edits dirty", async () => {
  const source = "a".repeat(32767) + "😀\r\n終";
  const store = new TextStore(source);
  const chunks = [];
  let release;
  const output = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      release = done;
    },
  });
  const save = store.save(output, "utf8");
  store.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, "later");
  // Drain every backpressured write while retaining the source version from
  // the save invocation rather than reading the changing live text.
  while (!output.writableFinished) {
    if (release) {
      const callback = release;
      release = null;
      callback();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await save;
  assert.equal(Buffer.concat(chunks).toString("utf8"), source);
  assert.equal(store.isModified(), true);
  const stream = new PassThrough();
  const loaded = new TextStore();
  const loading = loaded.load(stream);
  const bytes = Buffer.from(source);
  for (let offset = 0; offset < bytes.length; offset += 137)
    stream.write(bytes.subarray(offset, offset + 137));
  stream.end();
  await loading;
  assert.equal(loaded.getText(), source);
});

test("cancelled loads do not reset newer text or its saved base", async () => {
  const store = new TextStore("base");
  const stream = new PassThrough();
  const loading = store.load(stream, { force: true }, () => false);
  store.setText("local");
  stream.end("obsolete");
  assert.equal(await loading, null);
  assert.equal(store.getText(), "local");
  assert.equal(store.isModified(), true);
  assert.equal(store.baseTextDigest(), new TextStore("base").baseTextDigest());
});

test("invalid encodings reject before opening or truncating the file", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-js-store-"));
  const file = path.join(directory, "document.txt");
  try {
    fs.writeFileSync(file, "keep");
    const store = new TextStore("replacement");
    await assert.rejects(store.save(file, "no-such-encoding"), /Invalid encoding/);
    assert.equal(fs.readFileSync(file, "utf8"), "keep");
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test("the real TextBuffer edit, marker and undo path never loads Superstring", () => {
  const entry = require.resolve("../../src/text-buffer");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.CI;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const TextBuffer = require(${JSON.stringify(entry)});
    const buffer = new TextBuffer('first\\nsecond');
    const marker = buffer.markRange([[1,0],[1,6]]);
    buffer.insert([0,0], 'prefix\\n'); buffer.undo();
    if (marker.getRange().start.row !== 1) throw Error('marker');
    if (Object.keys(require.cache).some(file => /[\\\\/]superstring[\\\\/]/.test(file))) throw Error('native document dependency');
    buffer.destroy();
  `,
    ],
    { encoding: "utf8", env, windowsHide: true, timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
