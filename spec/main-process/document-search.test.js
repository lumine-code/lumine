const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const PieceTree = require("../../src/piece-tree");
const TextBuffer = require("../../src/text-buffer");
const { DocumentSearch, searchPattern, buildReplacement } = require("../../src/document-search");

function expected(text, regex) {
  const expression = new RegExp(
    searchPattern(regex.source, true, false),
    regex.flags.replace(/[gmy]/g, "") + "g",
  );
  const result = [];
  let previous;
  for (let match; (match = expression.exec(text));) {
    const start = match.index,
      end = start + match[0].length;
    const key = [
      text[start] === "\n" && text[start - 1] === "\r" ? start - 1 : start,
      text[end] === "\n" && text[end - 1] === "\r" ? end - 1 : end,
    ].join(":");
    if (key !== previous) result.push([start, end, Array.from(match)]);
    previous = key;
    if (!match[0].length)
      expression.lastIndex +=
        expression.unicode && text.codePointAt(expression.lastIndex) > 0xffff ? 2 : 1;
  }
  return result;
}

test("replacement predicates filter before publication and revalidate asynchronous decisions", async () => {
  const source = new PieceTree("one one one");
  const splices = [];
  const result = await buildReplacement(source, [new DocumentSearch(source, /one/g)], "two", {
    literalReplacement: true,
    shouldReplace: async (match) => match.start !== 4,
    onReplacement: (...args) => splices.push(args.slice(0, 3)),
  });
  assert.equal(result.snapshot.toString(), "two one two");
  assert.equal(result.count, 2);
  assert.deepEqual(splices, [
    [0, 3, 3],
    [8, 11, 3],
  ]);
  await assert.rejects(
    buildReplacement(source, [new DocumentSearch(source, /one/g)], "x", {
      shouldReplace: () => undefined,
    }),
    TypeError,
  );
  let current = true;
  await assert.rejects(
    buildReplacement(
      source,
      [new DocumentSearch(source, /one/g, null, { isCurrent: () => current })],
      "x",
      {
        shouldReplace: async () => {
          current = false;
          return true;
        },
      },
    ),
    { code: "ERR_STALE_SEARCH" },
  );
  assert.equal(source.toString(), "one one one");
});

test("bounded windows preserve native anchors, CRLF, Unicode, captures, assertions and backreferences", async () => {
  const source = "ababa\r\n😀ab\nAB\nababa\r\n\n".repeat(12);
  const snapshot = new PieceTree(source);
  for (const regex of [
    /ab/g,
    /\b(?:ab)\b/giu,
    /\n/g,
    /a/g,
    /^/gm,
    /$/gm,
    /(?<=a)b/g,
    /(?<!a)b/g,
    /\b\w+\b/g,
    /./gu,
    /(?=.)/gu,
    /(a)(b)\1/g,
    /[^x]*/g,
    /a.*?b/g,
    /(?<name>ab)\k<name>/g,
  ]) {
    const session = new DocumentSearch(snapshot, regex, null, { windowUnits: 7 });
    const sync = Array.from(session.scan())
      .filter(Boolean)
      .map(({ start, end, match }) => [start, end, Array.from(match)]);
    const async = [];
    for await (const { start, end, match } of session.matches())
      async.push([start, end, Array.from(match)]);
    assert.deepEqual(sync, expected(source, regex), String(regex));
    assert.deepEqual(async, sync, String(regex));
    const summary = await session.collect({ limit: 3 });
    assert.equal(summary.count, sync.length, String(regex));
    assert.equal(summary.ranges.length, Math.min(3, sync.length), String(regex));
  }
});

