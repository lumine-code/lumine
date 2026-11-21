const { test } = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: nextTurn } = require("node:timers/promises");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const season = require("@lumine-code/season");

async function setup(t, text, blocked, configure) {
  const host = new Host();
  t.after(() => host.close());
  const grammars = ["html", "javascript", "css"].map((language) => {
    const file = require.resolve(`language-${language}/grammars/${language}.json`);
    return { file, definition: season.readFileSync(file) };
  });
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  await host.dispatch("environment", {
    version: 1,
    configuration: configuration(host.config),
    grammars,
    modules: [],
    specMode: true,
  });
  const { scopeName } = grammars[0].definition;
  configure?.(host.grammars, scopeName);

  let release, start;
  const gate = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (start = resolve));
  t.after(release);
  const install = host.installMode.bind(host);
  t.mock.method(host, "installMode", (session) => {
    install(session);
    const { mode } = session;
    mode.queryBudget = { now: () => 0 };
    const parse = mode.parseAsync.bind(mode);
    t.mock.method(mode, "parseAsync", async (language, tree, ranges, options) => {
      if (blocked(options?.scopeName, ranges)) {
        start();
        await gate;
      }
      return parse(language, tree, ranges, options);
    });
  });
  const data = { session: 1, revision: 0, scopeName, path: "example.html" };
  await host.dispatch("open", data);
  await host.dispatch("append", { session: 1, text });
  await host.dispatch("initialize", data);
  return { host, data, started, release, mode: host.sessions.get(1).mode };
}

async function paint(host, data, row, { signal, optional = false } = {}) {
  const packets = [];
  const result = await host.dispatch(
    "view",
    { ...data, ranges: [[row, row]], optional, stream: true },
    { signal, emit: (packet) => packets.push(packet) },
  );
  return { packets, result };
}

test(
  "a viewport paints its nested injections while an unrelated child parser is pending",
  { timeout: 10000 },
  async (t) => {
    const padding = "<p>Unrelated markup</p>\n".repeat(150);
    const { host, data, started, release, mode } = await setup(
      t,
      `<script>const distant = 99;</script>\n${padding}<script>const theme = css\`a { color: #fff; }\`;</script>\n`,
      (scope, ranges) => scope === "source.js" && ranges?.[0].startPosition.row === 0,
    );
    let settled = false;
    const whole = host.dispatch("settle", data).then((result) => {
      settled = true;
      return result;
    });
    const highlights = [];
    host.notify = (event) => {
      if (event.event === "highlight") highlights.push(event);
    };

    await started;
    const early = await paint(host, data, 151);
    assert.equal(early.result.syntaxReady, false);
    assert.deepEqual(early.result.value, { syntaxReady: false });
    assert.equal(early.packets.at(-1).quality, "exact");
    assert.ok(
      early.packets.flatMap((packet) => packet.names).some(([, name]) => name === "source.css"),
    );
    assert.equal(settled, false);

    const controller = new AbortController();
    const blocked = assert.rejects(paint(host, data, 0, { signal: controller.signal }), {
      name: "AbortError",
    });
    await nextTurn();
    assert.equal(mode.highlightRangeWaiters.size, 1);
    controller.abort();
    await blocked;
    assert.equal(mode.highlightRangeWaiters.size, 0);

    release();
    assert.equal((await whole).syntaxReady, true);
    assert.ok(highlights.some(({ reconciled }) => reconciled));
    assert.deepEqual((await paint(host, data, 151)).packets, early.packets);
  },
);

test(
  "dynamic content that escapes its owner retains whole-forest readiness",
  { timeout: 10000 },
  async (t) => {
    const source = "<p>let near = 42;</p>\n" + "<section></section>\n".repeat(130);
    const { host, data, started, release, mode } = await setup(
      t,
      source,
      (scope) => scope === "source.js",
      (registry, scopeName) =>
        registry.grammarForScopeName(scopeName).addInjectionPoint({
          type: "element",
          language: "javascript",
          content: (node) =>
            node.startPosition.row === 130
              ? node.parent.namedChild(0).namedChildren.find((child) => child.type === "text")
              : null,
        }),
    );
    await started;
    assert.equal(mode.hasExternalInjectionContent, true);
    let published = false;
    const pending = paint(host, data, 0).then((result) => {
      published = true;
      return result;
    });
    await nextTurn();
    assert.equal(published, false);
    release();
    assert.equal((await pending).result.syntaxReady, true);
  },
);

