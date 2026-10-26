const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Emitter, Disposable } = require("@lumine-code/event-kit");
const Service = require("../../src/syntax-worker-service");
const TextBuffer = require("../../src/text-buffer");
const { PieceTree } = require("../../src/text-model");

function setup() {
  const subscribe = () => new Disposable();
  const grammars = {
    onDidAddGrammar: subscribe,
    onDidUpdateGrammar: subscribe,
    onDidRemoveGrammar: subscribe,
    onDidChangeSyntaxModules: subscribe,
    config: {
      onDidChange: subscribe,
      schema: {},
      get: () => ({}),
      getScopedSettingsStore: () => ({ propertySets: [] }),
    },
    getGrammars: () => [],
    syntaxModules: new Map(),
    rootLanguageRangesByBuffer: new WeakMap(),
  };
  const clients = [];
  const service = new Service(grammars, {
    clientFactory() {
      const emitter = new Emitter();
      const client = {
        closed: false,
        operations: [],
        controls: [],
        onDidReceiveEvent: (callback) => emitter.on("event", callback),
        onDidClose: (callback) => emitter.on("close", callback),
        send(message) {
          client.controls.push(message);
        },
        request(operation) {
          client.operations.push(operation);
          if (client.closed) return Promise.reject(new Error("Client is closed"));
          return Promise.resolve();
        },
        close() {
          if (client.closed) return;
          client.closed = true;
          emitter.emit("close", new Error("Client is closed"));
          emitter.dispose();
        },
      };
      clients.push(client);
      return client;
    },
  });
  return { service, clients };
}

async function enterEnvironmentYield() {
  // Advance the readiness chain's catch/then, but not its setImmediate yield.
  await Promise.resolve();
  await Promise.resolve();
}

test("a fatal fault without an owner disables all affected sessions without replaying them", async () => {
  const { service, clients } = setup();
  const buffers = [new TextBuffer("one"), new TextBuffer("two")];
  const events = [];
  const sessions = buffers.map((buffer) =>
    service.acquire(buffer, { scopeName: "source.js" }, (event) => events.push(event)),
  );
  try {
    await Promise.all(sessions.map((session) => session.chain));
    service.receive({
      event: "runtime-failure",
      failure: { code: "wasm-failure", fatal: true, message: "unattributed trap" },
    });
    assert.equal(service.client, null);
    assert.equal(service.sessions.size, 0);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].closed, true);
    assert.equal(events.filter((event) => event.event === "unavailable").length, 2);
    for (const session of sessions)
      await assert.rejects(service.settle(session), { name: "AbortError" });
    for (const buffer of buffers) buffer.append(" edited");
    assert.equal(clients.length, 1);
  } finally {
    for (const buffer of buffers) buffer.destroy();
    service.dispose();
  }
});

test("a retired environment task cannot clear a replacement worker's pending configuration", async () => {
  const { service, clients } = setup();
  try {
    const old = service.ensureEnvironment().catch(() => {});
    await enterEnvironmentYield();
    service.disconnect();
    const current = service.ensureEnvironment();
    await Promise.all([old, current]);
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[1].operations, ["environment"]);
    assert.deepEqual(clients[0].operations, []);
    assert.equal(service.environmentDirty, false);
  } finally {
    service.dispose();
  }
});

test("a crash during startup sends the full environment before reopening the document", async () => {
  const { service, clients } = setup();
  const buffer = new TextBuffer({ text: "const value = 1;" });
  const events = [];
  const session = service.acquire(buffer, { scopeName: "source.js" }, (event) =>
    events.push(event),
  );
  try {
    await enterEnvironmentYield();
    clients[0].close();
    await session.chain;
    assert.deepEqual(clients[1].operations, ["environment", "open", "append", "initialize"]);
    assert.equal(
      events.some((event) => event.event === "failure"),
      false,
    );
    assert.ok(events.some((event) => event.event === "recovered"));
    assert.equal(service.sessions.get(session.id), session);
  } finally {
    service.release(session);
    buffer.destroy();
    service.dispose();
  }
});

test("disposing during an environment yield does not send to the retired worker", async () => {
  const { service, clients } = setup();
  const pending = service.ensureEnvironment();
  await enterEnvironmentYield();
  service.dispose();
  await pending;
  assert.deepEqual(clients[0].operations, []);
  assert.equal(service.sessions.size, 0);
  assert.equal(service.client, null);
});

