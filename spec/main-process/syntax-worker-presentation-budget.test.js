const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Emitter } = require("@lumine-code/event-kit");
const Mode = require("../../src/tree-sitter-worker-language-mode");
const Service = require("../../src/syntax-worker-service");
const HighlightCache = require("../../src/tree-sitter-highlight-cache");
const RangeList = require("../../src/tree-sitter-range-list");
const TextBuffer = require("../../src/text-buffer");
const { Point, Range } = TextBuffer;

function fixture({ maxBytes = 1600, events = () => 4, provisional = false } = {}) {
  const buffer = new TextBuffer({ text: "abcdef\n".repeat(1000) });
  const mode = Object.create(Mode.prototype);
  const delivered = [];
  const owners = [];
  const service = {
    interactions: 0,
    noteInteraction() {
      this.interactions++;
    },
    async request(session, operation, data, { onChunk }) {
      assert.equal(operation, "view");
      let range = data.ranges[0];
      while (range) {
        if (delivered.length >= 32)
          throw new Error("Paint did not stop after optional cache eviction");
        delivered.push(range);
        const [first, last] = range;
        const next = await onChunk({
          kind: "end",
          start: buffer.clipPosition([first, 0]),
          end: buffer.clipPosition([last + 1, 0]),
          scopes: [1],
          names: [[1, "source.js"]],
          events: Array.from({ length: events(range) }, (_, index) => ({
            position: new Point(first, index),
            open: [1],
            close: [],
          })),
          folds: [],
          quality: provisional ? "provisional" : "exact",
        });
        range = next?.range;
      }
      return { queries: [], grammars: ["source.js"], syntaxReady: !provisional };
    },
  };
  Object.assign(mode, {
    buffer,
    service,
    cache: new HighlightCache({ maxBytes, maxSnapshots: 256, maxEvents: 128000 }),
    session: { generation: 0, epoch: 0 },
    publicationPending: provisional,
    presentationVersion: 0,
    warmupPaused: false,
    requests: new Set(),
    requestsByOwner: new WeakMap(),
    defaultOwner: {},
    grammar: { scopeName: "source.js", idForScope: () => 1 },
    folds: new Map(),
    dirtyRanges: new RangeList(),
    invalidateAll: false,
    emitter: new Emitter(),
    schedule() {},
  });
  const request = (ranges, options = {}, owner = {}) => {
    owners.push(owner);
    mode.requestHighlighting(owner, ranges, false, { priority: 0, prefetch: false, ...options });
    return owner;
  };
  const stamp = () => ({
    revision: buffer.getTextRevision(),
    generation: mode.session.generation,
    presentation: mode.presentationVersion,
  });
  return {
    buffer,
    mode,
    service,
    delivered,
    request,
    stamp,
    dispose() {
      mode.emitter.dispose();
      buffer.destroy();
    },
  };
}

test("byte-budget eviction stops the two-prefetch-tile ping-pong below old event limits", async () => {
  const state = fixture();
  try {
    state.request([[128, 128]], { prefetch: true });
    await state.mode.refresh();
    assert.deepEqual(state.delivered, [
      [128, 128],
      [128, 255],
      [256, 383],
      [0, 127],
    ]);
    assert.equal(state.mode.warmupPaused, true);
    assert.ok(state.mode.cache.eventCount < state.mode.cache.maxEvents * 0.75);
    assert.equal(
      state.mode.cache.covers(new Point(128, 0), new Point(129, 0), state.stamp()),
      true,
    );
    await state.mode.refresh();
    assert.equal(state.delivered.length, 4);
  } finally {
    state.dispose();
  }
});

test("background warming stops after eviction even when retained bytes remain below 75 percent", async () => {
  const state = fixture({ events: ([first, last]) => (first === last ? 1 : 4) });
  try {
    state.request([[128, 128]], { background: true });
    await state.mode.refresh();
    assert.deepEqual(state.delivered, [
      [128, 128],
      [0, 127],
      [129, 256],
    ]);
    assert.ok(state.mode.cache.estimatedBytes < state.mode.cache.maxBytes * 0.75);
    assert.equal(state.mode.warmupPaused, true);
    assert.equal(state.mode.backgroundRange(state.stamp()), undefined);
  } finally {
    state.dispose();
  }
});

test("required primary fragments finish beyond the soft byte allowance and auxiliary requests do not stay protected", async () => {
  const state = fixture({ maxBytes: 1000 });
  try {
    state.request([
      [128, 128],
      [256, 256],
      [384, 384],
    ]);
    state.request([[600, 900]], { priority: 2 });
    await state.mode.refresh();
    assert.deepEqual(state.delivered, [
      [128, 128],
      [256, 256],
      [384, 384],
    ]);
    assert.equal(state.mode.cache.getStats().overBudget, true);
    assert.equal(state.mode.warmupPaused, true);
    for (const row of [128, 256, 384])
      assert.equal(
        state.mode.cache.covers(new Point(row, 0), new Point(row + 1, 0), state.stamp()),
        true,
      );
    assert.deepEqual(state.mode.wantedRanges(), [
      [128, 128],
      [256, 256],
      [384, 384],
    ]);
  } finally {
    state.dispose();
  }
});

