const assert = require("node:assert/strict");
const { test } = require("node:test");
const TextBuffer = require("../../src/text-buffer");
const WorkerMode = require("../../src/tree-sitter-worker-language-mode");

async function fixture() {
  const buffer = new TextBuffer("value # comment\n".repeat(10));
  const names = ["source.test", "comment.line.test", "string.test"];
  const grammar = {
    scopeName: names[0],
    idForScope: (name) => 1001 + names.indexOf(name) * 2,
    scopeNameForScopeId: (id) => names[(id - 1001) / 2],
    classNameForScopeId: (id) => "syntax--" + names[(id - 1001) / 2].replaceAll(".", " syntax--"),
  };
  const metadata = { queries: [], grammars: [] };
  let packet;
  const requests = [];
  const service = {
    acquire: () => ({ generation: 0, epoch: 0 }),
    settle: async () => metadata,
    release() {},
    async request(session, operation, data, options) {
      assert.equal(operation, "view");
      assert.ok(packet, "unexpected extra paint request");
      requests.push(data);
      const value = packet;
      packet = null;
      options.onChunk(value);
      return { ...metadata, syntaxReady: value.quality !== "provisional" };
    },
  };
  const mode = new WorkerMode({ buffer, grammar, service });
  mode.wantedRanges = () => [];
  mode.backgroundRange = () => null;
  buffer.setLanguageMode(mode);
  await mode.ready;
  await mode.refresh();
  const display = buffer.addDisplayLayer({ softWrapColumn: Infinity, tabLength: 4 });
  return {
    buffer,
    mode,
    display,
    requests,
    async publish(first, last, quality, rows, scope = 2) {
      packet = {
        kind: "end",
        start: [first, 0],
        end: [last + 1, 0],
        scopes: [1],
        quality,
        names: names.map((name, index) => [index + 1, name]),
        events: rows.flatMap((row) => [
          { position: [row, 6], open: [scope], close: [] },
          { position: [row, 15], open: [], close: [scope] },
        ]),
        folds: [],
      };
      mode.wantedRanges = () => (packet ? [[first, last]] : []);
      await mode.refresh();
    },
    lines: () => display.getScreenLines(0, 10),
    dispose: () => buffer.destroy(),
  };
}

for (const quality of ["provisional", "limited", "exact"]) {
  test(`a corrected overlapping ${quality} tile refreshes cached screen lines without a dirty range`, async () => {
    const state = await fixture();
    try {
      await state.publish(0, 3, quality, [0, 1]);
      const old = state.lines();
      state.mode.dirtyRanges.clear();
      // Same revision/generation/presentation, larger prefetch tile. The
      // original invalidation shortcut skipped the already-covered prefix.
      await state.publish(
        0,
        9,
        "exact",
        Array.from({ length: 10 }, (_, row) => row),
      );
      const current = state.lines();
      assert.equal(current[0].id, old[0].id, "identical prefix should keep its screen line");
      for (let row = 2; row < 10; row++) {
        assert.notEqual(current[row].id, old[row].id, `row ${row} was not refreshed`);
        assert.ok(
          current[row].tags.some(
            (tag) => tag < 0 && state.display.classNameForTag(tag).includes("syntax--comment"),
          ),
          `row ${row} lost its comment`,
        );
      }
    } finally {
      state.dispose();
    }
  });
}

test("a cold preview fills only gaps and never replaces retained syntax from the surrounding document", async () => {
  const state = await fixture();
  try {
    await state.publish(2, 3, "exact", [2, 3]);
    const before = state.lines();
    state.mode.presentationVersion++;
    await state.publish(
      0,
      9,
      "provisional",
      Array.from({ length: 10 }, (_, row) => row),
      3,
    );
    const after = state.lines();
    for (const row of [2, 3]) {
      assert.equal(after[row].id, before[row].id);
      assert.deepEqual(state.mode.scopeDescriptorForPosition([row, 8]).getScopesArray(), [
        "source.test",
        "comment.line.test",
      ]);
    }
    for (const row of [0, 1, 4, 9])
      assert.deepEqual(state.mode.scopeDescriptorForPosition([row, 8]).getScopesArray(), [
        "source.test",
        "string.test",
      ]);
  } finally {
    state.dispose();
  }
});

test("covered viewports request exact syntax instead of downgrading retained colors to a preview", async () => {
  const state = await fixture();
  try {
    await state.publish(0, 9, "exact", [0, 1]);
    state.mode.presentationVersion++;
    await state.publish(0, 9, "exact", [0, 1, 2]);
    assert.equal(state.requests[0].allowPreview, true);
    assert.equal(state.requests[1].allowPreview, false);
  } finally {
    state.dispose();
  }
});