for (const change of ["initialization", "replacement", "recovery"])
  test(`the active buffer keeps parser priority after grammar session ${change}`, async () => {
    const previous = globalThis.lumine;
    const buffer = new TextBuffer({ text: "const value = 1;" });
    globalThis.lumine = { workspace: { getActiveTextEditor: () => ({ getBuffer: () => buffer }) } };
    const { service, clients } = setup();
    try {
      const grammar = { scopeName: "source.js" };
      const original = service.acquire(buffer, grammar, () => {});
      await original.chain;
      let current = original;
      if (change === "replacement") {
        current = service.acquire(buffer, grammar, () => {});
        service.release(original);
      } else if (change === "recovery") clients[0].close();
      await current.chain;
      assert.equal(
        clients.at(-1).controls.findLast((message) => message.operation === "focus")?.session,
        current.id,
      );
    } finally {
      service.dispose();
      buffer.destroy();
      globalThis.lumine = previous;
    }
  });

function withoutLazyText(batch) {
  return {
    ...batch,
    changes: batch.changes.map((change) => {
      assert.ok(change.newTextSource instanceof PieceTree);
      return Object.create(change, {
        oldText: { get: () => assert.fail("Worker transport read lazy oldText") },
        newText: { get: () => assert.fail("Worker transport read lazy newText") },
        inserted: {
          get: () => assert.fail("Canonical newTextSource must precede legacy inserted"),
        },
      });
    }),
  };
}

async function mirrorSourceEdits(initial, edit) {
  const Host = require("../../src/syntax-worker-host");
  const previous = globalThis.lumine;
  const host = new Host();
  const buffer = new TextBuffer({ text: initial });
  const batches = [];
  const subscription = buffer.onDidApplyChanges((batch) => batches.push(batch));
  const requests = [];
  const session = { id: 1, controller: new AbortController() };
  const client = {
    request(operation, data, options) {
      requests.push({ operation, data });
      if (operation === "edit-text-chunk") assert.ok(data.text.length <= 65536);
      if (operation === "edit" || operation === "edit-chunk") {
        assert.ok(data.changes.length <= 128);
        assert.ok(data.changes.reduce((sum, change) => sum + change.text.length, 0) <= 65536);
      }
      return host.dispatch(operation, data, options);
    },
    send: (message) => host.control(message),
  };
  try {
    await host.dispatch("open", {
      session: 1,
      revision: buffer.getTextRevision(),
      scopeName: "source.js",
    });
    await host.dispatch("append", { session: 1, text: initial });
    edit(buffer);
    for (const batch of batches)
      await Service.prototype.sendEdits.call(
        Object.create(Service.prototype),
        client,
        session,
        withoutLazyText(batch),
      );
    assert.equal(host.sessions.get(1).buffer.getText(), buffer.getText());
    assert.equal(host.sessions.get(1).revision, buffer.getTextRevision());
    return requests;
  } finally {
    subscription.dispose();
    buffer.destroy();
    host.close();
    globalThis.lumine = previous;
  }
}

test("small real source-backed applied edits send bounded text without touching lazy strings", async () => {
  const requests = await mirrorSourceEdits("before", (buffer) =>
    buffer.transact(() => {
      buffer.setText(new PieceTree("after 🦉\r\n"));
      buffer.append(new PieceTree("tail"));
    }),
  );
  assert.deepEqual(
    requests.map(({ operation }) => operation),
    ["edit"],
  );
  assert.equal(requests[0].data.changes.length, 2);
});

test("multipart batches of source-backed independent edits replay exactly", async () => {
  const requests = await mirrorSourceEdits("row;\n".repeat(260), (buffer) => {
    buffer.setTextInIndependentRanges(
      Array.from({ length: 260 }, (_, row) => ({
        range: [
          [row, 0],
          [row, 0],
        ],
        text: new PieceTree("🦉_"),
      })),
    );
  });
  assert.equal(requests[0].operation, "edit-begin");
  assert.deepEqual(
    requests
      .filter(({ operation }) => operation === "edit-chunk")
      .map(({ data }) => data.changes.length),
    [128, 128, 4],
  );
  assert.equal(requests.at(-1).operation, "edit-commit");
});