test("a minimap range cannot protect unrelated cached fragments against primary paint", async () => {
  const state = fixture();
  try {
    state.request([
      [300, 300],
      [400, 400],
    ]);
    state.request([[0, 1000]], { priority: 2 });
    state.mode.cache.replace(
      [
        {
          start: new Point(512, 0),
          end: new Point(640, 0),
          scopes: [1],
          events: Array.from({ length: 4 }, (_, i) => ({
            position: new Point(512, i),
            open: [1],
            close: [],
          })),
        },
      ],
      state.stamp(),
    );
    await state.mode.refresh();
    assert.deepEqual(state.delivered, [
      [300, 300],
      [400, 400],
    ]);
    assert.equal(state.mode.cache.covers(new Point(512, 0), new Point(640, 0)), false);
    assert.equal(state.mode.getHighlightingStatus().state, "ready");
  } finally {
    state.dispose();
  }
});

test("repeated or auxiliary requests do not rearm warming, while genuine primary/source changes do", () => {
  const state = fixture();
  try {
    const ranges = [[128, 140]];
    const owner = state.request(ranges);
    const auxiliary = state.request([[300, 400]], { priority: 2 });
    const interactions = state.service.interactions;
    state.mode.warmupPaused = true;
    state.mode.requestHighlighting(owner, [[128, 140]], false, { priority: 0 });
    state.mode.requestHighlighting(auxiliary, [[500, 800]], false, { priority: 2 });
    assert.equal(state.mode.warmupPaused, true);
    assert.equal(state.service.interactions, interactions);
    ranges[0][0] = 129;
    state.mode.requestHighlighting(owner, ranges, false, { priority: 0 });
    assert.equal(state.mode.warmupPaused, false);
    assert.equal(state.service.interactions, interactions + 1);
    state.mode.warmupPaused = true;
    state.mode.receive({ event: "pending" });
    assert.equal(state.mode.warmupPaused, false);
    state.mode.warmupPaused = true;
    state.mode.bufferDidChange({
      oldRange: new Range([0, 0], [0, 1]),
      newRange: new Range([0, 0], [0, 1]),
      newText: "x",
    });
    assert.equal(state.mode.warmupPaused, false);
  } finally {
    state.dispose();
  }
});

function put(state, { quality = "exact", reason = null, stamp = state.stamp() } = {}) {
  state.mode.cache.replace(
    [{ start: new Point(0, 0), end: new Point(1, 0), scopes: [1], events: [], quality, reason }],
    stamp,
  );
}

test("highlighting status distinguishes stale revisions, grammar generations and presentation identities", () => {
  const state = fixture();
  try {
    state.request([[0, 0]]);
    for (const field of ["revision", "generation", "presentation"]) {
      put(state, { stamp: { ...state.stamp(), [field]: -1 } });
      assert.equal(state.mode.getHighlightingStatus().state, "retained");
    }
    put(state);
    assert.equal(state.mode.getHighlightingStatus().state, "ready");
    state.mode.publicationPending = true;
    assert.equal(state.mode.getHighlightingStatus().state, "retained");
    state.mode.presentationVersion++;
    state.mode.publicationPending = false;
    assert.equal(state.mode.getHighlightingStatus().state, "retained");
    put(state);
    assert.equal(state.mode.getHighlightingStatus().state, "ready");
  } finally {
    state.dispose();
  }
});

test("only current preview tiles report provisional and exact limited coverage remains explicit", () => {
  const state = fixture();
  try {
    state.request([[0, 0]]);
    state.mode.publicationPending = true;
    assert.equal(state.mode.getHighlightingStatus().state, "pending");
    put(state, { quality: "provisional", reason: "source-window" });
    assert.deepEqual(state.mode.getHighlightingStatus(), {
      state: "provisional",
      revision: 0,
      reasons: ["source-window"],
    });
    state.mode.presentationVersion++;
    assert.deepEqual(state.mode.getHighlightingStatus(), {
      state: "retained",
      revision: 0,
      reasons: [],
    });
    state.mode.publicationPending = false;
    put(state, { quality: "limited", reason: "source-window" });
    assert.deepEqual(state.mode.getHighlightingStatus(), {
      state: "limited",
      revision: 0,
      reasons: ["source-window"],
    });
  } finally {
    state.dispose();
  }
});

