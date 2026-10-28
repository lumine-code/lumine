const assert = require("node:assert/strict");
const { test } = require("node:test");
const TextBuffer = require("../../src/text-buffer");
const { paintWindows, windowTile, MAX_UNITS } = require("../../src/syntax-paint-window");
const Host = require("../../src/syntax-worker-host");
const { configuration } = require("../../src/syntax-worker-environment");
const Cache = require("../../src/tree-sitter-highlight-cache");
const { Point } = TextBuffer;

test("column windows bound source work without splitting CRLF or surrogate pairs", () => {
  for (const middle of ["\r\n", "🦉"]) {
    const text = "x".repeat(MAX_UNITS - 1) + middle + "z".repeat(10000);
    const buffer = new TextBuffer(text);
    try {
      const windows = paintWindows(buffer, [0, 0], buffer.getEndPosition());
      assert.equal(windows.length, 3);
      assert.deepEqual(windows[0].end, new Point(0, MAX_UNITS - 1));
      assert.equal(windows.map((w) => buffer.getTextInRange([w.start, w.end])).join(""), text);
      for (const w of windows) {
        assert.ok(
          buffer.characterIndexForPosition(w.end) - buffer.characterIndexForPosition(w.start) <=
            MAX_UNITS,
        );
        assert.ok(windowTile(buffer, w));
      }
    } finally {
      buffer.destroy();
    }
  }
});

test("copied source-limited paint never becomes proof of a prepared column window", () => {
  const cache = new Cache();
  cache.replace(
    [{ start: new Point(0, 0), end: new Point(0, 50000), scopes: [1], events: [], bounded: false }],
    {},
  );
  const copied = cache.captureRange(new Point(0, 20000), new Point(0, 22000), new Point(1, 0), []);
  assert.equal(copied[0].bounded, false);
  cache.replace(copied, null, () => true);
  assert.equal(
    cache.covers(new Point(1, 0), new Point(1, 2000), null, (s) => s.bounded !== false),
    false,
  );
});

test("a long-line column query uses the full tree and returns exact scopes far beyond the prefix", async () => {
  const host = new Host();
  for (const [key, schema] of Object.entries(require("../../src/config-schema")))
    host.config.setSchema(key, schema);
  const file = require.resolve("language-javascript/grammars/javascript.json");
  const definition = require("@lumine-code/season").readFileSync(file);
  try {
    await host.dispatch("environment", {
      version: 1,
      configuration: configuration(host.config),
      grammars: [{ file, definition }],
      modules: [],
      specMode: true,
    });
    const data = { session: 1, revision: 0, scopeName: definition.scopeName, path: "wide.js" };
    await host.dispatch("open", data);
    await host.dispatch("append", { session: 1, text: 'const value = "text"; '.repeat(18000) });
    await host.dispatch("initialize", data);
    await host.dispatch("settle", data);
    const session = host.sessions.get(1);
    session.mode.queryBudget = { now: () => 0 };
    const ranges = paintWindows(session.buffer, [0, 200000], [0, 210000]);
    const result = await host.dispatch("view", { ...data, ranges });
    assert.equal(result.value.tiles.length, 2);
    assert.ok(
      result.value.tiles.every((t) => t.quality === "exact" && t.window && t.reason == null),
    );
    assert.deepEqual(result.value.tiles[0].start, { row: 0, column: 200000 });
    assert.deepEqual(result.value.tiles.at(-1).end, { row: 0, column: 210000 });
    assert.ok(result.value.scopes.some(([, name]) => name.includes("string")));
    assert.ok(result.value.scopes.some(([, name]) => /keyword|storage/.test(name)));
    for (const tile of result.value.tiles)
      for (const event of tile.events) {
        assert.ok(Point.fromObject(event.position).compare(Point.fromObject(tile.start)) >= 0);
        assert.ok(Point.fromObject(event.position).compare(Point.fromObject(tile.end)) < 0);
      }
  } finally {
    host.close();
  }
});
