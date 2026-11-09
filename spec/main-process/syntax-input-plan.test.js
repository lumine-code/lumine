const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CompositeDisposable, Disposable } = require("@lumine-code/event-kit");
const Client = require("../../src/syntax-worker-client");
const Endpoint = require("../../src/syntax-worker-endpoint");
const Host = require("../../src/syntax-worker-host");
const Service = require("../../src/syntax-worker-service");
const TextBuffer = require("../../src/text-buffer");
const { configuration } = require("../../src/syntax-worker-environment");

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function inputRequest(overrides = {}) {
  return {
    changes: [
      {
        oldRange: new TextBuffer.Range([0, 13], [0, 13]),
        startIndex: 13,
        oldEndIndex: 13,
        newText: "\n",
      },
    ],
    ranges: [[1, 1]],
    tabLength: 4,
    options: {
      isPastedText: false,
      softTabs: true,
      rowOptions: new Map([[1, { preserveLeadingWhitespace: true, skipBlankLines: false }]]),
    },
    ...overrides,
  };
}

async function setup(text = "class Record:") {
  const host = new Host();
  let buffer, service, endpoint;
  try {
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
    buffer = new TextBuffer({ text });
    const data = {
      session: 1,
      revision: buffer.getTextRevision(),
      scopeName: definition.scopeName,
      path: "example.py",
    };
    await host.dispatch("open", data);
    await host.dispatch("append", { session: 1, text });
    await host.dispatch("initialize", data);
    await host.dispatch("settle", data);

    const sent = [],
      received = [],
      replies = new Map();
    const worker = {
      postMessage(message) {
        const copy = structuredClone(message);
        sent.push(copy);
        if (copy.type === "request") replies.set(copy.id, deferred());
        queueMicrotask(() => endpoint.receive(copy));
      },
      terminate: () => endpoint.close(),
    };
    const client = new Client({ workerFactory: () => worker });
    endpoint = new Endpoint({
      dispatch: (...args) => host.dispatch(...args),
      control: (message) => host.control(message),
      send(message) {
        const copy = structuredClone(message);
        received.push(copy);
        queueMicrotask(() => worker.onmessage({ data: copy }));
        if (copy.type === "result" || copy.type === "error") replies.get(copy.id)?.resolve(copy);
      },
    });
    service = Object.assign(Object.create(Service.prototype), {
      nextSession: 1,
      syntaxEpoch: 0,
      client,
      sessions: new Map(),
      watches: new Map(),
      subscriptions: new CompositeDisposable(),
      ensureEnvironment: () => Promise.resolve(),
    });
    const session = {
      id: 1,
      buffer,
      epoch: 0,
      generation: 0,
      controller: new AbortController(),
      chain: Promise.resolve(),
      subscription: new Disposable(),
      listener() {},
    };
    service.sessions.set(session.id, session);
    return {
      host,
      data,
      service,
      session,
      client,
      endpoint,
      sent,
      received,
      async finishInputRequest() {
        const request = sent.find((message) => message.operation === "input-indent");
        assert.ok(request, "Expected an interactive input request");
        return replies.get(request.id).promise;
      },
      close() {
        service.dispose();
        endpoint.close();
        buffer.destroy();
        host.close();
      },
    };
  } catch (error) {
    service?.dispose();
    endpoint?.close();
    buffer?.destroy();
    host.close();
    throw error;
  }
}

function holdInput(host) {
  const entered = deferred(),
    release = deferred();
  const dispatch = host.dispatch.bind(host);
  host.dispatch = async (operation, data, options = {}) => {
    if (operation === "input-indent" && data.target == null) {
      entered.resolve();
      await new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", abort, { once: true });
        release.promise.then(() => {
          options.signal.removeEventListener("abort", abort);
          resolve();
        });
        if (options.signal.aborted) abort();
      });
    }
    return dispatch(operation, data, options);
  };
  return { entered: entered.promise, release: release.resolve };
}

test("input planning returns one cloneable complete result without stream packets or acknowledgements", async () => {
  const state = await setup();
  try {
    const plan = await state.service.prepareInputIndentation(state.session, inputRequest());
    assert.deepEqual(plan, { kind: "ready", levels: [[1, 1]] });
    assert.deepEqual(structuredClone(plan), plan);
    assert.deepEqual(
      state.received.map((message) => message.type),
      ["result"],
    );
    assert.equal(
      state.sent.some((message) => message.type === "ack"),
      false,
    );
    const request = state.sent.find((message) => message.type === "request");
    assert.equal(request.operation, "input-indent");
    assert.equal(request.data.inline, true);
    assert.equal(request.data.target, 2);
    assert.equal(request.data.options.rowOptions instanceof Map, true);
    assert.deepEqual(request.data.changes, [
      {
        range: [
          [0, 13],
          [0, 13],
        ],
        startIndex: 13,
        oldEndIndex: 13,
        text: "\n",
      },
    ]);
    assert.equal(state.endpoint.jobs.size, 0);
    assert.equal(state.host.sessions.size, 1);
    assert.equal(state.host.sessions.get(1).forks.size, 0);
    assert.equal(state.host.sessions.get(1).buffer.getText(), "class Record:");
    assert.deepEqual(state.sent.at(-1), { type: "control", operation: "release", session: 2 });
  } finally {
    state.close();
  }
});

