const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Emitter, Disposable } = require("@lumine-code/event-kit");
const Service = require("../../src/syntax-worker-service");
const TextBuffer = require("../../src/text-buffer");

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

for (const change of ["replacement", "recovery"])
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
      } else clients[0].close();
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
