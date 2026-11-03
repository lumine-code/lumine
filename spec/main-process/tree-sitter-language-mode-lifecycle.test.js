const test = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");

async function fixture(t) {
  const host = new Host();
  t.after(() => host.close());
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
  await host.dispatch("append", { session: 1, text: "const answer = 42;\n" });
  return { host, data, grammar: host.grammars.grammarForScopeName(definition.scopeName) };
}

function observe(mode) {
  return [
    mode.onDidTokenize(() => {}),
    mode.onDidChangeHighlighting(() => {}),
    mode.onDidUseInjectionGrammar(() => {}),
  ];
}

test("closing a parsed syntax document releases external event subscriptions and owned resources", async (t) => {
  const { host, data } = await fixture(t);
  await host.dispatch("initialize", data);
  await host.dispatch("settle", data);
  const mode = host.sessions.get(1).mode;
  const layer = mode.rootLanguageLayer;
  const subscriptions = observe(mode);
  assert.ok(layer.tree);
  assert.ok(mode.document.textSnapshot);

  host.closeSession(1);

  assert.ok(subscriptions.every((subscription) => subscription.disposed));
  assert.equal(mode.document.textSnapshot, null);
  assert.equal(layer.destroyed, true);
  assert.equal(layer.tree, null);
  assert.equal(mode.rootLanguageLayer, null);
  assert.equal(mode.parsersByLanguage.size, 0);
  assert.doesNotThrow(() => mode.destroy());
});

test("closing during grammar loading releases subscribers before readiness and creates no parser", async (t) => {
  const { host, data, grammar } = await fixture(t);
  const language = await grammar.getLanguage();
  let release;
  const loading = new Promise((resolve) => (release = resolve));
  t.mock.method(grammar, "getLanguage", () => loading);
  await host.dispatch("initialize", data);
  const mode = host.sessions.get(1).mode;
  const subscriptions = observe(mode);
  const createParser = t.mock.method(mode, "createParserForLanguage");
  try {
    host.closeSession(1);
    assert.ok(subscriptions.every((subscription) => subscription.disposed));
  } finally {
    release(language);
    await mode.ready;
  }
  assert.equal(createParser.mock.callCount(), 0);
  assert.equal(mode.rootLanguageLayer, null);
  assert.equal(mode.parsersByLanguage.size, 0);
});
