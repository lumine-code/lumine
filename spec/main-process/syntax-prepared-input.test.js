const { test } = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const rules = require("../../src/typing-indentation-rules");
const Endpoint = require("../../src/syntax-worker-endpoint");
const Service = require("../../src/syntax-worker-service");
const Range = require("../../src/range");
const LanguageMode = require("../../src/tree-sitter-language-mode");
const PieceTree = require("../../src/piece-tree");

function parseCandidate(indentationOnly, parser) {
  return {
    indentationOnly,
    buffer: {},
    document: { capture: () => ({ text: new PieceTree("value = 1"), revision: 1, edits: [] }) },
    backgroundSnapshots: new WeakSet(),
    parseDetails: new WeakMap(),
    syncTimeoutMicros: 4000,
    parsePriority: 0,
    acquireParserForLanguage: () => parser,
    releaseParserForLanguage() {},
    describeParseFailure: (error) => error,
  };
}

test("private indentation starts within the current task but preserves cancellation before parsing", async (t) => {
  const deferred = [];
  t.mock.method(globalThis, "setImmediate", (callback) => deferred.push(callback));
  const tree = {};
  let parsed = 0;
  const mode = parseCandidate(true, {
    tryParseSync() {
      parsed++;
      return tree;
    },
  });
  const result = LanguageMode.prototype.parseAsync.call(mode, {}, null, null);
  assert.equal(parsed, 0);
  assert.equal(await result, tree);
  assert.equal(parsed, 1);
  assert.deepEqual(deferred, []);
  const controller = new AbortController();
  const cancelled = LanguageMode.prototype.parseAsync.call(mode, {}, null, null, {
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await cancelled, null);
  assert.equal(parsed, 1);
});

test("ordinary parse work still defers so an edit burst can cancel it before leasing a parser", async (t) => {
  const deferred = [];
  t.mock.method(globalThis, "setImmediate", (callback) => deferred.push(callback));
  const controller = new AbortController();
  const mode = parseCandidate(false, {});
  mode.acquireParserForLanguage = () =>
    assert.fail("Cancelled ordinary parse must not lease a parser");
  const result = LanguageMode.prototype.parseAsync.call(mode, {}, null, null, {
    signal: controller.signal,
  });
  assert.equal(deferred.length, 1);
  controller.abort();
  deferred.shift()();
  assert.equal(await result, null);
});

test("private indentation retains the synchronous deadline and resumes through bounded async parsing", async () => {
  const tree = {};
  const controller = new AbortController();
  let resumed = false,
    released = false;
  const before = performance.now();
  const mode = parseCandidate(true, {
    tryParseSync(_text, options) {
      assert.ok(Number.isFinite(options.deadline));
      assert.ok(options.deadline <= performance.now() + 4);
      return null;
    },
    async parse(_text, options) {
      resumed = true;
      assert.equal(options.signal, controller.signal);
      assert.ok(Number.isFinite(options.deadlineForSlice()));
      assert.ok(options.deadlineForSlice() <= performance.now() + 4);
      return tree;
    },
  });
  mode.releaseParserForLanguage = () => {
    released = true;
  };
  assert.equal(
    await LanguageMode.prototype.parseAsync.call(mode, {}, null, null, {
      signal: controller.signal,
    }),
    tree,
  );
  assert.ok(performance.now() >= before);
  assert.ok(resumed && released);
});

async function setup({
  files = ["language-python/grammars/python.json"],
  text = "class Record:",
} = {}) {
  const host = new Host();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const grammars = files.map((name) => {
    const file = require.resolve(name);
    return { file, definition: require("@lumine-code/season").readFileSync(file) };
  });
  const { definition } = grammars[0];
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars,
    modules: [],
    specMode: true,
  });
  const data = { session: 1, revision: 9, scopeName: definition.scopeName, path: "example.py" };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  return { host, data };
}

