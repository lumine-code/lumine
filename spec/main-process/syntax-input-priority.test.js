const { test } = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const Mode = require("../../src/tree-sitter-language-mode");
const Parser = require("../../src/tree-sitter-parser");
const scheduler = require("../../src/tree-sitter-scheduler");
const { configuration } = require("../../src/syntax-worker-environment");

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

async function setup(
  text = "class Record:\n    field = 1\n",
  files = ["language-python/grammars/python.json"],
) {
  const host = new Host();
  try {
    for (const [key, schema] of Object.entries(require("../../src/config-schema")))
      host.config.setSchema(key, schema);
    const grammars = files.map((name) => {
      const file = require.resolve(name);
      return { file, definition: require("@lumine-code/season").readFileSync(file) };
    });
    await host.dispatch("environment", {
      version: 1,
      configuration: configuration(host.config),
      grammars,
      modules: [],
      specMode: true,
    });
    const data = {
      session: 1,
      revision: 0,
      scopeName: grammars[0].definition.scopeName,
      path: "example.py",
    };
    await host.dispatch("open", data);
    await host.dispatch("append", { session: 1, text });
    await host.dispatch("initialize", data);
    await host.dispatch("settle", data);
    const session = host.sessions.get(1);
    session.mode.queryBudget = { now: () => 0 };
    return { host, data, session };
  } catch (error) {
    host.close();
    throw error;
  }
}

