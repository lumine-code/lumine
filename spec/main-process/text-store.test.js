const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Writable, Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const TextStore = require("../../src/text-store");
const Patch = require("../../src/text-patch");

test("synchronous loading decodes bounded chunks with BOM and split multibyte sequences intact", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-stream-sync-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const iconv = require("iconv-lite");
  const text = "\ufeff" + "x".repeat(65531) + "😀\r\nZażółć\ud800";
  const files = ["utf8", "utf16le", "utf16be"].map((encoding) => {
    const file = path.join(directory, encoding);
    const bytes = iconv.encode(text, encoding);
    fs.writeFileSync(file, bytes);
    return { file, encoding, expected: iconv.decode(bytes, encoding, { stripBOM: false }) };
  });
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (files.some((entry) => entry.file === file))
      throw new Error("full-file reads are forbidden");
    return readFile(file, ...args);
  });
  const originalRead = fs.readSync;
  let largest = 0;
  t.mock.method(fs, "readSync", (fd, target, offset, length, position) => {
    largest = Math.max(largest, length);
    return originalRead(fd, target, offset, Math.min(length, 7), position);
  });
  for (const { file, encoding, expected } of files) {
    const store = new TextStore();
    store.loadSync(file, encoding);
    assert.equal(store.getText(), expected);
  }
  assert.equal(largest, 64 * 1024);
});

test("synchronous load closes its descriptor and leaves prior text intact on read failure", (t) => {
  t.mock.method(fs, "openSync", () => 123);
  t.mock.method(fs, "readSync", () => {
    throw new Error("failed read");
  });
  const close = t.mock.method(fs, "closeSync", () => {});
  const store = new TextStore("previous");
  assert.throws(() => store.loadSync("file"), /failed read/);
  assert.equal(store.getText(), "previous");
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(close.mock.calls[0].arguments, [123]);
});

test("unchanged reload reuses the exact saved root and digest across decoder boundaries", async (t) => {
  const iconv = require("iconv-lite");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-reload-root-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const text = "\ufeff" + "a".repeat(32765) + "😀\r\nżółć\rtail\ufeff";
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const bytes = iconv.encode(text, encoding);
    const expected = iconv.decode(bytes, encoding, { stripBOM: false });
    const store = new TextStore(expected),
      base = store.getTextSnapshot();
    const digest = store.baseTextDigest();
    store.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, "UNSAVED");
    const chunks = function* () {
      for (let offset = 0; offset < bytes.length; offset += 7)
        yield bytes.subarray(offset, offset + 7);
    };
    const patch = await store.load(Readable.from(chunks()), { force: true, encoding });
    assert.equal(store.getTextSnapshot(), base);
    assert.equal(store.getText(), expected);
    assert.equal(store.isModified(), false);
    assert.equal(patch.getChangeCount(), 1);
    const file = path.join(directory, encoding);
    fs.writeFileSync(file, bytes);
    store.loadSync(file, encoding);
    assert.equal(store.getTextSnapshot(), base);
    const hash = t.mock.method(require("node:crypto"), "createHash", () => {
      throw Error("Unchanged saved base was rehashed");
    });
    assert.equal(store.baseTextDigest(), digest);
    hash.mock.restore();
  }
});