test("combined source-backed text exceeding one packet splits otherwise small changes", async () => {
  const requests = await mirrorSourceEdits("before", (buffer) =>
    buffer.transact(() => {
      buffer.setText(new PieceTree("a".repeat(40000)));
      buffer.append(new PieceTree("b".repeat(40000)));
    }),
  );
  assert.deepEqual(
    requests.map(({ operation }) => operation),
    ["edit-begin", "edit-chunk", "edit-chunk", "edit-commit"],
  );
  assert.deepEqual(
    requests
      .filter(({ operation }) => operation === "edit-chunk")
      .map(({ data }) => data.changes[0].text.length),
    [40000, 40000],
  );
});

test("large source-backed insertions preserve Unicode and line endings through acknowledged text packets", async () => {
  const text = ("x".repeat(65535) + "🦉\r\n").repeat(3);
  const requests = await mirrorSourceEdits("before", (buffer) =>
    buffer.setText(new PieceTree(text)),
  );
  const packets = requests.filter(({ operation }) => operation === "edit-text-chunk");
  assert.ok(packets.length >= 3);
  assert.equal(packets.map(({ data }) => data.text).join(""), text);
  assert.equal(requests[0].operation, "edit-begin");
  assert.equal(requests[1].operation, "edit-text-begin");
  assert.equal(requests[1].data.length, text.length);
  assert.equal(requests.at(-2).operation, "edit-text-end");
  assert.equal(requests.at(-1).operation, "edit-commit");
});

test("an insertion beyond MAX_STRING_LENGTH stops after its first packet without materialization", async () => {
  const { constants } = require("node:buffer");
  let huge = new PieceTree("x".repeat(4096));
  while (huge.length <= constants.MAX_STRING_LENGTH)
    huge = huge.replace(huge.length, huge.length, huge);
  const buffer = new TextBuffer({ text: "before" });
  const batches = [];
  const subscription = buffer.onDidApplyChanges((batch) => batches.push(batch));
  const session = { id: 1, controller: new AbortController() };
  const requests = [];
  const controls = [];
  const client = {
    async request(operation, data) {
      requests.push({ operation, data });
      if (operation === "edit-text-chunk") session.controller.abort();
    },
    send: (message) => controls.push(message),
  };
  try {
    buffer.setText(huge);
    assert.equal(batches.length, 1);
    await assert.rejects(
      Service.prototype.sendEdits.call(
        Object.create(Service.prototype),
        client,
        session,
        withoutLazyText(batches[0]),
      ),
      { name: "AbortError" },
    );
    assert.deepEqual(
      requests.map(({ operation }) => operation),
      ["edit-begin", "edit-text-begin", "edit-text-chunk"],
    );
    assert.equal(requests[1].data.length, huge.length);
    assert.equal(requests[2].data.text.length, 4096);
    assert.deepEqual(controls, [{ type: "control", operation: "release", session: 1 }]);
  } finally {
    subscription.dispose();
    buffer.destroy();
  }
});

test("source text transfer waits for each packet acknowledgement before sending the next", async () => {
  const buffer = new TextBuffer({ text: "before" });
  const batches = [];
  const subscription = buffer.onDidApplyChanges((batch) => batches.push(batch));
  const session = { id: 1, controller: new AbortController() };
  let announce, acknowledge;
  const firstPacket = new Promise((resolve) => {
    announce = resolve;
  });
  const ack = new Promise((resolve) => {
    acknowledge = resolve;
  });
  let packets = 0;
  const client = {
    async request(operation) {
      if (operation !== "edit-text-chunk") return;
      packets++;
      if (packets === 1) {
        announce();
        await ack;
      }
    },
    send() {},
  };
  try {
    buffer.setText(new PieceTree("x".repeat(150000)));
    const sending = Service.prototype.sendEdits.call(
      Object.create(Service.prototype),
      client,
      session,
      withoutLazyText(batches[0]),
    );
    await firstPacket;
    await new Promise(setImmediate);
    assert.equal(packets, 1);
    acknowledge();
    await sending;
    assert.ok(packets > 1);
  } finally {
    acknowledge();
    subscription.dispose();
    buffer.destroy();
  }
});
