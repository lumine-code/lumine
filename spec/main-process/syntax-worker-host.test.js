const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const TextBuffer = require("../../src/text-buffer");
const { serialize } = require("../../src/syntax-analysis-context");
const processor = path.resolve(__dirname, "../fixtures/syntax-worker-analysis.js");

test("color tiles publish before fold queries and folds do not require another acknowledgement", async () => {
  const { host, data } = await setup("function example() {\n  work();\n}\n");
  try {
    await host.dispatch("settle", data);
    const mode = host.sessions.get(data.session).mode;
    mode.queryBudget = { now: () => 0 };
    const fold = mode.getFoldRangeForRow.bind(mode);
    let colorSent = false,
      foldCalls = 0,
      acknowledge;
    mode.getFoldRangeForRow = (...args) => {
      assert.equal(colorSent, true);
      foldCalls++;
      return fold(...args);
    };
    const events = [];
    host.notify = (event) => events.push(event);
    const pending = host.dispatch(
      "view",
      {
        ...data,
        ranges: [[0, 2]],
        stream: true,
        presentation: 7,
      },
      {
        emit(packet) {
          if (packet.kind !== "end") return;
          assert.equal(foldCalls, 0);
          assert.deepEqual(packet.folds, []);
          colorSent = true;
          return new Promise((resolve) => (acknowledge = resolve));
        },
      },
    );
    await new Promise(setImmediate);
    assert.equal(colorSent, true);
    assert.equal(foldCalls, 3);
    const update = events.find((event) => event.event === "paint-folds");
    assert.equal(update.presentation, 7);
    assert.equal(update.revision, data.revision);
    assert.equal(update.generation, host.sessions.get(data.session).generation);
    assert.ok(update.folds.some(([, range]) => range));
    acknowledge();
    await pending;
  } finally {
    host.close();
  }
});

