const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Tree } = require("web-tree-sitter");
const Host = require("../../src/syntax-worker-host");
const Client = require("../../src/syntax-worker-client");
const Endpoint = require("../../src/syntax-worker-endpoint");
const Parser = require("../../src/tree-sitter-parser");
const IndentResolver = require("../../src/tree-sitter-indent-resolver");
const captureQuery = require("../../src/tree-sitter-query-cache");
const { SyntaxResourceLimitError } = require("../../src/syntax-resource-policy");
const { configuration } = require("../../src/syntax-worker-environment");

const counts = [1, 2, 8, 32, 128, 129];

function fixture(kind, count, { ipython = false, fallback = false } = {}) {
  const newline = ipython ? "\r\n" : "\n";
  const padding = Array.from({ length: 24 }, (_, index) => `padding_${index} = ${index}`);
  const targets = Array.from({ length: 129 }, (_, index) =>
    kind === "noop"
      ? `value_${index} = ${index}`
      : `${kind === "chain" && index ? "elif" : "if"} flag_${index}: work_${index}()`,
  );
  const prefix = [...(ipython ? ["# %% public scaling fixture"] : []), ...padding];
  const lines = [...prefix, ...targets, ...padding];
  const source = lines.join(newline) + newline;
  const chosen =
    count === 1
      ? [0]
      : Array.from({ length: count }, (_, index) => Math.floor((index * 128) / (count - 1)));
  const insertion = fallback ? `${newline}# inserted comment${newline}` : newline;
  const changes = [],
    rows = [];
  let delta = 0;
  for (const [order, index] of chosen.entries()) {
    const row = prefix.length + index;
    const column = kind === "noop" ? targets[index].length : targets[index].indexOf(": ") + 2;
    const startIndex =
      lines.slice(0, row).reduce((total, line) => total + line.length + newline.length, 0) +
      column +
      delta;
    changes.push({ startIndex, oldEndIndex: startIndex, text: insertion });
    rows.push(row + (fallback ? 2 : 1) * (order + 1));
    delta += insertion.length;
  }
  return {
    source,
    changes,
    ranges: rows.map((row) => [row, row]),
    expected: rows.map((row) => [row, kind === "noop" ? 0 : 1]),
    options: {
      isPastedText: false,
      softTabs: true,
      rowOptions: new Map(
        rows.map((row) => [row, { preserveLeadingWhitespace: true, skipBlankLines: false }]),
      ),
    },
  };
}

async function setup(text, ipython) {
  const host = new Host();
  try {
    for (const [key, schema] of Object.entries(require("../../src/config-schema")))
      host.config.setSchema(key, schema);
    const files = ipython
      ? ["language-ipython/grammars/ipython.json", "language-python/grammars/python.json"]
      : ["language-python/grammars/python.json"];
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
      path: "scaling",
    };
    await host.dispatch("open", data);
    await host.dispatch("append", { session: 1, text });
    await host.dispatch("initialize", data);
    await host.dispatch("settle", data);
    return { host, data };
  } catch (error) {
    host.close();
    throw error;
  }
}

// Count semantic parse jobs, not resumptions: tryParseSync and parse can enter
// beginCurrent twice for the same job, and one job can have many native slices.
function observePrivateParses(t) {
  const jobs = new Set(),
    completed = new Set();
  const begin = Parser.prototype.beginCurrent,
    step = Parser.prototype.stepCurrent;
  t.mock.method(Parser.prototype, "beginCurrent", function (...args) {
    const job = begin.apply(this, args);
    if (job.runtimeContext?.session !== 1) jobs.add(job);
    return job;
  });
  t.mock.method(Parser.prototype, "stepCurrent", function (job, ...args) {
    const tree = step.call(this, job, ...args);
    if (tree && job.runtimeContext?.session !== 1) completed.add(job);
    return tree;
  });
  return { jobs, completed };
}

async function plan(host, data, input, { signal } = {}) {
  const target = 2;
  try {
    if (input.ranges.length <= 128) {
      const result = await host.dispatch(
        "input-indent",
        { ...data, ...input, target, inline: true, tabLength: 4 },
        { signal },
      );
      return result.value.levels;
    }
    // Exercise the actual large-input protocol, including initialization before
    // the streaming operation; compact input cannot silently bypass its limit.
    await host.dispatch("fork", { ...data, target }, { signal });
    await host.dispatch(
      "edit",
      { session: target, beforeRevision: 0, revision: 1, changes: input.changes },
      { signal },
    );
    await host.dispatch(
      "initialize",
      { session: target, indentationRanges: input.ranges, indentationOptions: input.options },
      { signal },
    );
    const levels = [];
    await host.dispatch(
      "prepared-indent",
      {
        session: target,
        revision: 1,
        ranges: input.ranges,
        inline: false,
        tabLength: 4,
        options: input.options,
      },
      { signal, emit: (batch) => levels.push(...batch) },
    );
    return levels;
  } finally {
    host.closeSession(target);
  }
}