test("custom streams cannot allocate unbounded decoder strings during load or saved-base comparison", async (t) => {
  const iconv = require("iconv-lite");
  const getDecoder = iconv.getDecoder;
  let largest = 0;
  t.mock.method(iconv, "getDecoder", (...args) => {
    const decoder = getDecoder(...args),
      write = decoder.write;
    decoder.write = (bytes) => {
      largest = Math.max(largest, bytes.length);
      assert.ok(bytes.length <= 65536, `Unbounded decoder input: ${bytes.length}`);
      return write.call(decoder, bytes);
    };
    return decoder;
  });
  const text = "\ufeff" + ("a".repeat(65530) + "😀\r\nżółć\rtail").repeat(32);
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const bytes = iconv.encode(text, encoding),
      store = new TextStore();
    assert.ok(bytes.length > 1024 * 1024);
    await store.load(Readable.from([bytes]), { encoding });
    const base = store.getTextSnapshot();
    assert.equal(store.getText(), text);
    store.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, "local");
    await store.load(Readable.from([bytes]), { force: true, encoding });
    assert.equal(store.getTextSnapshot(), base);
    assert.equal(await store.baseTextMatchesFile(Readable.from([bytes]), encoding), true);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    assert.equal(await store.baseTextMatchesFile(Readable.from([changed]), encoding), false);
  }
  assert.equal(largest, 65536);
});

test("reload shares matching backing leaves while retaining every changed, truncated and appended unit", async () => {
  const before = "x".repeat(1024 * 1024),
    store = new TextStore(before);
  const base = store.getTextSnapshot(),
    known = new WeakMap();
  for (const node of base.snapshotNodes(known)) known.set(node.identity, true);
  const changed = before.slice(0, 300000) + "Z" + before.slice(300001);
  const chunks = function* () {
    for (let offset = 0; offset < changed.length; offset += 65536)
      yield Buffer.from(changed.slice(offset, offset + 65536));
  };
  await store.load(Readable.from(chunks()), { force: true });
  assert.equal(store.getText(), changed);
  let newLeafUnits = 0;
  for (const node of store.getTextSnapshot().snapshotNodes(known))
    if (node.text) newLeafUnits += node.text.length;
  assert.ok(newLeafUnits <= 65536, `Unexpected newly allocated source span: ${newLeafUnits}`);
  for (const text of [
    changed.slice(0, 123456),
    changed + "\r\n😀",
    "",
    "entirely different\rsource\n",
  ]) {
    await store.load(Readable.from([Buffer.from(text)]), { force: true });
    assert.equal(store.getText(), text);
    assert.equal(await store.baseTextMatchesFile(Readable.from([Buffer.from(text)]), "utf8"), true);
    assert.equal(
      await store.baseTextMatchesFile(Readable.from([Buffer.from(text + "!")]), "utf8"),
      false,
    );
  }
});

test("reference reuse never publishes a partial failed stream or overwrites an intervening edit", async () => {
  const original = "head\r\n" + "x".repeat(131072),
    store = new TextStore(original);
  const base = store.getTextSnapshot();
  const failure = new Error("read failed after an unchanged prefix");
  async function* broken() {
    yield Buffer.from(original.slice(0, 65536));
    throw failure;
  }
  await assert.rejects(
    store.load(Readable.from(broken()), { force: true }),
    (error) => error === failure,
  );
  assert.equal(store.getTextSnapshot(), base);
  const stream = new PassThrough(),
    loading = store.load(stream);
  stream.write(original.slice(0, 65536));
  store.setTextInRange({ start: { row: 0, column: 0 }, end: { row: 0, column: 0 } }, "local");
  stream.end(original.slice(65536));
  assert.equal(await loading, null);
  assert.equal(store.getText(), "local" + original);
  assert.equal(store.isModified(), true);
});

test("reload stays within a fixed child heap while two full document sources remain alive", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-reload-heap-"));
  t.after(() =>
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  );
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.CI;
  const result = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--max-old-space-size=224",
      path.join(__dirname, "../fixtures/reload-memory-probe.cjs"),
      directory,
    ],
    { encoding: "utf8", env, windowsHide: true, timeout: 60000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const measurements = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const before = measurements.find((entry) => entry.phase === "before-reload"),
    after = measurements.find((entry) => entry.phase === "after-reload");
  assert.equal(after.reusedBase, true);
  assert.ok(
    after.heapUsed - before.heapUsed < 16 * 1024 * 1024,
    `Reload retained ${(after.heapUsed - before.heapUsed) / 1024 / 1024} MiB`,
  );
});

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
