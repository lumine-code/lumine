const { test } = require("node:test");
const assert = require("node:assert/strict");
const SyntaxPreview = require("../../src/syntax-preview");
const { selectPreviewWindow } = SyntaxPreview;
const TextBuffer = require("../../src/text-buffer");
const { PieceTree } = require("../../src/text-model");

function fixture(text, { modeFactory, timeoutMs = 1000 } = {}) {
  const source = new TextBuffer({ text });
  const grammar = { scopeName: "source.example" };
  const registry = {
    rootLanguageRangesByBuffer: new WeakMap(),
    treeSitterGrammarForLanguageString: () => grammar,
  };
  const contexts = new WeakMap();
  const modes = [];
  const preview = new SyntaxPreview({
    grammars: registry,
    timeoutMs,
    syntaxRuntime: { registerBuffer: (buffer, context) => contexts.set(buffer, context) },
    createMode: (options) => {
      const mode = {
        ready: Promise.resolve(),
        atGrammarSettlement: () => Promise.resolve({}),
        requestHighlighting() {},
        destroy() {
          this.destroyed = true;
        },
        ...modeFactory?.(options),
      };
      modes.push(mode);
      return mode;
    },
  });
  const session = {
    id: 1,
    revision: 7,
    generation: 3,
    buffer: source,
    mode: { grammar, publicationPending: true },
  };
  return {
    source,
    grammar,
    registry,
    session,
    preview,
    contexts,
    modes,
    dispose() {
      preview.dispose();
      source.destroy();
    },
  };
}

test("preview windows bound source reads and preserve global/local coordinate origins", () => {
  const text = "// preceding context\r\n".repeat(40) + "const value = 3;\r\nnext();\r\n";
  const source = new PieceTree(text);
  const window = selectPreviewWindow(source, { startRow: 40, endRow: 41 });
  assert.equal(window.startRow, 20);
  assert.equal(window.startColumn, 0);
  assert.equal(window.sourceStartIndex, source.lineStart(20));
  assert.equal(window.sourceEndIndex, source.lineStart(42));
  assert.equal(window.text, text.slice(window.sourceStartIndex, window.sourceEndIndex));
  assert.deepEqual(window.requestedStart, { row: 40, column: 0 });
  assert.deepEqual(window.requestedEnd, { row: 42, column: 0 });
  assert.equal(window.limited, false);
  assert.equal(window.quality, "provisional");
});

test("preceding context is at most 4 Ki units and 20 rows, and a huge first row is clipped", () => {
  const source = new PieceTree(("x".repeat(300) + "\n").repeat(100));
  const window = selectPreviewWindow(source, { startRow: 80, endRow: 99 });
  assert.ok(80 - window.startRow <= 20);
  assert.ok(source.lineStart(80) - window.sourceStartIndex <= 4096);
  const huge = new PieceTree("x".repeat(1024 * 1024));
  const clipped = selectPreviewWindow(huge, { startRow: 0, endRow: 0 });
  assert.equal(clipped.text.length, 16384);
  assert.equal(clipped.sourceEndIndex, 16384);
  assert.deepEqual(clipped.requestedEnd, { row: 0, column: 16384 });
  assert.equal(clipped.limited, true);
});

test("clipping never splits a surrogate pair or CRLF", () => {
  for (const text of ["abcd🦉xy", "abcd\r\nxy"]) {
    const window = selectPreviewWindow(
      new PieceTree(text),
      { startRow: 0, endRow: 1 },
      { maxUnits: 5 },
    );
    assert.equal(window.text, "abcd");
    assert.equal(window.sourceEndIndex, 4);
    assert.equal(window.limited, true);
  }
  assert.throws(
    () =>
      selectPreviewWindow(new PieceTree("x"), { startRow: 0, endRow: 0 }, { contextUnits: NaN }),
    RangeError,
  );
});

