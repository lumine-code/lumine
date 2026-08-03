const { PassThrough } = require("stream");
const RpcConnection = require("../lib/rpc-connection");

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

// The bytes of every message written so far, split back into JSON-RPC objects.
function sent(writer) {
  const messages = [];
  let buffer = Buffer.concat(writer.chunks);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return messages;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, boundary))[1]);
    const start = boundary + 4;
    if (buffer.length < start + length) return messages;
    messages.push(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
    buffer = buffer.subarray(start + length);
  }
}

// Inbound messages are queued and drained over several turns, so waiting a
// fixed number of them is a race. `flush` is only for asserting that something
// did *not* happen.
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

const waitUntil = async (condition, timeout = 5000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("RpcConnection", () => {
  let reader, writer, connection, logged;

  beforeEach(() => {
    jasmine.useRealClock();
    reader = new PassThrough();
    writer = new PassThrough();
    writer.chunks = [];
    writer.on("data", (chunk) => writer.chunks.push(chunk));
    logged = [];
    const log = (message) => logged.push(message);
    connection = new RpcConnection(reader, writer, {
      logger: { error: log, warn: log, info: log, log },
    });
    connection.listen();
  });

  afterEach(() => connection.dispose());

  it("resolves responses and reports protocol errors", async () => {
    const first = connection.request("answer", { a: 1 });
    await waitUntil(() => sent(writer).length === 1);
    expect(sent(writer)[0]).toEqual({ jsonrpc: "2.0", id: 0, method: "answer", params: { a: 1 } });
    reader.write(frame({ jsonrpc: "2.0", id: 0, result: 42 }));
    expect(await first).toBe(42);

    const second = connection.request("fail", {});
    await waitUntil(() => sent(writer).length === 2);
    reader.write(frame({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }));
    await expectAsync(second).toBeRejectedWithError(/no/);
  });

  it("omits params entirely when a request carries none", async () => {
    connection.request("shutdown").catch(() => {});
    await waitUntil(() => sent(writer).length === 1);
    expect(sent(writer)[0].params).toBeUndefined();
  });

  it("uses UTF-8 byte length when sending", async () => {
    connection.notify("unicode", { text: "Łódź" });
    await waitUntil(() => writer.chunks.length > 0);
    const chunk = Buffer.concat(writer.chunks);
    const boundary = chunk.indexOf("\r\n\r\n");
    // Deliberately measured on the buffer: the declared length is in bytes,
    // and the string length of this body is four characters short of it.
    const body = chunk.subarray(boundary + 4);
    expect(chunk.subarray(0, boundary).toString()).toContain(`Content-Length: ${body.length}`);
    expect(body.length).toBeGreaterThan(body.toString().length);
    expect(JSON.parse(body).params.text).toBe("Łódź");
  });

  it("answers server requests and refuses unknown methods", async () => {
    connection.onRequest("sum", ({ a, b }) => a + b);
    reader.write(frame({ jsonrpc: "2.0", id: 7, method: "sum", params: { a: 2, b: 3 } }));
    reader.write(frame({ jsonrpc: "2.0", id: 8, method: "nope", params: {} }));
    await waitUntil(() => sent(writer).length === 2);
    const replies = sent(writer);
    expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 7, result: 5 });
    expect(replies[1].error.code).toBe(-32601);
  });

  it("routes notifications to their handler, and the rest to the catch-all", async () => {
    const handled = [];
    const other = [];
    connection.onNotification("known", (params) => handled.push(params));
    connection.onOtherNotification((method, params) => other.push([method, params]));
    reader.write(frame({ jsonrpc: "2.0", method: "known", params: { n: 1 } }));
    reader.write(frame({ jsonrpc: "2.0", method: "unknown", params: { n: 2 } }));
    await waitUntil(() => handled.length && other.length);
    expect(handled).toEqual([{ n: 1 }]);
    expect(other).toEqual([["unknown", { n: 2 }]]);
  });

  describe("cancellation", () => {
    it("sends $/cancelRequest and stops waiting for the answer", async () => {
      const controller = new AbortController();
      const pending = connection.request("slow", {}, { signal: controller.signal });
      await waitUntil(() => sent(writer).length === 1);
      controller.abort();
      await expectAsync(pending).toBeRejected();
      await waitUntil(() => sent(writer).some((message) => message.method === "$/cancelRequest"));
      const cancel = sent(writer).find((message) => message.method === "$/cancelRequest");
      expect(cancel.params.id).toBe(0);
    });

    it("abandons without $/cancelRequest when the caller asked it not to", async () => {
      const controller = new AbortController();
      const pending = connection.request(
        "slow",
        {},
        {
          signal: controller.signal,
          cancelOnServer: false,
        },
      );
      await waitUntil(() => sent(writer).length === 1);
      controller.abort();
      await expectAsync(pending).toBeRejected();
      await flush();
      expect(sent(writer).some((message) => message.method === "$/cancelRequest")).toBe(false);

      // The answer still arrives; nobody is waiting for it, and it must not
      // surface as an unhandled rejection or a second settle.
      reader.write(frame({ jsonrpc: "2.0", id: 0, result: [] }));
      await flush();
    });

    it("rejects an already-aborted request without sending it", async () => {
      const controller = new AbortController();
      controller.abort();
      await expectAsync(
        connection.request("slow", {}, { signal: controller.signal }),
      ).toBeRejected();
      await flush();
      expect(sent(writer)).toEqual([]);
    });
  });

  // Closing a language server writes to a process that is on its way out. The
  // write fails after the fact, and an unheard stream error is an uncaught
  // exception in the renderer rather than a reported one.
  describe("when the server breaks the pipe", () => {
    it("reports a write failure instead of throwing it", async () => {
      const errors = [];
      connection.onError((error) => errors.push(error));
      writer.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      await waitUntil(() => errors.length > 0);
      expect(errors.map((error) => error.message)).toContain("write EPIPE");
    });

    it("resolves a notification that could not be delivered", async () => {
      connection.dispose();
      await expectAsync(connection.notify("exit")).toBeResolved();
      expect(logged.join("\n")).toContain("Could not deliver exit");
    });

    it("rejects a request made after disposal", async () => {
      connection.dispose();
      await expectAsync(connection.request("anything", {})).toBeRejected();
    });
  });
});