test(
  "an edit in a distant script can settle visible markup independently",
  { timeout: 10000 },
  async (t) => {
    const source =
      "<h1>Visible markup</h1>\n" +
      "<p>Unrelated text</p>\n".repeat(130) +
      "<script>const distant = 99;</script>\n";
    let holdScript = false;
    const { host, data, started, release, mode } = await setup(
      t,
      source,
      (scope) => holdScript && scope === "source.js",
    );
    await host.dispatch("settle", data);
    t.mock.method(mode, "shouldParseSynchronously", () => false);
    holdScript = true;
    const startIndex = source.indexOf("99");
    await host.dispatch("edit", {
      session: data.session,
      beforeRevision: data.revision,
      revision: 1,
      changes: [{ startIndex, oldEndIndex: startIndex + 2, text: "42" }],
    });
    await started;

    const current = { ...data, revision: 1 };
    const early = await paint(host, current, 0);
    assert.equal(early.result.syntaxReady, false);
    assert.equal(early.packets.at(-1).quality, "exact");
    release();
    assert.equal((await host.dispatch("settle", current)).syntaxReady, true);
    assert.deepEqual((await paint(host, current, 0)).packets, early.packets);
  },
);

test(
  "an offscreen descendant cannot extend its parser beyond its ancestor's included ranges",
  { timeout: 10000 },
  async (t) => {
    const source = "<p>Unrelated text</p>\n".repeat(130) + "<script>const distant = 99;</script>\n";
    let callbackCalled = false;
    const { host, data, started, release, mode } = await setup(
      t,
      source,
      (scope) => scope === "source.js",
      (registry) =>
        registry.grammarForScopeName("source.js").addInjectionPoint({
          type: "variable_declarator",
          language: "css",
          content: () => {
            callbackCalled = true;
            return {
              startIndex: 0,
              endIndex: 5,
              startPosition: { row: 0, column: 0 },
              endPosition: { row: 0, column: 5 },
              childCount: 0,
            };
          },
        }),
    );
    await started;
    const early = await paint(host, data, 0);
    assert.equal(early.packets.at(-1).quality, "exact");
    assert.equal(early.result.syntaxReady, false);
    assert.equal(callbackCalled, false);
    release();
    await host.dispatch("settle", data);
    assert.equal(callbackCalled, true);
    assert.equal(mode.getAllInjectionLayers().length, 1);
    assert.deepEqual((await paint(host, data, 0)).packets, early.packets);
  },
);

test(
  "a visible combined injection waits for the parser covering all of its members",
  { timeout: 10000 },
  async (t) => {
    const source =
      "<!--let a = 1;-->\n" + "<p>Unrelated text</p>\n".repeat(130) + "<!--let b = 2;-->\n";
    const { host, data, started, release, mode } = await setup(
      t,
      source,
      (scope, ranges) => scope === "source.js" && ranges?.length === 2,
      (registry, scopeName) =>
        registry.grammarForScopeName(scopeName).addInjectionPoint({
          type: "comment",
          language: "javascript",
          combined: true,
          content: (node) => ({
            startIndex: node.startIndex + 4,
            endIndex: node.endIndex - 3,
            startPosition: { row: node.startPosition.row, column: node.startPosition.column + 4 },
            endPosition: { row: node.endPosition.row, column: node.endPosition.column - 3 },
            childCount: 0,
          }),
        }),
    );
    await started;
    let published = false;
    const pending = paint(host, data, 0).then((result) => {
      published = true;
      return result;
    });
    await nextTurn();
    assert.equal(published, false);
    release();
    const { packets } = await pending;
    assert.equal(packets.at(-1).quality, "exact");
    assert.ok(packets.flatMap((packet) => packet.names).some(([, name]) => name === "source.js"));
    assert.equal(mode.getAllInjectionLayers().length, 1);
  },
);