test("preview creation never materializes the real buffer and never replaces its mode", async () => {
  const state = fixture("const x = 1;\n".repeat(10000), {
    modeFactory: (options) => {
      assert.equal(options.parsePriority, -10);
      assert.equal(options.maxIdleParsersPerLanguage, 0);
      assert.ok(options.buffer.getLength() <= 16384);
    },
  });
  try {
    const originalMode = state.source.getLanguageMode();
    state.source.getText = () => assert.fail("Real document was flattened");
    const result = await state.preview.get(state.session, { startRow: 200, endRow: 400 });
    assert.ok(result);
    assert.equal(state.source.getLanguageMode(), originalMode);
    assert.equal(state.session.mode.grammar, state.grammar);
    assert.equal(state.session.revision, 7);
    assert.equal(result.mode, state.modes[0]);
    assert.deepEqual(state.contexts.get(result.buffer)(), {
      session: 1,
      revision: 7,
      scopeName: "source.example",
      bufferLength: state.source.getLength(),
      operation: "preview",
    });
  } finally {
    state.dispose();
  }
});

test("one window is cached per source generation and replacements release the private buffer", async () => {
  const state = fixture("line\n".repeat(100));
  try {
    const first = await state.preview.get(state.session, { startRow: 40, endRow: 45 });
    assert.equal(await state.preview.get(state.session, { startRow: 40, endRow: 45 }), first);
    state.session.generation++;
    const replacement = await state.preview.get(state.session, { startRow: 40, endRow: 45 });
    assert.notEqual(replacement, first);
    assert.equal(first.buffer.isDestroyed(), true);
    assert.equal(first.mode.destroyed, true);
    const moved = await state.preview.get(state.session, { startRow: 70, endRow: 75 });
    assert.equal(replacement.buffer.isDestroyed(), true);
    first.dispose();
    assert.equal(moved.buffer.isDestroyed(), false);
    state.preview.release(state.session.id);
    assert.equal(moved.buffer.isDestroyed(), true);
  } finally {
    state.dispose();
  }
});

test("source edits and source destruction invalidate cached previews without editing the source", async () => {
  const state = fixture("const x = 1;\n");
  try {
    const first = await state.preview.get(state.session, { startRow: 0, endRow: 0 });
    state.source.append("const y = 2;\n");
    assert.equal(first.buffer.isDestroyed(), true);
    const next = await state.preview.get(state.session, { startRow: 0, endRow: 1 });
    state.source.destroy();
    assert.equal(next.buffer.isDestroyed(), true);
    assert.equal(state.preview.entries.size, 0);
  } finally {
    state.dispose();
  }
});

test("cancellation disposes pending work and consumes its late rejection", async () => {
  let rejectReady;
  const state = fixture("x", {
    modeFactory: () => ({
      ready: new Promise((_, reject) => {
        rejectReady = reject;
      }),
    }),
  });
  try {
    const controller = new AbortController();
    const pending = state.preview.get(
      state.session,
      { startRow: 0, endRow: 0 },
      { signal: controller.signal },
    );
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(state.modes[0].destroyed, true);
    assert.equal(state.preview.entries.size, 0);
    rejectReady(new Error("late load failure"));
    await new Promise(setImmediate);
  } finally {
    state.dispose();
  }
});

test("one cancelled waiter does not cancel another viewport sharing the same preview", async () => {
  let ready;
  const state = fixture("x", {
    modeFactory: () => ({
      ready: new Promise((resolve) => {
        ready = resolve;
      }),
    }),
  });
  try {
    const controller = new AbortController();
    const first = state.preview.get(
      state.session,
      { startRow: 0, endRow: 0 },
      { signal: controller.signal },
    );
    const second = state.preview.get(state.session, { startRow: 0, endRow: 0 });
    controller.abort();
    assert.equal(await first, null);
    assert.equal(state.modes[0].destroyed, undefined);
    ready();
    assert.ok(await second);
    assert.equal(state.modes.length, 1);
  } finally {
    state.dispose();
  }
});