test("status locates retained fragments after a lazy newline shift before classifying coverage", () => {
  const state = fixture();
  try {
    state.request([[11, 11]]);
    state.mode.cache.replace(
      [
        {
          start: new Point(10, 0),
          end: new Point(11, 0),
          scopes: [1],
          events: [],
          quality: "exact",
        },
      ],
      state.stamp(),
    );
    state.buffer.insert(new Point(0, 0), "\n");
    state.mode.bufferDidChange({
      oldRange: new Range([0, 0], [0, 0]),
      newRange: new Range([0, 0], [1, 0]),
      newText: "\n",
    });
    assert.equal(state.mode.cache.snapshots[0].start.row, 10);
    assert.equal(state.mode.getHighlightingStatus().state, "retained");
    assert.equal(state.mode.cache.snapshots[0].start.row, 11);
  } finally {
    state.dispose();
  }
});

test("a provisional paint reply preserves semantic metadata and never emits a false tokenization", async () => {
  const state = fixture({ provisional: true });
  try {
    state.request([[0, 0]]);
    state.mode.availableQueries = new Set(["tagsQuery"]);
    state.mode.usedGrammarScopes = ["source.js", "source.regexp"];
    state.mode.softTabsHint = false;
    state.mode.tokenized = true;
    let tokenizations = 0;
    state.mode.emitter.on("did-tokenize", () => tokenizations++);
    await state.mode.refresh();
    assert.deepEqual([...state.mode.availableQueries], ["tagsQuery"]);
    assert.deepEqual(state.mode.usedGrammarScopes, ["source.js", "source.regexp"]);
    assert.equal(state.mode.softTabsHint, false);
    assert.equal(state.mode.publicationPending, true);
    assert.equal(tokenizations, 0);
  } finally {
    state.dispose();
  }
});

test("a preview response never emits exact settlement through the worker service", async () => {
  const buffer = new TextBuffer({ text: "const x = 1;" });
  const events = [];
  const session = {
    id: 1,
    epoch: 0,
    generation: 0,
    buffer,
    controller: new AbortController(),
    chain: Promise.resolve(),
    listener: (event) => events.push(event),
  };
  let syntaxReady = false;
  const service = Object.create(Service.prototype);
  Object.assign(service, {
    syntaxEpoch: 0,
    ensureEnvironment: () => Promise.resolve(),
    client: {
      request: async () => ({
        revision: buffer.getTextRevision(),
        generation: 0,
        syntaxReady,
        value: { syntaxReady },
      }),
    },
  });
  try {
    assert.deepEqual(await service.request(session, "view"), { syntaxReady: false });
    assert.deepEqual(events, []);
    syntaxReady = true;
    assert.deepEqual(await service.request(session, "view"), { syntaxReady: true });
    assert.deepEqual(events, [{ event: "settled", revision: buffer.getTextRevision() }]);
  } finally {
    buffer.destroy();
  }
});

test("cached primary scrolling postpones recycling until 750 ms of genuine quiet", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const state = fixture();
  const service = Object.create(Service.prototype);
  let recycled = 0;
  Object.assign(service, {
    sessions: new Map([[1, {}]]),
    client: { pending: new Map() },
    recover() {
      recycled++;
    },
  });
  state.mode.service = service;
  const advance = (ms) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  try {
    const owner = state.request([[128, 128]]);
    const auxiliary = state.request([[0, 1000]], { priority: 2 });
    state.mode.cache.replace(
      [{ start: new Point(0, 0), end: new Point(1000, 0), scopes: [1], events: [] }],
      state.stamp(),
    );
    service.scheduleRecycle();
    advance(500);
    assert.equal(state.mode.requestHighlighting(owner, [[129, 129]], false, { priority: 0 }), true);
    advance(250);
    advance(250);
    assert.equal(recycled, 0);
    state.mode.requestHighlighting(owner, [[130, 130]], false, { priority: 0 });
    advance(250);
    advance(250);
    advance(249);
    state.mode.requestHighlighting(owner, [[130, 130]], false, { priority: 0 });
    state.mode.requestHighlighting(auxiliary, [[10, 990]], false, { priority: 2 });
    assert.equal(service.lastInteraction, 1000);
    assert.equal(recycled, 0);
    advance(1);
    assert.equal(recycled, 1);
  } finally {
    state.dispose();
  }
});

test("focus changes mark interaction without retaining a strong buffer or resetting on repeated focus", () => {
  const service = Object.create(Service.prototype);
  const first = {},
    second = {};
  let interactions = 0;
  const controls = [];
  Object.assign(service, {
    sessions: new Map([
      [1, { id: 1, buffer: first }],
      [2, { id: 2, buffer: second }],
    ]),
    client: { send: (message) => controls.push(message) },
    noteInteraction() {
      interactions++;
    },
  });
  service.focusBuffer(first);
  service.focusBuffer(first);
  assert.equal(interactions, 1);
  assert.ok(service.focusedBuffer instanceof WeakRef);
  service.focusBuffer(second);
  service.focusBuffer(undefined);
  service.focusBuffer(undefined);
  assert.equal(interactions, 3);
  assert.equal(service.focusedBuffer, null);
  assert.deepEqual(
    controls.map((message) => message.session),
    [1, 1, 2, null, null],
  );
});
