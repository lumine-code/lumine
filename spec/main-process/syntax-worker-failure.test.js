const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const Config = require("../../src/config");
const GrammarRegistry = require("../../src/grammar-registry");
const Grammar = require("../../src/tree-sitter-grammar");
const Service = require("../../src/syntax-worker-service");
const Client = require("../../src/syntax-worker-client");
const Mode = require("../../src/tree-sitter-worker-language-mode");
const TextBuffer = require("../../src/text-buffer");
const analyze = require("../../src/buffer-syntax-analysis");
const processor = path.resolve(__dirname, "../fixtures/syntax-worker-analysis.js");

function setup() {
  const config = new Config();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    config.setSchema(key, schema);
  const grammars = new GrammarRegistry({ config });
  const warnings = [],
    clients = [],
    workers = [],
    buffers = [];
  const previous = globalThis.lumine;
  globalThis.lumine = {
    config,
    window: { isSpecMode: () => true, isDevMode: () => false },
    notifications: {
      addWarning(message, options) {
        const warning = {
          message,
          options,
          dismissed: false,
          dismiss() {
            this.dismissed = true;
          },
        };
        warnings.push(warning);
        return warning;
      },
    },
  };
  const file = require.resolve("language-javascript/grammars/javascript.json");
  const grammar = new Grammar(grammars, file, require("@lumine-code/season").readFileSync(file));
  grammars.addGrammar(grammar);
  let stderr = "";
  const service = new Service(grammars, {
    clientFactory() {
      // A real, deliberately small WASM memory exercises allocation failure
      // without requiring gigabytes of RAM in CI. The production limit is unchanged.
      const source = `
        const {parentPort} = require('node:worker_threads');
        const runtime = require(${JSON.stringify(require.resolve("../../src/tree-sitter-runtime"))});
        runtime.maximumPages = 512;
        const port = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
        require(${JSON.stringify(require.resolve("../../src/syntax-worker-bootstrap"))}).connect(port);
        parentPort.on('message', data => port.onmessage({data}));
      `;
      const worker = new Worker(source, { eval: true, stderr: true });
      workers.push(worker);
      worker.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const transport = {
        postMessage: (data, transfer) => worker.postMessage(data, transfer),
        terminate: () => {
          void worker.terminate();
        },
      };
      worker.on("message", (data) => transport.onmessage?.({ data }));
      worker.on("error", (error) =>
        transport.onerror?.({ message: error.message, preventDefault() {} }),
      );
      const client = new Client({ workerFactory: () => transport });
      clients.push(client);
      return client;
    },
  });
  return {
    service,
    grammar,
    warnings,
    clients,
    get stderr() {
      return stderr;
    },
    open(text) {
      const buffer = new TextBuffer({ text });
      buffers.push(buffer);
      const mode = new Mode({ buffer, grammar, service });
      buffer.setLanguageMode(mode);
      return { buffer, mode };
    },
    async close() {
      for (const buffer of buffers) buffer.destroy();
      service.dispose();
      grammar.subscriptions.dispose();
      grammars.clear();
      await Promise.all(workers.map((worker) => worker.terminate()));
      globalThis.lumine = previous;
    },
  };
}