test("wall timeout and explicit root-range policies fall back without side effects", async () => {
  const state = fixture("x", {
    timeoutMs: 5,
    modeFactory: () => ({ ready: new Promise(() => {}) }),
  });
  try {
    assert.equal(await state.preview.get(state.session, { startRow: 0, endRow: 0 }), null);
    assert.equal(state.modes[0].destroyed, true);
    state.registry.rootLanguageRangesByBuffer.set(state.source, {});
    assert.equal(await state.preview.get(state.session, { startRow: 0, endRow: 0 }), null);
    assert.equal(state.modes.length, 1);
  } finally {
    state.dispose();
  }
});

test("preview query failures cannot notify or replace the real grammar's queries", async () => {
  let reports = 0;
  let replacements = 0;
  const state = fixture("x", {
    modeFactory: ({ grammar, grammars }) => {
      grammar.reportQueryError(new Error("invalid query"), "highlightsQuery");
      grammar.setQueryForTest("highlightsQuery", "placeholder");
      grammars
        .treeSitterGrammarForLanguageString("injection")
        .reportQueryError(new Error("injected query"));
    },
  });
  state.grammar.reportQueryError = () => reports++;
  state.grammar.setQueryForTest = () => replacements++;
  try {
    assert.equal(await state.preview.get(state.session, { startRow: 0, endRow: 0 }), null);
    assert.equal(reports, 0);
    assert.equal(replacements, 0);
  } finally {
    state.dispose();
  }
});

test("ordinary preview failures fall back while fatal WASM traps still reject", async () => {
  for (const error of [
    new Error("parser load failed"),
    new WebAssembly.RuntimeError("unreachable"),
  ]) {
    const state = fixture("x", { modeFactory: () => ({ ready: Promise.reject(error) }) });
    try {
      const result = state.preview.get(state.session, { startRow: 0, endRow: 0 });
      if (error instanceof WebAssembly.RuntimeError)
        await assert.rejects(result, (caught) => caught === error);
      else assert.equal(await result, null);
      assert.equal(state.modes[0].destroyed, true);
    } finally {
      state.dispose();
    }
  }
});

for (const route of ["ready", "settlement", "lastTransaction"]) {
  test(`preview ${route} preserves shared memory-pressure and fatal recovery signals`, async () => {
    const { SyntaxResourceLimitError } = require("../../src/syntax-resource-policy");
    for (const error of [
      new SyntaxResourceLimitError({
        code: "memory-pressure",
        fatal: false,
        recycle: true,
        session: 1,
        revision: 7,
        operation: "preview",
        message: "Shared WASM memory pressure",
      }),
      new WebAssembly.RuntimeError("unreachable"),
      Object.assign(new Error("shared runtime failure"), { failure: { fatal: true, session: 1 } }),
    ]) {
      const state = fixture("x", {
        modeFactory: () =>
          route === "ready"
            ? { ready: Promise.reject(error) }
            : route === "settlement"
              ? { atGrammarSettlement: () => Promise.resolve({ parseError: error }) }
              : { lastTransactionParseError: error },
      });
      try {
        await assert.rejects(
          state.preview.get(state.session, { startRow: 0, endRow: 0 }),
          (caught) => caught === error,
        );
        assert.equal(state.modes[0].destroyed, true);
        assert.equal(state.preview.entries.size, 0);
        if (error.failure?.code === "memory-pressure") {
          assert.equal(error.failure.session, 1);
          assert.equal(error.failure.operation, "preview");
        }
      } finally {
        state.dispose();
      }
    }
  });
}

test("ordinary preview settlement failures still fall back without disabling exact analysis", async () => {
  const state = fixture("x", {
    modeFactory: () => ({
      atGrammarSettlement: () =>
        Promise.resolve({ parseError: new Error("local preview grammar failed") }),
    }),
  });
  try {
    assert.equal(await state.preview.get(state.session, { startRow: 0, endRow: 0 }), null);
    assert.equal(state.modes[0].destroyed, true);
    assert.equal(state.session.closed, undefined);
  } finally {
    state.dispose();
  }
});