for (const ipython of [false, true])
  for (const kind of ["chain", "independent", "noop"])
    for (const count of counts)
      test(`${ipython ? "IPython CRLF" : "Python"} ${kind} input at ${count} cursors does not parse a candidate`, async (t) => {
        const input = fixture(kind, count, { ipython });
        const { host, data } = await setup(input.source, ipython);
        try {
          const parent = host.sessions.get(1);
          const tree = parent.mode.rootLanguageLayer.backgroundTree;
          const originalSyntax = tree.rootNode.toString();
          const observed = observePrivateParses(t);
          assert.deepEqual(await plan(host, data, input), input.expected);
          assert.equal(
            observed.jobs.size,
            0,
            "Whitespace input must project the saved forest without starting a parse job",
          );
          assert.equal(observed.completed.size, 0);
          assert.equal(parent.buffer.getText(), input.source);
          assert.equal(parent.mode.rootLanguageLayer.backgroundTree, tree);
          assert.equal(tree.rootNode.toString(), originalSyntax);
          assert.equal(host.sessions.size, 1);
          assert.equal(parent.forks?.size ?? 0, 0);
        } finally {
          host.close();
        }
      });

for (const count of [1, 32, 129])
  test(`non-whitespace fallback at ${count} cursors parses one private revision`, async (t) => {
    const input = fixture("noop", count, { fallback: true });
    const { host, data } = await setup(input.source, false);
    try {
      const observed = observePrivateParses(t);
      assert.deepEqual(await plan(host, data, input), input.expected);
      assert.equal(
        observed.jobs.size,
        1,
        "Fallback must batch all source edits into one parse job",
      );
      assert.equal(observed.completed.size, 1);
      assert.equal(host.sessions.size, 1);
      assert.equal(host.sessions.get(1).buffer.getText(), input.source);
    } finally {
      host.close();
    }
  });

for (const abortDuringQuery of [false, true])
  test(`projected input releases query caches ${abortDuringQuery ? "after cancellation" : "after a complete plan"} without copying native trees`, async (t) => {
    const input = fixture("chain", 32, { ipython: true });
    const { host, data } = await setup(input.source, true);
    const owners = new Set();
    const controller = new AbortController();
    const observed = observePrivateParses(t);
    const copies = t.mock.method(Tree.prototype, "copy", () => {
      assert.fail("Projected typing must borrow the original native forest");
    });
    const query = IndentResolver.prototype.captureQuery;
    t.mock.method(IndentResolver.prototype, "captureQuery", function (owner, ...args) {
      const captures = query.call(this, owner, ...args);
      if (this.languageMode.indentationOnly && captureQuery.getStats(owner).entries > 0) {
        owners.add(owner);
        if (abortDuringQuery && !controller.signal.aborted)
          controller.abort(
            Object.assign(new Error("Cancelled after a private query populated its cache"), {
              name: "AbortError",
            }),
          );
      }
      return captures;
    });
    try {
      const parentNode = host.sessions.get(1).mode.rootLanguageLayer.backgroundTree.rootNode;
      const pending = plan(host, data, input, { signal: controller.signal });
      if (abortDuringQuery) await assert.rejects(pending, { name: "AbortError" });
      else assert.deepEqual(await pending, input.expected);
      assert.ok(owners.size > 0, "The request must have populated a private query cache");
      for (const owner of owners) {
        assert.equal(captureQuery.getStats(owner).entries, 0);
        assert.equal(captureQuery.getStats(owner).captures, 0);
        assert.equal(owner.destroyed, true);
      }
      assert.equal(copies.mock.callCount(), 0);
      assert.equal(observed.jobs.size, 0);
      assert.equal(observed.completed.size, 0);
      assert.ok(parentNode.text.startsWith("# %%"));
      assert.equal(host.sessions.size, 1);
      assert.equal(host.sessions.get(1).buffer.getText(), input.source);
    } finally {
      host.close();
    }
  });

test("a private fallback resource error preserves its typed reason over the worker transport", async (t) => {
  const input = fixture("noop", 2, { fallback: true });
  const { host, data } = await setup(input.source, false);
  const step = Parser.prototype.stepCurrent;
  t.mock.method(Parser.prototype, "stepCurrent", function (job, ...args) {
    if (job.runtimeContext?.session !== 1)
      throw new SyntaxResourceLimitError({
        code: "parse-budget",
        fatal: false,
        message: "Controlled private parse budget failure",
      });
    return step.call(this, job, ...args);
  });
  let endpoint;
  const worker = {
    postMessage: (message) => queueMicrotask(() => endpoint.receive(structuredClone(message))),
    terminate: () => endpoint.close(),
  };
  const client = new Client({ workerFactory: () => worker });
  endpoint = new Endpoint({
    dispatch: (_operation, _payload, options) => plan(host, data, input, options),
    send: (message) => queueMicrotask(() => worker.onmessage({ data: structuredClone(message) })),
  });
  try {
    await assert.rejects(client.request("input", {}), (error) => {
      assert.notEqual(error.name, "AbortError", "A resource failure is not an input cancellation");
      assert.ok(
        error.code === "parse-budget" ||
          error.reason === "parse-budget" ||
          error.reason?.code === "parse-budget",
        "Resource failure must remain distinguishable after error serialization",
      );
      return true;
    });
    assert.equal(host.sessions.size, 1);
    assert.equal(host.sessions.get(1).buffer.getText(), input.source);
    assert.equal(host.sessions.get(1).failure, undefined);
  } finally {
    client.close();
    host.close();
  }
});
