const { test } = require("node:test");
const assert = require("node:assert/strict");
const Host = require("../../src/syntax-worker-host");
const TextBuffer = require("../../src/text-buffer");
const { Point } = TextBuffer;

function fixture(reasons, { onSeek } = {}) {
  const host = new Host();
  host.metadata = () => ({ syntaxReady: true });
  const buffer = new TextBuffer({ text: "const value = 1;" });
  const attempts = [];
  const session = {
    id: 1,
    revision: 0,
    scopeName: "source.js",
    buffer,
    mode: {
      scopeNameForScopeId: (id) => (id === 1 ? "source.js" : "constant.numeric.js"),
      getFoldRangeForRow: () => null,
      buildHighlightIterator(options) {
        assert.deepEqual(options, { presentation: true });
        const attempt = attempts.length;
        const reason = reasons[Math.min(attempt, reasons.length - 1)];
        const iterator = {
          limitedReason: null,
          seek(start, endRow) {
            assert.deepEqual(start, new Point(0, 0));
            assert.equal(endRow, 0);
            iterator.limitedReason = reason;
            onSeek?.(attempt);
            return reason ? [1] : [1, 2];
          },
          getPosition: () => Point.INFINITY,
          getOpenScopeIds: () => [],
          getCloseScopeIds: () => [],
          moveToSuccessor() {},
        };
        attempts.push(iterator);
        return iterator;
      },
    },
  };
  return {
    host,
    session,
    attempts,
    dispose() {
      buffer.destroy();
      host.close();
    },
  };
}

test("a preview with incomplete query coverage publishes no falsely plain suffix", async () => {
  for (const reason of ["source-window", "timeout", "capture-limit"]) {
    const state = fixture([reason]);
    const packets = [];
    state.session.mode.publicationPending = true;
    state.host.previews.get = async () => ({
      startRow: 0,
      requestedStart: { row: 0, column: 0 },
      requestedEnd: { row: 0, column: 16 },
      buffer: state.session.buffer,
      mode: state.session.mode,
    });
    try {
      const result = await state.host.previewView(
        state.session,
        [0, 0],
        async (packet) => packets.push(packet),
        () => {},
      );
      assert.equal(result, null);
      assert.deepEqual(packets, []);
    } finally {
      state.dispose();
    }
  }
});

test("a transient paint timeout yields once and publishes only the fresh successful result", async () => {
  let yielded = false;
  const state = fixture(["timeout", null], {
    onSeek(attempt) {
      if (attempt === 0)
        setImmediate(() => {
          yielded = true;
        });
      else assert.equal(yielded, true);
    },
  });
  const packets = [];
  try {
    await state.host.view(
      state.session,
      [[0, 0]],
      async (packet) => packets.push(packet),
      () => {},
    );
    assert.equal(state.attempts.length, 2);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].quality, "exact");
    assert.equal(packets[0].reason, null);
    assert.deepEqual(packets[0].scopes, [1, 2]);
  } finally {
    state.dispose();
  }
});

test("persistent paint timeouts stop after two attempts and publish an explicit limited result", async () => {
  const state = fixture(["timeout"]);
  try {
    const result = await state.host.view(state.session, [[0, 0]], null, () => {});
    assert.equal(state.attempts.length, 2);
    assert.equal(result.tiles.length, 1);
    assert.equal(result.tiles[0].quality, "limited");
    assert.equal(result.tiles[0].reason, "timeout");
  } finally {
    state.dispose();
  }
});

test("source, result, predicate and cancellation limits never retry", async () => {
  for (const reason of [
    "source-window",
    "result-limit",
    "capture-limit",
    "match-limit",
    "predicate-text-limit",
    "cancelled",
  ]) {
    const state = fixture([reason]);
    try {
      const result = await state.host.view(state.session, [[0, 0]], null, () => {});
      assert.equal(state.attempts.length, 1, reason);
      assert.equal(result.tiles[0].quality, "limited");
      assert.equal(result.tiles[0].reason, reason);
    } finally {
      state.dispose();
    }
  }
});

test("an ordinary successful paint uses one attempt without adding a yield", async () => {
  let afterTurn = false;
  const state = fixture([null]);
  setImmediate(() => {
    afterTurn = true;
  });
  try {
    await state.host.view(state.session, [[0, 0]], null, () => {});
    assert.equal(state.attempts.length, 1);
    assert.equal(afterTurn, false);
  } finally {
    state.dispose();
  }
});

test("obsolescence during the retry yield prevents a second query and publishes nothing", async () => {
  let obsolete = false;
  const state = fixture(["timeout", null], {
    onSeek() {
      setImmediate(() => {
        obsolete = true;
      });
    },
  });
  const packets = [];
  try {
    await assert.rejects(
      state.host.view(
        state.session,
        [[0, 0]],
        async (packet) => packets.push(packet),
        () => {
          if (obsolete) throw Object.assign(new Error("Source changed"), { name: "AbortError" });
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(state.attempts.length, 1);
    assert.deepEqual(packets, []);
  } finally {
    state.dispose();
  }
});

test("obsolescence during the second query also prevents publication", async () => {
  let obsolete = false;
  const state = fixture(["timeout", null], {
    onSeek(attempt) {
      if (attempt === 1) obsolete = true;
    },
  });
  const packets = [];
  try {
    await assert.rejects(
      state.host.view(
        state.session,
        [[0, 0]],
        async (packet) => packets.push(packet),
        () => {
          if (obsolete) throw Object.assign(new Error("Source changed"), { name: "AbortError" });
        },
      ),
      { name: "AbortError" },
    );
    assert.equal(state.attempts.length, 2);
    assert.deepEqual(packets, []);
  } finally {
    state.dispose();
  }
});