test("package unload evicts syntax helpers reached through a development link", () => {
  const fs = require("node:fs"),
    os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "syntax-module-generation-"));
  const source = path.join(directory, "source"),
    linked = path.join(directory, "linked");
  const entry = path.join(source, "analysis.cjs"),
    dependency = path.join(source, "node_modules/dep.cjs");
  const host = new Host();
  try {
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "module.exports = {};\n");
    fs.writeFileSync(
      entry,
      "module.exports = {value: 1, dependency: require('./node_modules/dep.cjs')};\n",
    );
    fs.symlinkSync(source, linked, process.platform === "win32" ? "junction" : "dir");
    const before = require(path.join(linked, "analysis.cjs"));
    fs.writeFileSync(
      entry,
      "module.exports = {value: 2, dependency: require('./node_modules/dep.cjs')};\n",
    );
    host.clearPackageModules(linked);
    const after = require(path.join(linked, "analysis.cjs"));
    assert.equal(after.value, 2);
    assert.notEqual(after, before);
    assert.equal(after.dependency, before.dependency);
  } finally {
    host.close();
    delete require.cache[entry];
    delete require.cache[dependency];
    const linkedStat = fs.lstatSync(linked, { throwIfNoEntry: false });
    if (linkedStat) {
      assert.equal(linkedStat.isSymbolicLink(), true);
      assert.equal(fs.realpathSync(linked), fs.realpathSync(source));
      fs.unlinkSync(linked);
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("large fold and indentation replies stream bounded packets and stop on invalidation", async () => {
  const { host, data } = await setup("function example() {\n  work();\n}\n".repeat(300));
  try {
    await host.dispatch("settle", data);
    // Keep transport invariants independent of a loaded CI runner's clock.
    host.sessions.get(data.session).mode.queryBudget = { now: () => 0 };
    for (const [method, args, kind] of [
      ["getFoldableRanges", [2], "array"],
      ["suggestedIndentForBufferRows", [0, 899, 2], "map"],
    ]) {
      const packets = [];
      const reply = await host.dispatch(
        "builtin",
        { ...data, method, args, stream: true },
        {
          emit: async (packet) => packets.push(packet),
        },
      );
      assert.equal(reply.value.stream, kind);
      assert.ok(packets.length > 1);
      assert.ok(packets.every((packet) => packet.kind === kind && packet.values.length <= 256));
      assert.equal(
        packets.reduce((count, packet) => count + packet.values.length, 0),
        reply.value.count,
      );
    }
    let packets = 0;
    await assert.rejects(
      host.dispatch(
        "builtin",
        { ...data, method: "getFoldableRanges", args: [2], stream: true },
        {
          emit: async () => {
            packets++;
            await host.dispatch("path", { session: 1, path: "changed.js" });
          },
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(packets, 1);
  } finally {
    host.close();
  }
});

test("multipart edits remain invisible until commit and closing releases waiting analyses", async () => {
  const { host, data } = await setup();
  try {
    await host.dispatch("settle", data);
    await host.dispatch("edit-begin", { session: 1, beforeRevision: 0, revision: 1, count: 1 });
    let published = false;
    const result = host
      .dispatch("analyze", { ...data, revision: 1, module: processor, method: "summary" })
      .then((value) => {
        published = true;
        return value;
      });
    await host.dispatch("edit-text-begin", {
      session: 1,
      startIndex: 0,
      oldEndIndex: 5,
      length: 3,
    });
    await host.dispatch("edit-text-chunk", { session: 1, text: "l" });
    await host.dispatch("edit-text-chunk", { session: 1, text: "et" });
    await host.dispatch("edit-text-end", { session: 1 });
    assert.equal(host.sessions.get(1).buffer.getText(), "const value = 3;\r\n");
    assert.equal(published, false);
    await host.dispatch("edit-commit", { session: 1 });
    assert.equal((await result).value.type, "let");
    await host.dispatch("edit-begin", { session: 1, beforeRevision: 1, revision: 2, count: 1 });
    const waiting = host.dispatch("settle", { ...data, revision: 2 });
    host.closeSession(1);
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(host.sessions.size, 0);
  } finally {
    host.close();
  }
});

test("dense highlighting is transferred in bounded packets and obsolete streams stop", async () => {
  const { host, data } = await setup("const value = 1;".repeat(300));
  try {
    await host.dispatch("settle", data);
    // This checks packet cardinality and invalidation, not machine speed.
    // Query deadline behavior has its own deterministic clock-driven tests.
    host.sessions.get(data.session).mode.queryBudget = { now: () => 0 };
    let packets = 0,
      events = 0;
    const qualities = [];
    await host.dispatch(
      "view",
      { ...data, ranges: [[0, 0]], stream: true },
      {
        emit: async (packet) => {
          packets++;
          if (packet.start) qualities.push({ quality: packet.quality, reason: packet.reason });
          if (packet.events) {
            assert.ok(packet.events.length <= 4096);
            events += packet.events.length;
          }
        },
      },
    );
    assert.ok(packets >= 1);
    assert.ok(events > 512, JSON.stringify({ events, qualities }));
    let invalidated = false;
    await assert.rejects(
      host.dispatch(
        "view",
        { ...data, ranges: [[0, 0]], stream: true },
        {
          emit: async () => {
            if (!invalidated) {
              invalidated = true;
              await host.dispatch("edit", {
                session: data.session,
                beforeRevision: 0,
                revision: 1,
                changes: [{ startIndex: 0, oldEndIndex: 0, text: "// changed\n" }],
              });
            }
          },
        },
      ),
      { name: "AbortError" },
    );
  } finally {
    host.close();
  }
});

test("paint packets split dense tiles and follow the acknowledged viewport", async () => {
  const { Point } = TextBuffer;
  const host = new Host();
  host.metadata = () => ({});
  const starts = [],
    packets = [];
  const session = {
    buffer: new TextBuffer({ text: Array(4).fill("x".repeat(10001)).join("\n") }),
    mode: {
      scopeNameForScopeId: () => "source.test",
      getFoldRangeForRow: () => null,
      buildHighlightIterator() {
        let row,
          index = 0;
        return {
          seek(start) {
            row = start.row;
            starts.push(row);
            return [1];
          },
          getPosition: () => (index < 10000 ? new Point(row, index + 1) : Point.INFINITY),
          getOpenScopeIds: () => (index % 2 ? [] : [2]),
          getCloseScopeIds: () => (index % 2 ? [2] : []),
          moveToSuccessor() {
            index++;
          },
        };
      },
    },
  };
  try {
    await host.view(
      session,
      [[0, 0]],
      async (packet) => {
        packets.push(packet);
        if (packet.kind === "end" && starts.length === 1) return { range: [3, 3] };
      },
      () => {},
      true,
    );
    assert.deepEqual(starts, [0, 3]);
    assert.deepEqual(
      packets.map((packet) => packet.events.length),
      [4096, 4096, 1808, 4096, 4096, 1808],
    );
    assert.equal(packets.filter((packet) => packet.start).length, 2);
    assert.equal(packets.filter((packet) => packet.kind === "end").length, 2);
  } finally {
    session.buffer.destroy();
    host.close();
  }
});

test("indentation iterators preserve virtual indentation across acknowledged worker packets", async () => {
  const { host, data } = await setup(
    "function example() {\nif (ready) {\nwork();\n}\n}\n".repeat(60),
  );
  try {
    await host.dispatch("settle", data);
    const session = host.sessions.get(data.session);
    session.mode.queryBudget = { now: () => 0 };
    const expected = session.mode.suggestedIndentForBufferRows(0, 299, 2);
    const packets = [];
    const reply = await host.dispatch(
      "indent",
      { ...data, ranges: [[0, 299]], tabLength: 2, options: { batchSize: 7 } },
      { emit: async (packet) => packets.push(packet) },
    );
    assert.equal(reply.value.count, 300);
    assert.ok(packets.length > 1);
    assert.ok(packets.every((packet) => packet.length <= 7));
    assert.deepEqual(new Map(packets.flat()), expected);

    let received = 0;
    await assert.rejects(
      host.dispatch(
        "indent",
        { ...data, ranges: [[0, 299]], tabLength: 2, options: { batchSize: 7 } },
        {
          emit: async () => {
            received++;
            await host.dispatch("edit", {
              session: data.session,
              beforeRevision: 0,
              revision: 1,
              changes: [{ startIndex: 0, oldEndIndex: session.buffer.getLength(), text: "" }],
            });
          },
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(received, 1);
    assert.equal(session.jobs.size, 0);
  } finally {
    host.close();
  }
});

test("provisional view packets remain separate from exact semantics and yield to exact settlement", async () => {
  const { host, data } = await setup("const value = 3;\n".repeat(20));
  try {
    await host.dispatch("settle", data);
    const session = host.sessions.get(data.session);
    const mode = session.mode;
    mode.queryBudget = { now: () => 0 };
    const createPreview = host.previews.createMode;
    host.previews.createMode = (options) =>
      createPreview({
        ...options,
        queryBudget: { ...options.queryBudget, now: () => 0 },
      });
    let settle;
    const settlement = new Promise((resolve) => {
      settle = resolve;
    });
    mode.atGrammarSettlement = () => settlement;
    mode.publicationPending = true;
    const packets = [];
    const result = await host.dispatch(
      "view",
      { ...data, ranges: [[0, 3]], stream: true, allowPreview: true },
      { emit: async (packet) => packets.push(packet) },
    );
    assert.equal(result.syntaxReady, false);
    assert.ok(packets.some((packet) => packet.quality === "provisional"));
    assert.ok(packets.every((packet) => !packet.folds?.length));
    assert.equal(mode.publicationPending, true);

    let semanticFinished = false;
    const semantic = host.dispatch("analyze", { ...data, module: processor, method: "summary" });
    void semantic.then(() => {
      semanticFinished = true;
    });
    await new Promise(setImmediate);
    assert.equal(semanticFinished, false);

    const takeover = [];
    const current = await host.dispatch(
      "view",
      { ...data, ranges: [[0, 3]], stream: true, allowPreview: true },
      {
        emit: async (packet) => {
          takeover.push(packet);
          if (packet.quality === "provisional") {
            mode.publicationPending = false;
            settle({});
          }
        },
      },
    );
    assert.equal(current.syntaxReady, true);
    assert.ok(takeover.some((packet) => packet.quality === "exact"));
    assert.equal((await semantic).value.type, "const");
    assert.equal(host.sessions.get(data.session), session);
  } finally {
    host.close();
  }
});

test("session invalidation releases indentation waiting for an unacknowledged packet", async () => {
  const { host, data } = await setup("function work() {\nvalue();\n}\n");
  let delivered;
  const firstPacket = new Promise((resolve) => {
    delivered = resolve;
  });
  try {
    await host.dispatch("settle", data);
    const session = host.sessions.get(data.session);
    session.mode.queryBudget = { now: () => 0 };
    const pending = host.dispatch(
      "indent",
      { ...data, ranges: [[0, 2]], tabLength: 2, options: { batchSize: 1 } },
      {
        emit: () => {
          delivered();
          return new Promise(() => {});
        },
      },
    );
    const rejection = assert.rejects(pending, { name: "AbortError" });
    await firstPacket;
    host.abortJobs(session);
    await rejection;
    assert.equal(session.jobs.size, 0);
    assert.equal(session.mode.indentResolver.lastIndentationScanStats.processedRows, 1);
  } finally {
    host.close();
  }
});

test("background update failures notify the owner once without console errors or a waiting request", async (t) => {
  const { QueryBudgetExceeded } = require("../../src/tree-sitter-query-budget");
  const { host, data } = await setup();
  const failures = [];
  host.notify = (event) => {
    if (event.event === "failure") failures.push(event);
  };
  const logged = t.mock.method(console, "error", () => {});
  try {
    await host.dispatch("settle", data);
    const mode = host.sessions.get(data.session).mode;
    const error = new QueryBudgetExceeded("predicate-text-limit");
    mode.finishTransactionUpdate(error);
    mode.finishTransactionUpdate(error);
    await new Promise(setImmediate);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].failure.code, "query-budget");
    assert.equal(failures[0].failure.reason, "predicate-text-limit");
    assert.equal(failures[0].failure.fatal, false);
    assert.equal(host.sessions.size, 0);
    assert.equal(logged.mock.callCount(), 0);
  } finally {
    host.close();
  }
});

test("a newer revision supersedes a queued update failure", async (t) => {
  const { host, data } = await setup();
  const failures = [];
  host.notify = (event) => {
    if (event.event === "failure") failures.push(event);
  };
  const logged = t.mock.method(console, "error", () => {});
  try {
    await host.dispatch("settle", data);
    const session = host.sessions.get(data.session);
    session.mode.finishTransactionUpdate(new Error("obsolete update"));
    session.buffer.append("// newer\n");
    await new Promise(setImmediate);
    assert.equal(failures.length, 0);
    assert.equal(host.sessions.get(data.session), session);
    assert.equal(logged.mock.callCount(), 0);
  } finally {
    host.close();
  }
});

async function setup(text = "const value = 3;\r\n") {
  const host = new Host();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const file = require.resolve("language-javascript/grammars/javascript.json");
  const definition = require("@lumine-code/season").readFileSync(file);
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars: [{ file, definition }],
    modules: [],
    specMode: true,
  });
  const data = { session: 1, revision: 0, scopeName: definition.scopeName, path: "example.js" };
  await host.dispatch("open", data);
  // Exercise a chunk boundary inside CRLF and a surrogate pair.
  for (const chunk of text.split("")) await host.dispatch("append", { session: 1, text: chunk });
  await host.dispatch("initialize", data);
  return { host, data };
}

test("the parser owner mirrors edits and returns data without exporting syntax nodes", async () => {
  const { host, data } = await setup('const value = "🦉";\r\n');
  try {
    await host.dispatch("settle", data);
    const summary = await host.dispatch("analyze", {
      ...data,
      module: processor,
      method: "summary",
    });
    assert.equal(summary.value.text, 'const value = "🦉";\r\n');
    assert.equal(summary.revision, 0);
    await host.dispatch("path", { session: data.session, path: "renamed.js" });
    const renamed = await host.dispatch("analyze", {
      ...data,
      module: processor,
      method: "summary",
    });
    assert.equal(renamed.value.path, "renamed.js");
    await assert.rejects(
      host.dispatch("analyze", { ...data, module: processor, method: "illegalNode" }),
      /cannot return syntax nodes/,
    );
    await host.dispatch("edit", {
      session: 1,
      beforeRevision: 0,
      revision: 1,
      changes: [
        {
          range: [
            [0, 6],
            [0, 11],
          ],
          text: "changed",
        },
      ],
    });
    const changed = await host.dispatch("analyze", {
      ...data,
      revision: 1,
      module: processor,
      method: "summary",
    });
    assert.equal(changed.value.text, 'const changed = "🦉";\r\n');
    await assert.rejects(host.dispatch("settle", data), { name: "AbortError" });
    await host.dispatch("close", data);
    await assert.rejects(host.dispatch("settle", { ...data, revision: 1 }), { name: "AbortError" });
  } finally {
    host.close();
  }
});

test("an edit cancels in-flight analyses before they can publish an older revision", async () => {
  const { host, data } = await setup();
  try {
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const analysis = host.dispatch(
      "analyze",
      { ...data, module: processor, method: "waitForCancellation" },
      { emit: async () => started() },
    );
    const rejection = assert.rejects(analysis, { name: "AbortError" });
    await ready;
    await host.dispatch("edit", {
      session: 1,
      beforeRevision: 0,
      revision: 1,
      changes: [
        {
          range: [
            [0, 0],
            [0, 0],
          ],
          text: "// ",
        },
      ],
    });
    await rejection;
    assert.equal(host.sessions.get(1).jobs.size, 0);
  } finally {
    host.close();
  }
});

test("applied TextBuffer batches, undo and redo replay exactly in the parser owner", async () => {
  const text = "first\r\nsecond 🦉\r\nthird\r\n".repeat(80);
  const buffer = new TextBuffer({ text });
  const { host } = await setup(text);
  let revision = 0;
  const batches = [];
  const subscription = buffer.onDidApplyChanges((batch) => batches.push(batch));
  try {
    buffer.setTextInIndependentRanges([
      {
        range: [
          [0, 0],
          [0, 5],
        ],
        text: "longer\nnew row",
      },
      {
        range: [
          [20, 1],
          [21, 2],
        ],
        text: "X🦉",
      },
      {
        range: [
          [180, 0],
          [181, 0],
        ],
        text: "",
      },
    ]);
    buffer.undo();
    buffer.redo();
    for (const batch of batches) {
      await host.dispatch("edit", {
        session: 1,
        beforeRevision: revision,
        revision: ++revision,
        changes: batch.changes.map((change) => ({
          range: change.oldRange.serialize(),
          startIndex: change.startIndex,
          oldEndIndex: change.oldEndIndex,
          text: change.inserted?.toString() ?? change.newText,
        })),
      });
    }
    await host.dispatch("settle", { session: 1, revision });
    assert.equal(host.sessions.get(1).buffer.getText(), buffer.getText());
  } finally {
    subscription.dispose();
    buffer.destroy();
    host.close();
  }
});

test("syntax results retain coordinate types as data and reject functions", () => {
  const { Point, Range } = TextBuffer;
  assert.deepEqual(
    serialize(new Map([[2, new Range([1, 2], [3, 4])]])),
    new Map([[2, { start: { row: 1, column: 2 }, end: { row: 3, column: 4 } }]]),
  );
  assert.deepEqual(serialize(new Point(3, 5)), { row: 3, column: 5 });
  assert.throws(() => serialize({ callback() {} }), /must return data/);
});

test("configuration updates invalidate analyses without reconstructing the syntax tree", async () => {
  const { host, data } = await setup();
  try {
    await host.dispatch("settle", data);
    const session = host.sessions.get(1);
    const tree = session.mode.rootLanguageLayer.tree;
    const next = configuration(host.config);
    next.values.editor.fontSize += 1;
    await host.dispatch("configure", { version: 2, configuration: next });
    const result = await host.dispatch("settle", data);
    assert.equal(session.mode.rootLanguageLayer.tree, tree);
    assert.equal(result.generation, 1);
    assert.equal(host.config.get("editor.fontSize"), next.values.editor.fontSize);
    assert.equal(session.jobs.size, 0);
  } finally {
    host.close();
  }
});

test("paste candidates share the saved source and reuse a private incremental tree without changing the parent", async () => {
  const original = "function work() {\n\n}\n";
  const { host, data } = await setup(original);
  try {
    host.config.setSchema("language-javascript", {
      type: "object",
      properties: require("language-javascript/package.json").configSchema,
    });
    await host.dispatch("settle", data);
    const parent = host.sessions.get(1),
      source = parent.buffer.getTextSnapshot(),
      tree = parent.mode.tree;
    await host.dispatch("fork", { ...data, target: 2 });
    const fork = host.sessions.get(2);
    assert.equal(fork.buffer.getTextSnapshot(), source);
    assert.notEqual(fork.initialSyntaxTree, tree);
    await host.dispatch("edit", {
      session: 2,
      beforeRevision: 0,
      revision: 1,
      changes: [{ startIndex: 18, oldEndIndex: 18, text: "value();\nnext();" }],
    });
    await host.dispatch("initialize", { session: 2 });
    const entries = [];
    await host.dispatch(
      "prepared-indent",
      { session: 2, revision: 1, ranges: [[1, 2]], tabLength: 2, options: {} },
      { emit: async (batch) => entries.push(...batch) },
    );
    assert.deepEqual(entries, [
      [1, 1],
      [2, 1],
    ]);
    assert.equal(fork.mode.tree.incremental, true);
    assert.equal(parent.buffer.getText(), original);
    assert.equal(parent.mode.tree, tree);
    assert.equal(parent.revision, 0);
    host.control({ operation: "release", session: 2 });
    assert.equal(host.sessions.size, 1);
    assert.equal(parent.forks.size, 0);
  } finally {
    host.close();
  }
});

test("changing a parent cancels a paused candidate stream and releases its private document", async () => {
  const { host, data } = await setup("function work() {\n\n}\n");
  try {
    await host.dispatch("fork", { ...data, target: 2 });
    await host.dispatch("edit", {
      session: 2,
      beforeRevision: 0,
      revision: 1,
      changes: [{ startIndex: 18, oldEndIndex: 18, text: "work();\n".repeat(300) }],
    });
    await host.dispatch("initialize", { session: 2 });
    let announce;
    const entered = new Promise((resolve) => {
      announce = resolve;
    });
    const running = host.dispatch(
      "prepared-indent",
      { session: 2, revision: 1, ranges: [[1, 300]], tabLength: 2, options: {} },
      {
        emit: () => {
          announce();
          return new Promise(() => {});
        },
      },
    );
    const rejected = assert.rejects(running, { name: "AbortError" });
    await entered;
    await host.dispatch("edit", {
      ...data,
      beforeRevision: 0,
      revision: 1,
      changes: [{ startIndex: 0, oldEndIndex: 0, text: "// edited\n" }],
    });
    await rejected;
    assert.equal(host.sessions.has(2), false);
    assert.equal(host.sessions.get(1).forks.size, 0);
  } finally {
    host.close();
  }
});

test("candidate text packets assemble immutable chunks instead of joining a whole payload string", async () => {
  const { host, data } = await setup();
  try {
    await host.dispatch("fork", { ...data, target: 2 });
    const text = "x".repeat(150000);
    await host.dispatch("edit-begin", { session: 2, beforeRevision: 0, revision: 1, count: 1 });
    await host.dispatch("edit-text-begin", {
      session: 2,
      startIndex: 0,
      oldEndIndex: 0,
      length: text.length,
    });
    for (let offset = 0; offset < text.length; offset += 65536)
      await host.dispatch("edit-text-chunk", {
        session: 2,
        text: text.slice(offset, offset + 65536),
      });
    await host.dispatch("edit-text-end", { session: 2 });
    const inserted = host.sessions.get(2).pendingEdit.changes[0].text;
    assert.ok(inserted instanceof require("../../src/text-model").PieceTree);
    assert.equal(inserted.length, text.length);
    await host.dispatch("edit-commit", { session: 2 });
    assert.equal(host.sessions.get(2).buffer.getTextSnapshot().slice(0, text.length), text);
    assert.equal(host.sessions.get(1).buffer.getText(), "const value = 3;\r\n");
  } finally {
    host.close();
  }
});