test("a real bounded JavaScript preview preserves local scope coordinates and leaves the exact source untouched", async () => {
  const Host = require("../../src/syntax-worker-host");
  const { configuration } = require("../../src/syntax-worker-environment");
  const LanguageMode = require("../../src/tree-sitter-language-mode");
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
  const grammar = host.grammars.grammarForScopeName("source.js");
  const text =
    "const preceding = 0;\n".repeat(40) +
    'function hello() {\n  const value = "🦉";\n  return value + 3;\n}\n';
  const source = new TextBuffer({ text });
  const exact = new LanguageMode({
    buffer: source,
    grammar,
    grammars: host.grammars,
    config: host.config,
    queryBudget: { now: () => 0 },
  });
  source.setLanguageMode(exact);
  const previews = new SyntaxPreview({
    grammars: host.grammars,
    config: host.config,
    timeoutMs: 1000,
    createMode: (options) =>
      new LanguageMode({
        ...options,
        queryBudget: { ...options.queryBudget, now: () => 0 },
      }),
  });
  try {
    await exact.ready;
    await exact.atGrammarSettlement();
    const session = {
      id: 90,
      revision: 0,
      generation: 0,
      buffer: source,
      mode: { grammar, publicationPending: true },
    };
    const preview = await previews.get(session, { startRow: 40, endRow: 43 });
    assert.ok(preview);
    assert.equal(preview.startRow, 20);
    for (const [row, column] of [
      [40, 1],
      [41, 18],
      [42, 17],
    ]) {
      const expected = exact.scopeDescriptorForPosition(new TextBuffer.Point(row, column)).scopes;
      const actual = preview.mode.scopeDescriptorForPosition(
        new TextBuffer.Point(row - preview.startRow, column),
      ).scopes;
      assert.deepEqual(actual, expected);
    }
    assert.equal(source.getLanguageMode(), exact);
    assert.equal(source.getText(), text);
  } finally {
    previews.dispose();
    source.destroy();
    host.close();
  }
});

test("real HTML previews keep JavaScript injections inside their private local document", async () => {
  const Host = require("../../src/syntax-worker-host");
  const { configuration } = require("../../src/syntax-worker-environment");
  const LanguageMode = require("../../src/tree-sitter-language-mode");
  const host = new Host();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const definitions = [
    "language-html/grammars/html.json",
    "language-javascript/grammars/javascript.json",
  ].map((name) => {
    const file = require.resolve(name);
    return { file, definition: require("@lumine-code/season").readFileSync(file) };
  });
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars: definitions,
    modules: [],
    specMode: true,
  });
  const grammar = host.grammars.grammarForScopeName("text.html.basic");
  const text = "<p>preceding</p>\n".repeat(40) + '<script>\n  const value = "🦉";\n</script>\n';
  const source = new TextBuffer({ text });
  const exact = new LanguageMode({
    buffer: source,
    grammar,
    grammars: host.grammars,
    config: host.config,
    queryBudget: { now: () => 0 },
  });
  source.setLanguageMode(exact);
  const previews = new SyntaxPreview({
    grammars: host.grammars,
    config: host.config,
    timeoutMs: 1000,
    createMode: (options) =>
      new LanguageMode({
        ...options,
        queryBudget: { ...options.queryBudget, now: () => 0 },
      }),
  });
  try {
    await exact.ready;
    await exact.atGrammarSettlement();
    const session = {
      id: 91,
      revision: 0,
      generation: 0,
      buffer: source,
      mode: { grammar, publicationPending: true },
    };
    const preview = await previews.get(session, { startRow: 40, endRow: 42 });
    assert.ok(preview);
    assert.ok(
      preview.mode.getAllLanguageLayers().some((layer) => layer?.grammar.scopeName === "source.js"),
    );
    assert.deepEqual(
      preview.mode.scopeDescriptorForPosition(new TextBuffer.Point(41 - preview.startRow, 18))
        .scopes,
      exact.scopeDescriptorForPosition(new TextBuffer.Point(41, 18)).scopes,
    );
    assert.equal(source.getLanguageMode(), exact);
    assert.equal(source.getText(), text);
  } finally {
    previews.dispose();
    source.destroy();
    host.close();
  }
});
