const { test } = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const rules = require("../../src/typing-indentation-rules");

async function setup() {
  const host = new Host();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const file = require.resolve("language-python/grammars/python.json");
  const definition = require("@lumine-code/season").readFileSync(file);
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars: [{ file, definition }],
    modules: [],
    specMode: true,
  });
  const data = { session: 1, revision: 9, scopeName: definition.scopeName, path: "example.py" };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text: "class Record:" });
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  return { host, data };
}

test("small prepared input uses one request, keeps the parent revision and releases its fork", async () => {
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
        options: {
          isPastedText: false,
          rowOptions: new Map([[1, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
        },
      },
      { emit: (batch) => rows.push(...batch) },
    );
    assert.deepEqual(rows, [[1, 1]]);
    assert.equal(result.revision, 9);
    assert.equal(host.sessions.size, 1);
    assert.equal(host.sessions.get(1).buffer.getText(), "class Record:");
    assert.equal(host.sessions.get(1).forks.size, 0);
  } finally {
    host.close();
  }
});

test("typing filter proves ordinary Python text cannot dedent and retains keywords and delimiters", async () => {
  const { host, data } = await setup();
  try {
    const metadata = (await host.dispatch("settle", data)).value;
    assert.ok(Array.isArray(metadata.typingIndentationRules));
    for (const value of ["hello", "field = 123", "els", "elsewhere"])
      assert.equal(rules.mayMatch(metadata.typingIndentationRules, value), false, value);
    for (const value of ["else", "elif", "case", "except Error", ")", "]", "}"])
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
