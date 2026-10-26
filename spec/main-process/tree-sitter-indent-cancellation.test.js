const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const IndentResolver = require("../../src/tree-sitter-indent-resolver");

function deferredFixture() {
  const buffer = new TextBuffer({ text: "def work():\n    value = 1\n" });
  buffer.clearUndoStack();
  buffer.transact(() => buffer.append("\n\n\n"));
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const mode = {
    epoch: 0,
    getSyntaxRequestEpoch() {
      return this.epoch;
    },
    atTransactionEnd: () => pending,
  };
  const resolver = new IndentResolver(buffer, mode);
  let retries = 0;
  resolver.suggestedIndentForBufferRow = () => {
    retries++;
    return 4;
  };
  const layer = { destroyed: false, getOrParseTree: () => ({}) };
  return {
    buffer,
    mode,
    resolver,
    layer,
    finish,
    get retries() {
      return retries;
    },
    close: () => buffer.destroy(),
  };
}

test("undo removes deferred newline rows without rejecting or rereading nonexistent lines", async () => {
  const f = deferredFixture();
  try {
    const pending = f.resolver.deferIndentSuggestion(
      5,
      4,
      {},
      { comparisonRow: 4, comparisonRowIndent: 1, controllingLayer: f.layer },
    );
    f.buffer.undo();
    assert.equal(f.buffer.getLastRow(), 2);
    f.finish({ parseError: null });
    assert.equal(await pending, undefined);
    assert.equal(f.retries, 0);
    assert.equal(f.resolver.lineSource(5), null);
  } finally {
    f.close();
  }
});

test("row bounds also cancel deferrals when the source provider exposes no revision", async () => {
  const f = deferredFixture();
  try {
    f.resolver.buffer = {
      lineLengthForRow: (row) => f.buffer.lineLengthForRow(row),
      getTextSnapshot: () => f.buffer.getTextSnapshot(),
    };
    const pending = f.resolver.deferIndentSuggestion(
      5,
      4,
      {},
      { comparisonRow: 4, comparisonRowIndent: 1, controllingLayer: f.layer },
    );
    f.buffer.undo();
    f.finish({ parseError: null });
    assert.equal(await pending, undefined);
    assert.equal(f.retries, 0);
  } finally {
    f.close();
  }
});

test("undo followed by redo cannot revive a deferred request from an earlier revision", async () => {
  const f = deferredFixture();
  try {
    const pending = f.resolver.deferIndentSuggestion(
      5,
      4,
      {},
      { comparisonRow: 4, comparisonRowIndent: 1, controllingLayer: f.layer },
    );
    f.buffer.undo();
    f.buffer.redo();
    assert.equal(f.buffer.getLastRow(), 5);
    f.finish({ parseError: null });
    assert.equal(await pending, undefined);
    assert.equal(f.retries, 0);
  } finally {
    f.close();
  }
});

test("the latest valid grouped newline request still resolves after earlier ones become stale", async () => {
  const f = deferredFixture();
  try {
    const earlier = f.resolver.deferIndentSuggestion(
      5,
      4,
      {},
      { comparisonRow: 4, comparisonRowIndent: 1, controllingLayer: f.layer },
    );
    f.buffer.append("\n");
    const latest = f.resolver.deferIndentSuggestion(
      6,
      4,
      {},
      { comparisonRow: 5, comparisonRowIndent: 1, controllingLayer: f.layer },
    );
    f.finish({ parseError: null });
    assert.equal(await earlier, undefined);
    assert.equal(await latest, 4);
    assert.equal(f.retries, 1);
  } finally {
    f.close();
  }
});

test("a grammar epoch change cancels a deferred request before retrying indentation", async () => {
  const f = deferredFixture();
  try {
    const pending = f.resolver.deferIndentSuggestion(
      5,
      4,
      {},
      { comparisonRow: 4, comparisonRowIndent: 1, controllingLayer: f.layer },
    );
    f.mode.epoch++;
    f.finish({ parseError: null });
    assert.equal(await pending, undefined);
    assert.equal(f.retries, 0);
  } finally {
    f.close();
  }
});

test("deferred dedent cancels after undo before resolving the removed row", async () => {
  const buffer = new TextBuffer({ text: "first\n" });
  buffer.clearUndoStack();
  buffer.transact(() => buffer.append("    opening\n    closing"));
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const layer = {
    tree: {},
    treeIsDirty: true,
    queries: { indentsQuery: {} },
    containsPoint: () => true,
    scopeResolver: { reset() {} },
  };
  const mode = {
    useAsyncIndent: true,
    useAsyncParsing: true,
    atTransactionEnd: () => pending,
    controllingLayerAtPoint: () => layer,
  };
  const resolver = new IndentResolver(buffer, mode);
  try {
    const result = resolver.suggestedIndentForEditedBufferRow(2, 4);
    buffer.undo();
    finish({ changeCount: 1 });
    assert.equal(await result, null);
  } finally {
    buffer.destroy();
  }
});