async function waitFor(condition) {
  const until = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > until) throw new Error("Timed out waiting for syntax recovery");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "real WASM exhaustion quarantines only its document, settles waiters and recovers a neighbour",
  { timeout: 30000 },
  async () => {
    const app = setup();
    try {
      const small = app.open("const healthy = 1;\n");
      await small.mode.ready;
      const large = app.open("const value = [1, 2, 3];\n".repeat(90000));
      const pending = analyze(large.buffer, processor, "summary");
      await waitFor(() => large.buffer.getLanguageMode().syntaxAvailability?.available === false);
      assert.equal(await pending, null);
      const fallback = large.buffer.getLanguageMode();
      assert.equal(fallback.grammar, app.grammar);
      assert.equal(fallback.syntaxAvailability.failure.code, "memory-limit");
      assert.equal(fallback.syntaxAvailability.failure.session, large.mode.session.id);
      assert.equal(fallback.syntaxAvailability.failure.memoryBytes, 32 * 1024 * 1024);
      assert.equal(app.warnings.length, 1);
      assert.equal(app.clients.length, 2);
      assert.equal(app.clients[0].closed, true);
      assert.equal(app.service.sessions.size, 1);
      await app.service.settle(small.mode.session);
      assert.equal(
        (await analyze(small.buffer, processor, "summary")).text,
        small.buffer.getText(),
      );
      small.buffer.append("const next = 2;\n");
      assert.equal(
        (await analyze(small.buffer, processor, "summary")).text,
        small.buffer.getText(),
      );
      large.buffer.setText("const repaired = 3;\n");
      assert.equal(await analyze(large.buffer, processor, "summary"), null);
      assert.equal(app.service.sessions.size, 1);
      assert.equal(app.warnings.length, 1);
      assert.equal(app.stderr, "");
      assert.equal(fallback.retrySyntaxAnalysis(), true);
      await large.buffer.getLanguageMode().ready;
      assert.equal(
        (await analyze(large.buffer, processor, "summary")).text,
        large.buffer.getText(),
      );
      assert.equal(app.warnings[0].dismissed, true);
    } finally {
      await app.close();
    }
  },
);

test(
  "analysis module errors remain errors and do not disable the parser",
  { timeout: 15000 },
  async () => {
    const app = setup();
    try {
      const { buffer, mode } = app.open("const value = 1;");
      await mode.ready;
      await assert.rejects(analyze(buffer, processor, "missingMethod"), /Unknown syntax analysis/);
      await assert.rejects(analyze(buffer, processor, "illegalNode"), /cannot return syntax nodes/);
      assert.equal(buffer.getLanguageMode(), mode);
      assert.equal(app.warnings.length, 0);
      assert.equal(app.clients.length, 1);
      assert.equal((await analyze(buffer, processor, "summary")).text, buffer.getText());
    } finally {
      await app.close();
    }
  },
);

test(
  "a WebAssembly trap in analysis is attributed without calling it an allocation failure",
  { timeout: 15000 },
  async () => {
    const app = setup();
    try {
      const { buffer, mode } = app.open("const value = 1;");
      await mode.ready;
      assert.equal(await analyze(buffer, processor, "wasmTrap"), null);
      const failure = buffer.getLanguageMode().syntaxAvailability.failure;
      assert.equal(failure.code, "wasm-failure");
      assert.equal(failure.operation, "analyze");
      assert.equal(failure.session, mode.session.id);
      assert.equal(app.warnings.length, 1);
      assert.equal(app.service.client, null);
      assert.equal(app.stderr, "");
    } finally {
      await app.close();
    }
  },
);

test(
  "ordinary grammar failures disable analysis once and retry uses current text",
  { timeout: 15000 },
  async () => {
    const app = setup();
    const wasm = app.grammar.definition.treeSitter.grammar;
    try {
      app.grammar.definition.treeSitter.grammar = "missing-failure-test.wasm";
      const { buffer } = app.open("const value = 1;");
      assert.equal(await analyze(buffer, processor, "summary"), null);
      const fallback = buffer.getLanguageMode();
      assert.equal(fallback.syntaxAvailability.available, false);
      assert.equal(fallback.syntaxAvailability.failure.fatal, false);
      assert.equal(app.warnings.length, 1);
      app.grammar.definition.treeSitter.grammar = wasm;
      app.service.invalidateEnvironment();
      buffer.setText("const repaired = 2;");
      assert.equal(buffer.getLanguageMode(), fallback);
      fallback.retrySyntaxAnalysis();
      await buffer.getLanguageMode().ready;
      assert.equal((await analyze(buffer, processor, "summary")).text, buffer.getText());
      assert.equal(app.warnings.length, 1);
    } finally {
      app.grammar.definition.treeSitter.grammar = wasm;
      await app.close();
    }
  },
);