test("exact count and sparse navigation do not retain every match or presentation range", async () => {
  const session = new DocumentSearch(new PieceTree("one ".repeat(10000)), /one/g, null);
  const result = await session.collect({ limit: 5 });
  assert.equal(result.count, 10000);
  assert.equal(result.ranges.length, 5);
  assert.equal(session.checkpoints.length, 10);
  assert.equal((await session.matchAt(9001)).start, 36004);
  assert.equal((await session.findNear(4097, { backwards: true })).start, 4092);
  assert.equal((await session.findNear(36000)).index, 9001);
});

test("single-line literals beyond V8's string limit never flatten the document", async () => {
  let snapshot = new PieceTree("x".repeat(32768));
  for (let i = 0; i < 14; i++)
    snapshot = snapshot.replace(snapshot.length, snapshot.length, snapshot);
  snapshot = snapshot.replace(snapshot.length - 6, snapshot.length, "needle");
  assert(snapshot.length > require("node:buffer").constants.MAX_STRING_LENGTH);
  const session = new DocumentSearch(snapshot, /needle/g);
  const result = await session.collect({ limit: 1 });
  assert.equal(result.count, 1);
  assert.equal(result.ranges[0].start.column, snapshot.length - 6);
  assert.throws(() => new DocumentSearch(snapshot, /[\s\S]*needle/g), {
    code: "ERR_SEARCH_INPUT_TOO_LARGE",
  });
});

test("no-match work yields, cancellation rejects, and revision-bound sessions reject stale results", async () => {
  const controller = new AbortController();
  let text = new PieceTree("x".repeat(32768));
  for (let i = 0; i < 13; i++) text = text.replace(text.length, text.length, text);
  const session = new DocumentSearch(text, /needle/g, null, { signal: controller.signal });
  const scan = session.collect();
  setImmediate(() => controller.abort());
  await assert.rejects(scan, { name: "AbortError" });
  const buffer = new TextBuffer("one");
  try {
    const current = buffer.createSearch(/one/g);
    buffer.insert([0, 0], "two ");
    await assert.rejects(current.collect(), { code: "ERR_STALE_SEARCH" });
  } finally {
    buffer.destroy();
  }
});

test("pathological native expressions time out away from the main thread", async () => {
  const session = new DocumentSearch(new PieceTree("a".repeat(10000)), /(a+)+b/g);
  let responsive = false;
  const timer = setTimeout(() => {
    responsive = true;
  }, 20);
  await assert.rejects(session.collect(), { code: "ERR_SEARCH_TIMEOUT" });
  clearTimeout(timer);
  assert.equal(responsive, true);
});

test("replacement templates retain capture and full-source prefix/suffix semantics", async () => {
  const source = "left abab middle ab right";
  const snapshot = new PieceTree(source);
  const regex = /(?<a>a)(b)/g;
  for (const replacement of ["$<a>-$2-$$-$&", "$`", "$'", "$01/$10/$99"]) {
    const result = await buildReplacement(
      snapshot,
      [new DocumentSearch(snapshot, regex)],
      replacement,
    );
    assert.equal(result.snapshot.toString(), source.replace(regex, replacement));
  }
});

test("atomic replacement preserves exact marker geometry and invalidation plus undo/redo", async () => {
  const before = "one gap\none gap one end";
  const actual = new TextBuffer(before),
    reference = new TextBuffer(before);
  const pairs = [];
  try {
    for (let i = 0; i < before.length; i++) {
      for (const options of [
        { invalidate: "inside" },
        { invalidate: "overlap" },
        { invalidate: "never", exclusive: true },
        { invalidate: "touch" },
      ]) {
        const range = [
          actual.positionForCharacterIndex(i),
          actual.positionForCharacterIndex(Math.min(i + 2, before.length)),
        ];
        pairs.push([actual.markRange(range, options), reference.markRange(range, options)]);
      }
    }
    const originalRanges = pairs.map(([marker]) => marker.getRange());
    assert.equal(await actual.replaceAllMatches(/one/g, "OTHER\n"), 3);
    reference.replace(/one/g, "OTHER\n");
    assert.equal(actual.getText(), reference.getText());
    for (const [a, b] of pairs) {
      assert.deepEqual(a.getRange(), b.getRange());
      assert.equal(a.isValid(), b.isValid());
    }
    actual.undo();
    assert.equal(actual.getText(), before);
    pairs.forEach(([marker], i) => assert.deepEqual(marker.getRange(), originalRanges[i]));
    actual.redo();
    for (const [a, b] of pairs) {
      assert.deepEqual(a.getRange(), b.getRange());
      assert.equal(a.isValid(), b.isValid());
    }
  } finally {
    actual.destroy();
    reference.destroy();
  }
});

