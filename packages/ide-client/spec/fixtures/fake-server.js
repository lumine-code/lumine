// Dependency-free stdio language server for specs. Speaks Content-Length
// framed JSON-RPC. Behavior is scripted through the JSON blob in argv[2]:
//   capabilities  initialize result capabilities
//   serverInfo    initialize result serverInfo
//   responses     { method: cannedResult } for any other request
//   onOpen        messages the server emits after receiving didOpen
// Test-only requests: test/getReceived returns every message received so far,
// test/notify emits params verbatim (server-initiated traffic), test/crash
// exits with code 1.

let buffer = Buffer.alloc(0);
const config = JSON.parse(process.argv[2] || "{}");
const received = [];

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(message) {
  received.push(message);
  const { id, method, params } = message;
  if (method === "initialize")
    return reply(id, { capabilities: config.capabilities || {}, serverInfo: config.serverInfo });
  if (method === "shutdown") return reply(id, null);
  if (method === "exit") process.exit(0);
  if (method === "test/getReceived") return reply(id, received);
  if (method === "test/notify") {
    send(params);
    return reply(id, null);
  }
  if (method === "test/crash") process.exit(1);
  if (method === "textDocument/didOpen") {
    for (const item of config.onOpen || []) send(item);
    return;
  }
  if (id != null) {
    const canned = (config.responses || {})[method];
    reply(id, canned === undefined ? null : canned);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = buffer.subarray(0, boundary).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = boundary + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});