for (const invalidation of [
  "abort",
  "configuration",
  "session-epoch",
  "revision",
  "intent",
  "dispose",
])
  test(`input planning rejects ${invalidation} invalidation and releases its private session`, async () => {
    const state = await setup();
    const hold = holdInput(state.host);
    const controller = new AbortController();
    let current = true;
    const pending = state.service.prepareInputIndentation(
      state.session,
      inputRequest({ signal: controller.signal, isCurrent: () => current }),
    );
    const rejected = assert.rejects(pending, { name: "AbortError" });
    try {
      await hold.entered;
      assert.equal(state.host.sessions.size, 2);
      if (invalidation === "abort")
        controller.abort(Object.assign(new Error("Cancelled input"), { name: "AbortError" }));
      if (invalidation === "configuration") state.service.syntaxEpoch++;
      if (invalidation === "session-epoch") state.session.epoch++;
      if (invalidation === "revision") state.session.buffer.append(" # external edit");
      if (invalidation === "intent") current = false;
      if (invalidation === "dispose") state.service.dispose();
      hold.release();
      await rejected;
      await state.finishInputRequest();
      assert.equal(state.endpoint.jobs.size, 0);
      assert.equal(state.client.pending.size, 0);
      assert.equal(state.host.sessions.has(2), false);
      assert.equal(
        state.sent.some(
          (message) =>
            message.type === "control" &&
            message.operation === "release" &&
            message.session === (invalidation === "dispose" ? 1 : 2),
        ),
        true,
      );
      assert.equal(
        state.received.some((message) => message.type === "chunk"),
        false,
      );
      assert.equal(
        state.sent.some((message) => message.type === "ack"),
        false,
      );
    } finally {
      hold.release();
      state.close();
      await rejected;
    }
  });

for (const [name, overrides] of [
  ["more than 128 rows", { ranges: [[1, 129]] }],
  ["more than 128 changes", { changes: Array.from({ length: 129 }, () => ({ newText: "\n" })) }],
  ["more than 64 KiB of inserted text", { changes: [{ newText: "x".repeat(65537) }] }],
  ["an empty row set", { ranges: [] }],
  [
    "overlapping row ranges",
    {
      ranges: [
        [1, 2],
        [2, 3],
      ],
    },
  ],
])
  test(`input planning rejects ${name} before allocating a syntax candidate`, async () => {
    const service = Object.assign(Object.create(Service.prototype), {
      nextSession: 7,
      request: () => assert.fail("Over-budget input must not reach the transport"),
    });
    await assert.rejects(service.prepareInputIndentation({}, inputRequest(overrides)), RangeError);
    assert.equal(service.nextSession, 7);
  });

test("the input capability accepts exactly 128 changes and a 64 KiB inserted source", async () => {
  const controls = [],
    requests = [];
  const service = Object.assign(Object.create(Service.prototype), {
    nextSession: 1,
    syntaxEpoch: 0,
    client: { send: (message) => controls.push(message) },
    async request(_session, operation, data) {
      requests.push({ operation, data });
      return { count: 1, levels: [[1, 1]] };
    },
  });
  const session = {
    epoch: 0,
    buffer: { getTextRevision: () => 0 },
    controller: new AbortController(),
  };
  const change = inputRequest().changes[0];
  const result = await service.prepareInputIndentation(
    session,
    inputRequest({
      changes: Array.from({ length: 128 }, (_, index) => ({
        ...change,
        newText: "x".repeat(index === 0 ? 65536 - 127 : 1),
      })),
    }),
  );
  assert.deepEqual(result, { kind: "ready", levels: [[1, 1]] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, "input-indent");
  assert.equal(requests[0].data.changes.length, 128);
  assert.equal(
    requests[0].data.changes.reduce((units, entry) => units + entry.text.length, 0),
    65536,
  );
  assert.deepEqual(controls, [{ type: "control", operation: "release", session: 2 }]);
});

for (const [name, input] of [
  ["more than 128 rows", { ranges: [[0, 128]], inline: true }],
  ["streaming requested explicitly", { ranges: [[0, 0]], inline: false }],
])
  test(`a direct input-indent request rejects ${name} without streaming`, async () => {
    const state = await setup("value = 1\n".repeat(129));
    let chunks = 0;
    try {
      await assert.rejects(
        state.host.dispatch(
          "input-indent",
          {
            ...state.data,
            ...input,
            tabLength: 4,
            options: { isPastedText: false },
          },
          { emit: () => chunks++ },
        ),
        RangeError,
      );
      assert.equal(chunks, 0);
      assert.equal(state.host.sessions.size, 1);
    } finally {
      state.close();
    }
  });

test("a direct input-indent request returns all 128 allowed rows inline", async () => {
  const state = await setup("value = 1\n".repeat(128));
  let chunks = 0;
  try {
    const result = await state.host.dispatch(
      "input-indent",
      {
        ...state.data,
        ranges: [[0, 127]],
        inline: true,
        tabLength: 4,
        options: { isPastedText: false },
      },
      { emit: () => chunks++ },
    );
    assert.deepEqual(result.value, {
      count: 128,
      levels: Array.from({ length: 128 }, (_, row) => [row, 0]),
    });
    assert.equal(chunks, 0);
    assert.equal(state.host.sessions.size, 1);
  } finally {
    state.close();
  }
});