function input(data, target) {
  return {
    ...data,
    target,
    changes: [{ startIndex: 13, oldEndIndex: 13, text: "\n" }],
    ranges: [[1, 1]],
    inline: true,
    tabLength: 4,
    options: {
      isPastedText: false,
      rowOptions: new Map([[1, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
    },
  };
}

function holdPrivateParses(t, count = 1) {
  const gates = Array.from({ length: count }, () => ({ entered: deferred(), release: deferred() }));
  const parse = Mode.prototype.parseAsync;
  let next = 0;
  t.mock.method(Mode.prototype, "parseAsync", async function (...args) {
    if (this.indentationOnly && (args[3]?.depth ?? 0) === 0 && next < gates.length) {
      const gate = gates[next++];
      gate.entered.resolve();
      const signal = args[3]?.signal;
      await new Promise((resolve) => {
        const abort = () => resolve();
        signal?.addEventListener("abort", abort, { once: true });
        gate.release.promise.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
        if (signal?.aborted) abort();
      });
      if (signal?.aborted || this.destroyed) return null;
    }
    return parse.apply(this, args);
  });
  return gates;
}

function observeView(t, host, session, events, onSeek) {
  const blocked = deferred();
  const wait = host.waitForInput.bind(host);
  t.mock.method(host, "waitForInput", (...args) => {
    const pending = wait(...args);
    if (pending) blocked.resolve();
    return pending;
  });
  const build = session.mode.buildHighlightIterator;
  t.mock.method(session.mode, "buildHighlightIterator", function (...args) {
    const iterator = build.apply(this, args);
    const seek = iterator.seek;
    t.mock.method(iterator, "seek", function (...seekArgs) {
      events.push("seek");
      const scopes = seek.apply(this, seekArgs);
      onSeek?.(iterator);
      return scopes;
    });
    return iterator;
  });
  const fold = session.mode.getFoldRangeForRow;
  t.mock.method(session.mode, "getFoldRangeForRow", function (...args) {
    events.push("fold");
    return fold.apply(this, args);
  });
  return blocked.promise;
}

function track(tasks, promise) {
  tasks.push(promise);
  void promise.catch(() => {});
  return promise;
}

async function cleanup(host, gates, tasks) {
  for (const gate of gates) gate.release.resolve();
  if (!host.closed) host.close();
  await Promise.allSettled(tasks);
}

test(
  "a pending input parse postpones view queries until its complete result is available",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [];
    const blocked = observeView(t, host, session, events);
    try {
      const pendingInput = track(
        tasks,
        host.dispatch("input-indent", input(data, 2)).then((result) => {
          events.push("input-result");
          return result;
        }),
      );
      await gates[0].entered.promise;
      const pendingView = track(tasks, host.dispatch("view", { ...data, ranges: [[0, 1]] }));
      await blocked;
      assert.deepEqual(events, []);
      gates[0].release.resolve();
      assert.deepEqual((await pendingInput).value.levels, [[1, 1]]);
      const painted = await pendingView;
      assert.equal(painted.value.tiles.length, 1);
      assert.equal(events[0], "input-result");
      assert.ok(events.includes("seek"));
      assert.equal(events.filter((event) => event === "fold").length, 2);
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "overlapping input requests retain priority until both results are available",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t, 2),
      tasks = [],
      events = [];
    const blocked = observeView(t, host, session, events);
    try {
      const first = track(
        tasks,
        host.dispatch("input-indent", input(data, 2)).then((result) => {
          events.push("first-result");
          return result;
        }),
      );
      await gates[0].entered.promise;
      const second = track(
        tasks,
        host.dispatch("input-indent", input(data, 3)).then((result) => {
          events.push("second-result");
          return result;
        }),
      );
      await gates[1].entered.promise;
      const pendingView = track(tasks, host.dispatch("view", { ...data, ranges: [[0, 1]] }));
      await blocked;
      gates[0].release.resolve();
      await first;
      await new Promise(setImmediate);
      assert.deepEqual(events, ["first-result"]);
      gates[1].release.resolve();
      await second;
      await pendingView;
      assert.deepEqual(events.slice(0, 2), ["first-result", "second-result"]);
      assert.ok(events.includes("seek"));
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "aborting an input request releases presentation without leaking the private document",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [];
    const blocked = observeView(t, host, session, events);
    const controller = new AbortController();
    try {
      const pendingInput = track(
        tasks,
        host.dispatch("input-indent", input(data, 2), {
          signal: controller.signal,
        }),
      );
      const rejected = assert.rejects(pendingInput, { name: "AbortError" });
      await gates[0].entered.promise;
      const pendingView = track(tasks, host.dispatch("view", { ...data, ranges: [[0, 1]] }));
      await blocked;
      assert.deepEqual(events, []);
      controller.abort(Object.assign(new Error("Cancelled input"), { name: "AbortError" }));
      await rejected;
      await pendingView;
      assert.ok(events.includes("seek"));
      assert.equal(host.sessions.size, 1);
      assert.equal(host.sessions.get(1).forks.size, 0);
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "a new input joining after the previous reply keeps presentation behind the queued wake",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t, 2),
      tasks = [],
      events = [];
    const blocked = observeView(t, host, session, events);
    try {
      const first = track(
        tasks,
        host.dispatch("input-indent", input(data, 2)).then((result) => {
          events.push("first-result");
          return result;
        }),
      );
      await gates[0].entered.promise;
      const pendingView = track(tasks, host.dispatch("view", { ...data, ranges: [[0, 1]] }));
      await blocked;
      gates[0].release.resolve();
      await first;
      // The first result is available, but its setImmediate wake has not run.
      // A newly accepted input must retain priority across that pending wake.
      const second = track(
        tasks,
        host.dispatch("input-indent", input(data, 3)).then((result) => {
          events.push("second-result");
          return result;
        }),
      );
      await gates[1].entered.promise;
      await new Promise(setImmediate);
      assert.deepEqual(events, ["first-result"]);
      gates[1].release.resolve();
      await second;
      await pendingView;
      assert.deepEqual(events.slice(0, 2), ["first-result", "second-result"]);
      assert.ok(events.includes("seek"));
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "a followed view waits for input before seeking its acknowledged next viewport",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup(
      "class Record:\n    first = 1\n    second = 2\n    third = 3\n",
    );
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [],
      firstTile = deferred(),
      acknowledgement = deferred();
    const blocked = observeView(t, host, session, events);
    let tiles = 0;
    try {
      const pendingView = track(
        tasks,
        host.dispatch(
          "view",
          {
            ...data,
            ranges: [[0, 1]],
            stream: true,
            follow: true,
          },
          {
            emit(packet) {
              if (packet.kind !== "end") return;
              if (++tiles === 1) {
                firstTile.resolve();
                return acknowledgement.promise;
              }
            },
          },
        ),
      );
      await firstTile.promise;
      const pendingInput = track(
        tasks,
        host.dispatch("input-indent", input(data, 2)).then((result) => {
          events.push("input-result");
          return result;
        }),
      );
      await gates[0].entered.promise;
      acknowledgement.resolve({ range: [2, 3] });
      await blocked;
      assert.equal(events.filter((event) => event === "seek").length, 1);
      gates[0].release.resolve();
      await pendingInput;
      await pendingView;
      assert.equal(tiles, 2);
      const seeks = events.flatMap((event, index) => (event === "seek" ? [index] : []));
      assert.ok(seeks.length >= 2);
      assert.ok(seeks[1] > events.indexOf("input-result"));
    } finally {
      acknowledgement.resolve();
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "an input arriving during a timeout retry yield postpones the repeated paint query",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [];
    let seeks = 0,
      pendingInput;
    const blocked = observeView(t, host, session, events, (iterator) => {
      if (++seeks !== 1) return;
      iterator.limitedReason = "timeout";
      setImmediate(() => {
        pendingInput = track(
          tasks,
          host.dispatch("input-indent", input(data, 2)).then((result) => {
            events.push("input-result");
            return result;
          }),
        );
      });
    });
    try {
      const pendingView = track(tasks, host.dispatch("view", { ...data, ranges: [[0, 1]] }));
      await gates[0].entered.promise;
      await blocked;
      assert.deepEqual(events, ["seek"]);
      gates[0].release.resolve();
      await pendingInput;
      await pendingView;
      assert.deepEqual(events.slice(0, 3), ["seek", "input-result", "seek"]);
      assert.equal(seeks, 2);
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "input accepted while a preview is loading postpones its first paint query",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [],
      previewReady = deferred(),
      releasePreview = deferred(),
      packets = [];
    const blocked = observeView(t, host, session, events);
    const getPreview = host.previews.get.bind(host.previews);
    t.mock.method(host.previews, "get", async (...args) => {
      const preview = await getPreview(...args);
      assert.ok(preview);
      preview.mode.queryBudget = { now: () => 0 };
      const build = preview.mode.buildHighlightIterator;
      t.mock.method(preview.mode, "buildHighlightIterator", function (...buildArgs) {
        const iterator = build.apply(this, buildArgs);
        const seek = iterator.seek;
        t.mock.method(iterator, "seek", function (...seekArgs) {
          events.push("preview-seek");
          return seek.apply(this, seekArgs);
        });
        return iterator;
      });
      previewReady.resolve();
      await releasePreview.promise;
      return preview;
    });
    session.mode.publicationPending = true;
    const current = () => {
      if (host.closed || host.sessions.get(session.id) !== session)
        throw Object.assign(new Error("View was superseded"), { name: "AbortError" });
    };
    try {
      const pendingView = track(
        tasks,
        host.previewView(session, [0, 1], async (packet) => packets.push(packet), current),
      );
      await previewReady.promise;
      const pendingInput = track(
        tasks,
        host.dispatch("input-indent", input(data, 2)).then((result) => {
          events.push("input-result");
          return result;
        }),
      );
      await gates[0].entered.promise;
      releasePreview.resolve();
      await blocked;
      assert.deepEqual(events, []);
      gates[0].release.resolve();
      await pendingInput;
      assert.equal((await pendingView).syntaxReady, false);
      assert.deepEqual(events, ["input-result", "preview-seek"]);
      assert.ok(packets.some((packet) => packet.quality === "provisional"));
    } finally {
      releasePreview.resolve();
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "closing the host cancels a view waiting behind input without querying its destroyed mode",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [];
    const blocked = observeView(t, host, session, events);
    try {
      const pendingInput = track(tasks, host.dispatch("input-indent", input(data, 2)));
      const rejectedInput = assert.rejects(pendingInput, { name: "AbortError" });
      await gates[0].entered.promise;
      const pendingView = track(tasks, host.dispatch("view", { ...data, ranges: [[0, 1]] }));
      const rejectedView = assert.rejects(pendingView, { name: "AbortError" });
      await blocked;
      host.close();
      await Promise.all([rejectedInput, rejectedView]);
      assert.deepEqual(events, []);
      assert.equal(host.sessions.size, 0);
      assert.equal(host.inputBarrier, null);
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "a view can cancel its own wait while the input remains pending",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup();
    const gates = holdPrivateParses(t),
      tasks = [],
      events = [];
    const blocked = observeView(t, host, session, events);
    const controller = new AbortController();
    try {
      const pendingInput = track(tasks, host.dispatch("input-indent", input(data, 2)));
      await gates[0].entered.promise;
      const pendingView = track(
        tasks,
        host.dispatch(
          "view",
          { ...data, ranges: [[0, 1]] },
          {
            signal: controller.signal,
          },
        ),
      );
      const rejected = assert.rejects(pendingView, { name: "AbortError" });
      await blocked;
      controller.abort(Object.assign(new Error("View was superseded"), { name: "AbortError" }));
      await rejected;
      assert.deepEqual(events, []);
      assert.ok(host.inputBarrier);
      gates[0].release.resolve();
      assert.deepEqual((await pendingInput).value.levels, [[1, 1]]);
      assert.deepEqual(events, []);
    } finally {
      await cleanup(host, gates, tasks);
    }
  },
);

test(
  "fold collection yields to a queued input task and resumes after its complete result",
  { timeout: 10000 },
  async (t) => {
    const { host, data, session } = await setup("value = 1\n".repeat(32));
    const tasks = [],
      inputStarted = deferred(),
      releaseInput = deferred(),
      folds = [],
      events = [];
    let inputTask,
      inputScheduled,
      rowsAtInput,
      now = performance.now();
    t.mock.method(performance, "now", () => (now += 5));
    t.mock.method(session.mode, "getFoldRangeForRow", (row) => {
      folds.push(row);
      if (!inputScheduled) {
        inputScheduled = true;
        setImmediate(() => {
          inputTask = track(
            tasks,
            host.withInputPriority(async () => {
              rowsAtInput = folds.length;
              inputStarted.resolve();
              await releaseInput.promise;
              events.push("input-result");
            }),
          );
        });
      }
      return null;
    });
    try {
      const pendingView = track(
        tasks,
        host.dispatch("view", { ...data, ranges: [[0, 31]] }).then((result) => {
          events.push("view-result");
          return result;
        }),
      );
      await inputStarted.promise;
      assert.ok(rowsAtInput > 0 && rowsAtInput < 32);
      await new Promise(setImmediate);
      assert.equal(folds.length, rowsAtInput);
      releaseInput.resolve();
      await inputTask;
      const painted = await pendingView;
      assert.deepEqual(
        folds,
        Array.from({ length: 32 }, (_, row) => row),
      );
      assert.deepEqual(events, ["input-result", "view-result"]);
      assert.equal(painted.value.tiles[0].folds.length, 32);
    } finally {
      releaseInput.resolve();
      await cleanup(host, [], tasks);
    }
  },
);

test(
  "resumable input root and injected parsers outrank preview and focused work while bulk keeps its background priority",
  { timeout: 10000 },
  async (t) => {
    const source = "# %%\nclass Record:\n    field = 1\n";
    const { host, data } = await setup(source, [
      "language-ipython/grammars/ipython.json",
      "language-python/grammars/python.json",
    ]);
    const install = host.installModeCurrent;
    t.mock.method(host, "installModeCurrent", function (session) {
      const result = install.call(this, session);
      // Exercise resumable WASM work even though this fixture could otherwise
      // complete inside the synchronous allowance and never enter the queue.
      if (session.parent) session.mode.syncTimeoutMicros = 0;
      return result;
    });
    const contexts = new WeakMap(),
      records = [];
    let phase = "input";
    const parse = Parser.prototype.parse;
    t.mock.method(Parser.prototype, "parse", function (text, options) {
      contexts.set(options.priority, options.runtimeContext.scopeName);
      return parse.call(this, text, options);
    });
    const run = scheduler.runSlices;
    t.mock.method(scheduler, "runSlices", function (operation, options) {
      records.push({
        phase,
        scopeName: contexts.get(options.priority),
        priority: options.priority(),
      });
      return run.call(this, operation, options);
    });
    host.control({ operation: "focus", session: data.session });
    const request = {
      ...data,
      changes: [{ startIndex: 18, oldEndIndex: 18, text: "\n" }],
      ranges: [[2, 2]],
      inline: true,
      tabLength: 4,
      options: {
        isPastedText: false,
        rowOptions: new Map([[2, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
      },
    };
    try {
      const plannedInput = await host.dispatch("input-indent", { ...request, target: 2 });
      phase = "bulk";
      const plannedBulk = await host.dispatch("prepared-indent", { ...request, target: 3 });
      assert.deepEqual(plannedInput.value.levels, [[2, 1]]);
      assert.deepEqual(plannedBulk.value, plannedInput.value);
      for (const name of ["input", "bulk"]) {
        const submitted = records.filter((record) => record.phase === name);
        const root = submitted.find((record) => record.scopeName === "source.python.ipy"),
          child = submitted.find((record) => record.scopeName === "source.python");
        assert.ok(root, `Missing ${name} root parser submission`);
        assert.ok(child, `Missing ${name} injected parser submission`);
        assert.equal(child.priority - root.priority, 1);
        if (name === "input") {
          for (const { priority } of submitted) {
            assert.ok(priority < -10, "Input must outrank preview parsing");
            assert.ok(priority < 0, "Input must outrank focused-document background parsing");
          }
        } else {
          for (const { priority } of submitted)
            assert.ok(priority >= 100, "Bulk private documents keep ordinary background priority");
        }
      }
      assert.equal(host.sessions.size, 1);
      assert.equal(host.sessions.get(1).buffer.getText(), source);
    } finally {
      host.close();
    }
  },
);