test("small prepared input returns inline levels without an acknowledgement and releases its fork", async () => {
  const { host, data } = await setup();
  try {
    const rows = [];
    const result = await host.dispatch(
      "prepared-indent",
      {
        ...data,
        target: 2,
        changes: [{ startIndex: 13, oldEndIndex: 13, text: "\n" }],
        ranges: [[1, 1]],
        tabLength: 4,
        inline: true,
        options: {
          isPastedText: false,
          rowOptions: new Map([[1, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
        },
      },
      { emit: (batch) => rows.push(...batch) },
    );
    assert.deepEqual(rows, []);
    assert.deepEqual(result.value, { count: 1, levels: [[1, 1]] });
    assert.equal(result.revision, 9);
    assert.equal(host.sessions.size, 1);
    assert.equal(host.sessions.get(1).buffer.getText(), "class Record:");
    assert.equal(host.sessions.get(1).forks.size, 0);
  } finally {
    host.close();
  }
});

test("private indentation scans only local independent injections and skips fixed non-indent languages", async (t) => {
  const text =
    "function method() {\n    return 1;\n}\n".repeat(400) + "const expression = /abc+/;\n";
  const { host, data } = await setup({
    files: ["language-javascript/grammars/javascript.json", "language-regex/grammars/regex.json"],
    text,
  });
  try {
    host.config.set("language-javascript.indentation.indentBraces", true);
    const grammar = host.grammars.grammarForScopeName("source.js");
    const registration = host.grammars.addInjectionPoint("source.js", {
      type: "regex",
      language: "regex",
      content: (node) => node.childForFieldName("pattern"),
    });
    await host.dispatch("settle", data);
    const mode = host.sessions.get(1).mode;
    assert.ok(
      mode.getAllInjectionLayers().some((layer) => layer.grammar.scopeName === "source.regexp"),
    );
    const prototype = Object.getPrototypeOf(mode.rootLanguageLayer);
    const queries = [],
      types = [];
    const query = prototype._queryStaticInjectionCandidates;
    const collect = prototype._collectInjectionCandidateNodes;
    t.mock.method(
      prototype,
      "_queryStaticInjectionCandidates",
      function (tree, queryObject, start, end, ...rest) {
        if (this.languageMode.indentationOnly) queries.push([start.row, end.row]);
        return query.call(this, tree, queryObject, start, end, ...rest);
      },
    );
    t.mock.method(prototype, "_collectInjectionCandidateNodes", function (tree, names, ...rest) {
      if (this.languageMode.indentationOnly) types.push(...names);
      return collect.call(this, tree, names, ...rest);
    });
    const result = await host.dispatch("prepared-indent", {
      ...data,
      target: 2,
      changes: [{ startIndex: 19, oldEndIndex: 19, text: "\n" }],
      ranges: [[1, 1]],
      tabLength: 4,
      inline: true,
      options: {
        isPastedText: false,
        rowOptions: new Map([[1, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
      },
    });
    assert.deepEqual(result.value.levels, [[1, 1]]);
    assert.equal(types.includes("regex"), false);
    assert.ok(queries.length > 0);
    assert.ok(queries.every(([start, end]) => start >= 0 && end <= 2));
    queries.length = 0;
    await host.dispatch("prepared-indent", {
      ...data,
      target: 3,
      changes: [{ startIndex: 19, oldEndIndex: 19, text: "\n" }],
      ranges: [
        [1, 1],
        [901, 901],
      ],
      tabLength: 4,
      inline: true,
      options: { isPastedText: false },
    });
    assert.ok(queries.length >= 2);
    assert.ok(queries.every(([start, end]) => end <= 2 || (start >= 900 && end <= 902)));
    assert.equal(host.sessions.size, 1);
    assert.equal(grammar.injectionPointsByType.regex[0].language, "regex");
    registration.dispose();
  } finally {
    host.close();
  }
});

test("local indentation discovery retains enclosing injected content and matches full discovery", async (t) => {
  const text =
    "const style = css`\n.example {\n  color: red;\n}\n`;\n" + "const tail = 1;\n".repeat(300);
  const { host, data } = await setup({
    files: ["language-javascript/grammars/javascript.json", "language-css/grammars/css.json"],
    text,
  });
  try {
    const dispatch = host.dispatch;
    let full = false;
    t.mock.method(host, "dispatch", function (operation, data, options) {
      if (full && operation === "initialize") data = { ...data, indentationRanges: undefined };
      return dispatch.call(this, operation, data, options);
    });
    const startIndex = text.indexOf("red;") + 4;
    const input = {
      ...data,
      changes: [{ startIndex, oldEndIndex: startIndex, text: "\n" }],
      ranges: [[3, 3]],
      tabLength: 2,
      inline: true,
      options: {
        isPastedText: false,
        rowOptions: new Map([[3, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
      },
    };
    const local = await host.dispatch("prepared-indent", { ...input, target: 2 });
    full = true;
    const complete = await host.dispatch("prepared-indent", { ...input, target: 3 });
    assert.deepEqual(local.value, complete.value);
    assert.deepEqual(local.value.levels, [[3, 1]]);
    assert.equal(host.sessions.get(1).buffer.getText(), text);
  } finally {
    host.close();
  }
});

test("combined injections retain distant members when preparing local indentation", async (t) => {
  const text =
    "const first = css`.example {\n`;\n" +
    "const unrelated = 1;\n".repeat(300) +
    "const second = css`\n  color: red;\n}\n`;\n";
  const { host, data } = await setup({
    files: ["language-javascript/grammars/javascript.json", "language-css/grammars/css.json"],
    text,
  });
  try {
    await host.grammars.grammarForScopeName("source.js").setQueryForTest(
      "injectionsQuery",
      `
      ((call_expression function: (identifier) @_tag
        arguments: (template_string (string_fragment) @injection.content)) @injection.owner
        (#eq? @_tag "css")
        (#set! injection.language "css")
        (#set! injection.combined true))
    `,
    );
    await host.dispatch("settle", data);
    const mode = host.sessions.get(1).mode;
    const prototype = Object.getPrototypeOf(mode.rootLanguageLayer);
    const query = prototype._queryStaticInjectionCandidates;
    const rows = [];
    t.mock.method(
      prototype,
      "_queryStaticInjectionCandidates",
      function (tree, queryObject, start, ...rest) {
        if (this.languageMode.indentationOnly && this.depth === 0) rows.push(start.row);
        return query.call(this, tree, queryObject, start, ...rest);
      },
    );
    const startIndex = text.indexOf("red;") + 4;
    const result = await host.dispatch("prepared-indent", {
      ...data,
      target: 2,
      changes: [{ startIndex, oldEndIndex: startIndex, text: "\n" }],
      ranges: [[304, 304]],
      tabLength: 2,
      inline: true,
      options: {
        isPastedText: false,
        rowOptions: new Map([[304, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
      },
    });
    assert.deepEqual(result.value.levels, [[304, 1]]);
    assert.equal(Math.min(...rows), 0);
    assert.equal(host.sessions.size, 1);
  } finally {
    host.close();
  }
});

test("thousands of disjoint indentation contexts are merged in linear work", async (t) => {
  const count = 2000;
  const { host, data } = await setup({ text: "value = 1\n".repeat(count * 4 + 4) });
  try {
    await host.dispatch("fork", { ...data, target: 2 });
    let comparisons = 0,
      contexts;
    const compare = require("../../src/point").prototype.compare;
    t.mock.method(require("../../src/point").prototype, "compare", function (...args) {
      comparisons++;
      return compare.apply(this, args);
    });
    t.mock.method(host, "installMode", (session) => {
      contexts = session.indentationRanges;
    });
    const ranges = Array.from({ length: count }, (_, i) => [i * 4 + 2, i * 4 + 2]);
    await host.dispatch("initialize", { session: 2, indentationRanges: ranges });
    assert.equal(contexts.length, count);
    assert.deepEqual(contexts[0].serialize(), [
      [1, 0],
      [3, 0],
    ]);
    assert.deepEqual(contexts.at(-1).serialize(), [
      [count * 4 - 3, 0],
      [count * 4 - 1, 0],
    ]);
    assert.ok(comparisons < count * 12, `Unexpected context work: ${comparisons}`);
  } finally {
    host.close();
  }
});

test("inline prepared input sends only a result through the real worker endpoint", async () => {
  const { host, data } = await setup();
  const messages = [];
  let finish;
  const completed = new Promise((resolve) => (finish = resolve));
  const endpoint = new Endpoint({
    dispatch: host.dispatch.bind(host),
    send(message) {
      messages.push(message);
      if (message.type === "chunk")
        endpoint.receive({ type: "ack", id: message.id, sequence: message.sequence });
      else finish(message);
    },
  });
  try {
    endpoint.receive({
      type: "request",
      id: 1,
      operation: "prepared-indent",
      data: {
        ...data,
        target: 2,
        changes: [{ startIndex: 13, oldEndIndex: 13, text: "\n" }],
        ranges: [[1, 1]],
        tabLength: 4,
        inline: true,
        options: { isPastedText: false },
      },
    });
    const result = await completed;
    assert.deepEqual(
      messages.map((message) => message.type),
      ["result"],
    );
    assert.deepEqual(result.value.value.levels, [[1, 1]]);
    assert.equal(endpoint.jobs.size, 0);
    assert.equal(host.sessions.size, 1);
  } finally {
    endpoint.close();
    host.close();
  }
});

for (const count of [128, 129])
  test(`prepared indentation bounds inline replies to 128 requested rows (${count})`, async () => {
    const { host, data } = await setup();
    const chunks = [];
    try {
      const result = await host.dispatch(
        "prepared-indent",
        {
          ...data,
          target: 2,
          changes: [{ startIndex: 13, oldEndIndex: 13, text: "\n".repeat(count) }],
          ranges: [[1, count]],
          tabLength: 4,
          inline: true,
          options: { isPastedText: false },
        },
        { emit: (batch) => chunks.push(...batch) },
      );
      assert.equal(result.value.count, count);
      if (count <= 128) {
        assert.equal(result.value.levels.length, count);
        assert.equal(chunks.length, 0);
      } else {
        assert.equal(result.value.levels, undefined);
        assert.equal(chunks.length, count);
      }
    } finally {
      host.close();
    }
  });

test("cancelled inline analysis never emits a partial packet or leaks its fork", async () => {
  const { host, data } = await setup();
  const controller = new AbortController();
  const original = host.dispatch.bind(host);
  let chunks = 0;
  host.dispatch = async function (operation, input, options) {
    if (operation === "prepared-indent" && input.target == null) {
      this.sessions.get(input.session).mode.scanSuggestedIndentation = async function* () {
        yield [[1, 1]];
        controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      };
    }
    return original(operation, input, options);
  };
  try {
    await assert.rejects(
      host.dispatch(
        "prepared-indent",
        {
          ...data,
          target: 2,
          changes: [{ startIndex: 13, oldEndIndex: 13, text: "\n" }],
          ranges: [[1, 1]],
          tabLength: 4,
          inline: true,
          options: { isPastedText: false },
        },
        { signal: controller.signal, emit: () => chunks++ },
      ),
      { name: "AbortError" },
    );
    assert.equal(chunks, 0);
    assert.equal(host.sessions.size, 1);
  } finally {
    host.close();
  }
});

for (const stop of ["complete", "break", "obsolete"])
  test(`the service delivers inline results through its cancellable iterator (${stop})`, async () => {
    const sent = [],
      requests = [];
    const service = {
      nextSession: 0,
      syntaxEpoch: 0,
      client: { send: (message) => sent.push(message) },
      async request(_session, operation, input) {
        requests.push([operation, input.inline]);
        if (stop === "obsolete") this.syntaxEpoch++;
        return { count: 1, levels: [[1, 1]] };
      },
    };
    const session = { buffer: { getTextRevision: () => 9 }, epoch: 0 };
    const stream = Service.prototype.scanPreparedIndentation.call(
      service,
      session,
      [
        {
          oldRange: new Range([0, 13], [0, 13]),
          startIndex: 13,
          oldEndIndex: 13,
          newText: "\n",
        },
      ],
      [[1, 1]],
      4,
    );
    if (stop === "obsolete") await assert.rejects(stream.next(), { name: "AbortError" });
    else {
      assert.deepEqual(await stream.next(), { done: false, value: [[1, 1]] });
      const next = stop === "break" ? await stream.return() : await stream.next();
      assert.equal(next.done, true);
    }
    assert.deepEqual(requests, [["prepared-indent", true]]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].operation, "release");
  });

test("typing filter proves ordinary Python text cannot dedent and retains keywords and delimiters", async () => {
  const { host, data } = await setup();
  try {
    const metadata = (await host.dispatch("settle", data)).value;
    assert.ok(Array.isArray(metadata.typingIndentationRules));
    for (const value of ["hello", "field = 123", "els", "elsewhere", "except Error", "excepted"])
      assert.equal(rules.mayMatch(metadata.typingIndentationRules, value), false, value);
    for (const value of ["else", "elif", "case", "except", ")", "]", "}"])
      assert.equal(rules.mayMatch(metadata.typingIndentationRules, value), true, value);
    const mode = host.sessions.get(1).mode;
    for (const source of [
      "(identifier) @dedent",
      '((identifier) @match (#match? @match "[[:alpha:]]+"))',
    ]) {
      const query = mode.grammar._createQuery(mode.rootLanguage, source);
      try {
        assert.equal(rules.compile(query, source), null);
      } finally {
        query.delete();
      }
    }
    const source = '("}" @dedent (#set! indent.force true))';
    const query = mode.grammar._createQuery(mode.rootLanguage, source);
    try {
      assert.equal(rules.mayMatch(rules.compile(query, source), "} else {"), true);
    } finally {
      query.delete();
    }
  } finally {
    host.close();
  }
});

test("obsolete compact preparation cannot publish or leave a speculative document behind", async () => {
  const { host, data } = await setup();
  try {
    let entered;
    const ready = new Promise((resolve) => (entered = resolve));
    const pending = host.dispatch(
      "prepared-indent",
      {
        ...data,
        target: 2,
        changes: [{ startIndex: 13, oldEndIndex: 13, text: "\n" }],
        ranges: [[1, 1]],
        tabLength: 4,
        options: { isPastedText: false },
      },
      {
        emit: () => {
          entered();
          return new Promise(() => {});
        },
      },
    );
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await ready;
    await host.dispatch("edit", {
      session: 1,
      beforeRevision: 9,
      revision: 10,
      changes: [{ startIndex: 0, oldEndIndex: 0, text: "# changed\n" }],
    });
    await rejected;
    assert.equal(host.sessions.size, 1);
  } finally {
    host.close();
  }
});
