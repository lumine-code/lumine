const { PassThrough } = require("stream");
const JsonRpcConnection = require("../lib/json-rpc-connection");

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

describe("JsonRpcConnection", () => {
  let reader, writer, connection;
  beforeEach(() => {
    reader = new PassThrough();
    writer = new PassThrough();
    connection = new JsonRpcConnection(reader, writer);
  });
  afterEach(() => connection.dispose());

  it("parses fragmented and adjacent messages", () => {
    const received = [];
    connection.onNotification("one", (params) => received.push(params));
    const data = Buffer.concat([
      frame({ jsonrpc: "2.0", method: "one", params: 1 }),
      frame({ jsonrpc: "2.0", method: "one", params: 2 }),
    ]);
    reader.write(data.subarray(0, 13));
    reader.write(data.subarray(13));
    expect(received).toEqual([1, 2]);
  });

  it("uses UTF-8 byte length when sending", (done) => {
    writer.once("data", (header) => {
      expect(header.toString()).toContain("Content-Length:");
      writer.once("data", (body) => {
        expect(JSON.parse(body).params).toBe("Łódź");
        done();
      });
    });
    connection.notify("unicode", "Łódź");
  });

  it("resolves responses and reports protocol errors", async () => {
    const first = connection.request("answer", {});
    reader.write(frame({ jsonrpc: "2.0", id: 1, result: 42 }));
    expect(await first).toBe(42);
    const second = connection.request("fail", {});
    reader.write(frame({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "no" } }));
    await expectAsync(second).toBeRejectedWithError("no");
  });

  it("answers server requests", (done) => {
    connection.onRequest("sum", ({ a, b }) => a + b);
    let chunks = [];
    writer.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunks.length === 2) {
        expect(JSON.parse(chunks[1]).result).toBe(5);
        done();
      }
    });
    reader.write(frame({ jsonrpc: "2.0", id: 7, method: "sum", params: { a: 2, b: 3 } }));
  });

  it("sends cancellation for aborted requests", (done) => {
    const controller = new AbortController();
    const chunks = [];
    writer.on("data", (chunk) => {
      chunks.push(chunk);
      if (chunks.length === 4) {
        expect(JSON.parse(chunks[3]).method).toBe("$/cancelRequest");
        done();
      }
    });
    connection.request("slow", {}, { signal: controller.signal }).catch(() => {});
    controller.abort();
  });
});
