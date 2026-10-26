const { test } = require("node:test");
const assert = require("node:assert/strict");
const Client = require("../../src/syntax-worker-client");
const Endpoint = require("../../src/syntax-worker-endpoint");
const tick = () => new Promise(setImmediate);

function connection(dispatch) {
  const packets = [];
  let endpoint;
  const transport = {
    postMessage(message, transfer = []) {
      packets.push(message);
      const clone = structuredClone(message, { transfer });
      setImmediate(() => endpoint.receive(clone));
    },
    terminate() {
      endpoint.close();
    },
  };
  const client = new Client({ workerFactory: () => transport });
  endpoint = new Endpoint({
    dispatch,
    send(message, transfer = []) {
      const clone = structuredClone(message, { transfer });
      setImmediate(() => transport.onmessage({ data: clone }));
    },
  });
  return { client, endpoint, packets };
}

test("streams apply backpressure until asynchronous consumers accept transferred packets", async () => {
  let release,
    afterFirst = false;
  const { client, endpoint } = connection(async (_op, _data, { emit }) => {
    const values = new Uint32Array([1, 2, 3]);
    const response = await emit(values, [values.buffer]);
    assert.deepEqual(response, { accepted: 3 });
    assert.equal(values.byteLength, 0);
    afterFirst = true;
    await emit("second");
    return "done";
  });
  try {
    const chunks = [];
    const result = client.request("stream", null, {
      async onChunk(value) {
        chunks.push(value);
        if (chunks.length === 1)
          await new Promise((resolve) => {
            release = resolve;
          });
        return { accepted: 3 };
      },
    });
    while (!release) await tick();
    assert.equal(afterFirst, false);
    release();
    assert.equal(await result, "done");
    assert.deepEqual([...chunks[0]], [1, 2, 3]);
    assert.equal(chunks[1], "second");
    assert.equal(endpoint.jobs.size, 0);
    assert.equal(client.pending.size, 0);
  } finally {
    client.close();
  }
});

test("cancelling a blocked stream releases its acknowledgement wait and rejects its caller", async () => {
  const controller = new AbortController();
  let received = false,
    finished = false,
    release;
  const { client, endpoint } = connection(async (_op, _data, { emit }) => {
    try {
      await emit("first");
      await emit("must not publish");
    } finally {
      finished = true;
    }
  });
  try {
    const result = client.request("stream", null, {
      signal: controller.signal,
      onChunk() {
        received = true;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const rejection = assert.rejects(result, { name: "AbortError" });
    while (!received) await tick();
    controller.abort();
    await rejection;
    while (!finished) await tick();
    release();
    await tick();
    assert.equal(endpoint.jobs.size, 0);
    assert.equal(client.pending.size, 0);
  } finally {
    client.close();
  }
});

test("consumer failures cancel streams and later requests remain usable", async () => {
  const { client } = connection(async (op, value, { emit }) => {
    if (op === "stream") await emit(value);
    return value;
  });
  try {
    await assert.rejects(
      client.request("stream", 3, {
        onChunk() {
          throw new Error("decode");
        },
      }),
      /decode/,
    );
    assert.equal(await client.request("echo", 7), 7);
  } finally {
    client.close();
  }
});

test("dispatch invalidation releases the transport acknowledgement without consumer cooperation", async () => {
  let invalidate, release, abandoned;
  const invalidation = new Promise((_, reject) => {
    invalidate = reject;
  });
  const { client, endpoint } = connection(async (_op, _data, { emit }) =>
    Promise.race([
      emit("first").catch((error) => {
        abandoned = error;
        throw error;
      }),
      invalidation,
    ]),
  );
  try {
    const result = client.request("stream", null, {
      onChunk: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const rejection = assert.rejects(result, { name: "AbortError" });
    while (!release) await tick();
    invalidate(Object.assign(new Error("The document changed"), { name: "AbortError" }));
    await rejection;
    assert.equal(abandoned?.name, "AbortError");
    assert.equal(endpoint.jobs.size, 0);
    assert.equal(client.pending.size, 0);
  } finally {
    release?.();
    client.close();
  }
});

test("closing the connection rejects every pending request", async () => {
  const { client } = connection(() => new Promise(() => {}));
  const a = assert.rejects(client.request("wait", 1), { name: "AbortError" });
  const b = assert.rejects(client.request("wait", 2), { name: "AbortError" });
  client.close();
  await Promise.all([a, b]);
  assert.equal(client.pending.size, 0);
});