test("replacement cancellation, changed selections and custom trackers do not mutate text", async () => {
  const buffer = new TextBuffer("one ".repeat(10000));
  try {
    const before = buffer.getText();
    const marker = buffer.markPosition([0, 0]);
    const controller = new AbortController();
    const pending = buffer.replaceAllMatches(/one/g, "two", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(buffer.getText(), before);
    const moved = buffer.replaceAllMatches(/one/g, "two");
    marker.setHeadPosition([0, 4]);
    await assert.rejects(moved, { code: "ERR_STALE_EDIT" });
    assert.equal(buffer.getText(), before);
    buffer.addMarkerLayer({ trackRanges: () => [] }).markPosition([0, 0]);
    await assert.rejects(buffer.replaceAllMatches(/one/g, "two"), {
      code: "ERR_REPLACE_RANGE_TRACKER",
    });
    assert.equal(buffer.getText(), before);
  } finally {
    buffer.destroy();
  }
});

test("a replacement beyond the string limit commits and replays without flattening events or history", async () => {
  let snapshot = new PieceTree("x".repeat(32768));
  for (let i = 0; i < 14; i++)
    snapshot = snapshot.replace(snapshot.length, snapshot.length, snapshot);
  snapshot = snapshot.replace(snapshot.length - 6, snapshot.length, "needle");
  const buffer = new TextBuffer({ text: snapshot });
  let applied;
  let committedEvent;
  buffer.onDidApplyChanges((event) => {
    applied = event;
  });
  buffer.onDidChangeText((event) => {
    assert.equal(event.changes.length, 1);
    committedEvent ??= event;
    assert.equal(Object.keys(event).includes("newTextSource"), false);
    assert.equal(event.newTextSource.length, buffer.getTextSnapshot().length);
  });
  try {
    const marker = buffer.markRange(
      [
        [0, 12],
        [0, 18],
      ],
      { invalidate: "never" },
    );
    assert.equal(await buffer.replaceAllMatches(/needle/g, "found"), 1);
    assert.equal(buffer.getTextSnapshot().length, snapshot.length - 1);
    assert.equal(buffer.getTextSnapshot().slice(-5), "found");
    assert(
      applied.changes[0].oldTextSource.length > require("node:buffer").constants.MAX_STRING_LENGTH,
    );
    assert.deepEqual(marker.getRange().serialize(), [
      [0, 12],
      [0, 18],
    ]);
    buffer.undo();
    assert(buffer.getTextSnapshot().equals(snapshot));
    assert.equal(committedEvent.newTextSource.slice(-5), "found");
    assert(committedEvent.oldTextSource.equals(snapshot));
    buffer.redo();
    assert.equal(buffer.getTextSnapshot().slice(-5), "found");
  } finally {
    buffer.destroy();
  }
});

test("bounded ambiguous quantifiers run in the worker too", async () => {
  const session = new DocumentSearch(new PieceTree("a".repeat(24)), /(?:a?){25}a{25}/g);
  assert.equal(session.width, null);
  const controller = new AbortController();
  session.signal = controller.signal;
  const pending = session.collect();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("replacement marker mapping retains CRLF creation/deletion boundary semantics", async () => {
  for (const source of ["a\nb\nc", "a\rX\nb", "a\r\nb"]) {
    for (const replacement of ["\r", "\n", ""]) {
      const actual = new TextBuffer(source),
        reference = new TextBuffer(source);
      try {
        const pairs = [];
        for (let i = 0; i <= source.length; i++) {
          const point = actual.positionForCharacterIndex(i);
          pairs.push([
            actual.markPosition(point, { invalidate: "never" }),
            reference.markPosition(point, { invalidate: "never" }),
          ]);
        }
        await actual.replaceAllMatches(/./gu, replacement);
        reference.replace(/./gu, replacement);
        assert.equal(actual.getText(), reference.getText());
        for (const [a, b] of pairs) assert.deepEqual(a.getRange(), b.getRange());
      } finally {
        actual.destroy();
        reference.destroy();
      }
    }
  }
});

test("forward scan stops before allocating the rest of a dense result set", () => {
  const buffer = new TextBuffer("x".repeat(200000));
  try {
    buffer.findAllInRangeSync = () => {
      throw new Error("eager result collection");
    };
    let count = 0;
    buffer.scan(/x/g, ({ stop }) => {
      count++;
      stop();
    });
    assert.equal(count, 1);
  } finally {
    buffer.destroy();
  }
});

test("a failing postcommit subscriber cannot leave replaced text clean or skip marker/deferred updates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-search-observer-"));
  const file = path.join(directory, "document.txt");
  fs.writeFileSync(file, "one gap one");
  const disposable = () => ({ dispose() {} });
  const buffer = await TextBuffer.load(file, {
    fileWatchClient: {
      watchFile: () => ({
        ready: Promise.resolve(),
        dispose() {},
        onDidChange: disposable,
        onDidInvalidate: disposable,
        onDidError: disposable,
      }),
    },
  });
  await buffer.getFileWatchStartPromise();
  let markerEvents = 0,
    deferred = 0;
  const marker = buffer.markRange(
    [
      [0, 4],
      [0, 7],
    ],
    { invalidate: "never" },
  );
  marker.onDidChange(() => markerEvents++);
  const display = buffer.addDisplayLayer({ softWrapColumn: Infinity });
  const originalDeferred = display.emitDeferredChangeEvents.bind(display);
  display.emitDeferredChangeEvents = () => {
    deferred++;
    return originalDeferred();
  };
  const subscription = buffer.onDidChangeText(() => {
    throw new Error("adversarial subscriber");
  });
  try {
    assert.equal(buffer.getFileState(), "unmodified");
    await assert.rejects(buffer.replaceAllMatches(/one/g, "longer"), {
      code: "ERR_REPLACE_OBSERVER_FAILED",
      committed: true,
      replacementCount: 2,
    });
    assert.equal(buffer.getText(), "longer gap longer");
    assert.equal(buffer.getFileState(), "modified");
    assert.deepEqual(marker.getRange().serialize(), [
      [0, 7],
      [0, 10],
    ]);
    assert(markerEvents > 0);
    assert(deferred > 0);
    subscription.dispose();
    buffer.undo();
    assert.equal(buffer.getText(), "one gap one");
    assert.equal(buffer.getFileState(), "unmodified");
    assert.deepEqual(marker.getRange().serialize(), [
      [0, 4],
      [0, 7],
    ]);
  } finally {
    subscription.dispose();
    buffer.destroy();
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test("line-ending conversion crosses windows and the string limit without touching lone CR or Unicode", async () => {
  let snapshot = new PieceTree("x".repeat(32768));
  for (let i = 0; i < 14; i++)
    snapshot = snapshot.replace(snapshot.length, snapshot.length, snapshot);
  snapshot = snapshot.replace(65533, 65535, "😀");
  snapshot = snapshot.replace(65535, 65535, "\r\n");
  snapshot = snapshot.replace(100, 100, "\r");
  snapshot = snapshot.replace(snapshot.length, snapshot.length, "\n");
  for (const regex of [/\r?\n/gu, /\r\n|\n/gu]) {
    const session = new DocumentSearch(snapshot, regex);
    assert.equal(session.width, 2);
    const result = await buildReplacement(snapshot, [session], "\n", { literalReplacement: true });
    assert.equal(result.count, 2);
    assert.equal(result.snapshot.length, snapshot.length - 1);
    assert.equal(result.snapshot.slice(100, 102), "\rx");
    assert.equal(result.snapshot.slice(65534, 65537), "😀\n");
    assert.equal(result.snapshot.slice(-1), "\n");
  }
});

test("cancelling a viewport scan does not cancel the query's independent count", async () => {
  let snapshot = new PieceTree("x".repeat(32768));
  for (let i = 0; i < 13; i++)
    snapshot = snapshot.replace(snapshot.length, snapshot.length, snapshot);
  const queryController = new AbortController(),
    viewportController = new AbortController();
  const session = new DocumentSearch(snapshot, /missing/g, null, {
    signal: queryController.signal,
  });
  const viewport = session.withSignal(viewportController.signal).findNear(0);
  const count = session.collect({ limit: 0 });
  setTimeout(() => viewportController.abort(), 5);
  await assert.rejects(viewport, { name: "AbortError" });
  assert.equal(queryController.signal.aborted, false);
  assert.equal((await count).count, 0);
});

test("scoped regexp modifiers never bypass the multiline proof", async () => {
  const source = "a\n" + "x\n".repeat(20) + "b\n";
  const snapshot = new PieceTree(source);
  for (const pattern of ["(?s:a.*b)", "(?s:(?=a.*b)a)", "(?s:a(?-s:.)*.*b)"]) {
    const regex = new RegExp(pattern, "g");
    const session = new DocumentSearch(snapshot, regex, null, {
      windowUnits: 8,
      nativeLimit: 1000,
    });
    assert.equal(session.lineLocal, false);
    assert.deepEqual(
      Array.from(session.scan())
        .filter(Boolean)
        .map(({ start, end, match }) => [start, end, Array.from(match)]),
      expected(source, regex),
    );
    assert.equal((await session.collect({ limit: 0 })).count, expected(source, regex).length);
    assert.throws(() => new DocumentSearch(snapshot, regex, null, { nativeLimit: 8 }), {
      code: "ERR_SEARCH_INPUT_TOO_LARGE",
    });
  }
});

test("will-change marker edits cannot be overwritten by a stale replacement plan", async () => {
  const buffer = new TextBuffer("one gap one");
  try {
    const marker = buffer.markRange(
      [
        [0, 4],
        [0, 7],
      ],
      { invalidate: "never" },
    );
    buffer.onWillChange(() =>
      marker.setRange([
        [0, 0],
        [0, 3],
      ]),
    );
    await assert.rejects(buffer.replaceAllMatches(/one/g, "longer"), { code: "ERR_STALE_EDIT" });
    assert.equal(buffer.getText(), "one gap one");
    assert.equal(buffer.getHistory().undoStack.length, 0);
  } finally {
    buffer.destroy();
  }
});

test("scoped multiline modifiers preserve document anchors instead of silently rewriting them", async () => {
  const source = "a\nb\na";
  for (const pattern of ["(?-m:^b)", "(?-m:a$)", "(?m:^b)", "(?m:^a)|(?-m:^b)", "(?-m:^a$)"]) {
    const regex = new RegExp(pattern, "g");
    const native = Array.from(source.matchAll(regex), (match) => [
      match.index,
      match.index + match[0].length,
    ]);
    const session = new DocumentSearch(new PieceTree(source), regex);
    const actual = [];
    for await (const match of session.matches()) actual.push([match.start, match.end]);
    assert.deepEqual(actual, native, pattern);
  }
  const snapshot = new PieceTree("prefix a tail");
  const clipped = new DocumentSearch(snapshot, /(?-m:a$)/g, { start: 7, end: 8 });
  assert.equal((await clipped.collect()).count, 0);
});

test("coarse setTextViaDiff keeps shared text sources instead of retrying a full line diff", (t) => {
  const before = new PieceTree("a".repeat(2 * 1024 * 1024));
  const after = new PieceTree("b".repeat(2 * 1024 * 1024));
  const buffer = new TextBuffer({ text: before });
  const original = PieceTree.prototype.toString;
  t.mock.method(PieceTree.prototype, "toString", function () {
    if (this.length > 1024 * 1024) throw new Error("unexpected full-string materialization");
    return original.call(this);
  });
  try {
    buffer.setTextViaDiff(after);
    assert(buffer.getTextSnapshot().equals(after));
    buffer.undo();
    assert(buffer.getTextSnapshot().equals(before));
    buffer.redo();
    assert(buffer.getTextSnapshot().equals(after));
  } finally {
    buffer.destroy();
  }
});

test("coarse reload retains source-backed events and finalizes committed state after a subscriber error", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-search-reload-"));
  const file = path.join(directory, "document.txt");
  const before = "a".repeat(2 * 1024 * 1024),
    after = "b".repeat(2 * 1024 * 1024);
  fs.writeFileSync(file, before);
  const disposable = () => ({ dispose() {} });
  const buffer = await TextBuffer.load(file, {
    fileWatchClient: {
      watchFile: () => ({
        ready: Promise.resolve(),
        dispose() {},
        onDidChange: disposable,
        onDidInvalidate: disposable,
        onDidError: disposable,
      }),
    },
  });
  await buffer.getFileWatchStartPromise();
  const layer = buffer.addMarkerLayer({ maintainHistory: true });
  const marker = layer.markRange([
    [0, 16],
    [0, 20],
  ]);
  let reloaded = false,
    applied;
  buffer.onDidReload(() => {
    reloaded = true;
  });
  buffer.onDidApplyChanges((event) => {
    applied = event;
  });
  const failure = buffer.onDidChangeText(() => {
    throw new Error("reload subscriber");
  });
  const original = PieceTree.prototype.toString;
  t.mock.method(PieceTree.prototype, "toString", function () {
    if (this.length > 1024 * 1024) throw new Error("unexpected full-string materialization");
    return original.call(this);
  });
  try {
    fs.writeFileSync(file, after);
    await assert.rejects(buffer.load({ discardChanges: true }), /reload subscriber/);
    assert.equal(buffer.getTextSnapshot().slice(0, 1), "b");
    assert.equal(buffer.getFileState(), "unmodified");
    assert.equal(reloaded, true);
    assert.equal(applied.changes[0].newTextSource.length, after.length);
    assert.equal(applied.changes[0].oldTextSource.length, before.length);
    failure.dispose();
    buffer.undo();
    assert.equal(buffer.getTextSnapshot().slice(0, 1), "a");
    assert.equal(buffer.getFileState(), "modified");
    assert.deepEqual(marker.getRange().serialize(), [
      [0, 16],
      [0, 20],
    ]);
  } finally {
    failure.dispose();
    buffer.destroy();
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test("equal-width marker gap skipping agrees with scalar replacement for endpoint bias and invalidation", async () => {
  const source = "000000 000000\r\n000000 000000";
  const actual = new TextBuffer(source),
    reference = new TextBuffer(source);
  const pairs = [];
  try {
    for (const destroyInvalidatedMarkers of [false, true]) {
      const aLayer = actual.addMarkerLayer({ destroyInvalidatedMarkers });
      const bLayer = reference.addMarkerLayer({ destroyInvalidatedMarkers });
      for (let i = 0; i <= source.length; i++)
        for (const invalidate of ["never", "inside", "touch", "overlap", "surround"])
          for (const exclusive of [false, true]) {
            const range = [
              actual.positionForCharacterIndex(i),
              actual.positionForCharacterIndex(Math.min(source.length, i + (i % 4))),
            ];
            pairs.push([
              aLayer.markRange(range, { invalidate, exclusive }),
              bLayer.markRange(range, { invalidate, exclusive }),
            ]);
          }
    }
    await actual.replaceAllMatches(/0/g, "1", { literalReplacement: true });
    for (let index = source.indexOf("0"); index >= 0; index = source.indexOf("0", index + 1))
      reference.setTextInRange(
        [
          reference.positionForCharacterIndex(index),
          reference.positionForCharacterIndex(index + 1),
        ],
        "1",
        { normalizeLineEndings: false },
      );
    assert.equal(actual.getText(), reference.getText());
    for (const [a, b] of pairs) {
      assert.equal(a.isDestroyed(), b.isDestroyed());
      if (!a.isDestroyed()) {
        assert.deepEqual(a.getRange(), b.getRange());
        assert.equal(a.isValid(), b.isValid());
      }
    }
  } finally {
    actual.destroy();
    reference.destroy();
  }
});

test("installing a custom range tracker during preparation rejects a stale marker plan", async () => {
  const buffer = new TextBuffer("xx");
  try {
    const layer = buffer.addMarkerLayer();
    layer.markRange(
      [
        [0, 1],
        [0, 2],
      ],
      { invalidate: "never" },
    );
    const replacement = buffer.replaceAllMatches(/x/g, "yyy");
    layer.setRangeTracker(() => []);
    await assert.rejects(replacement, { code: "ERR_STALE_EDIT" });
    assert.equal(buffer.getText(), "xx");
  } finally {
    buffer.destroy();
  }
});

test("navigation before counting seeks dense borderless literals locally and resolves exact ordinals later", async () => {
  const session = new DocumentSearch(new PieceTree("0".repeat(500000)), /0/gi);
  let minimumResume = Infinity;
  const original = session.batches;
  session.batches = function (resume) {
    minimumResume = Math.min(minimumResume, resume);
    return original.call(this, resume);
  };
  const next = await session.findNear(450000);
  const previous = await session.findNear(450000, { backwards: true });
  assert.equal(next.start, 450001);
  assert.equal(previous.start, 449998);
  assert.equal(next.index, -1);
  assert.equal(previous.index, -1);
  assert(minimumResume >= 450000);
  delete session.batches;
  await session.collect({ limit: 0 });
  assert.equal((await session.findNear(450000)).index, 450001);
  assert.equal((await session.findNear(450000, { backwards: true })).index, 449998);
});

test("navigation preserves self-overlap phase and sparse window checkpoints", async () => {
  const overlap = new DocumentSearch(new PieceTree("a".repeat(300001)), /aa/g);
  assert.equal(overlap.localLiteral, false);
  assert.equal((await overlap.findNear(250001, { inclusive: true })).start, 250002);
  const source = " ".repeat(200000) + "needle" + " ".repeat(200000) + "needle";
  const sparse = new DocumentSearch(new PieceTree(source), /needle/g);
  await sparse.collect({ limit: 0 });
  assert.equal(sparse.count, 2);
  assert(sparse.checkpoints.length > 2);
  assert.equal((await sparse.findNear(390000)).index, 1);
  assert.equal((await sparse.findNear(390000, { backwards: true })).index, 0);
});

test("a clipped range before the last EOF character is not a line-end anchor", () => {
  const source = new PieceTree("word .");
  const clipped = new DocumentSearch(source, / +$/g, { start: 0, end: 5 });
  assert.deepEqual(Array.from(clipped.scan()).filter(Boolean), []);
  for (const text of ["word ", "word \nnext", "word \r\nnext"]) {
    const search = new DocumentSearch(new PieceTree(text), / +$/g, { start: 0, end: 5 });
    assert.deepEqual(
      Array.from(search.scan())
        .filter(Boolean)
        .map((match) => [match.start, match.end]),
      [[4, 5]],
    );
  }
});
