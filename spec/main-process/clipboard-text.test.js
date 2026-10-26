const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeText, serializeMetadata, hashText } = require("../../src/clipboard-text");
const crypto = require("node:crypto");

test("clipboard newline expansion is checked before replacement", () => {
  assert.equal(normalizeText("😀\r\nx\ny\r", "win32", 10), "😀\r\nx\r\ny\r\n");
  assert.throws(() => normalizeText("😀\r\nx\ny\r", "win32", 9), {
    code: "ERR_CLIPBOARD_TEXT_LIMIT",
  });
  assert.equal(normalizeText("😀\r\nx\ny\r", "linux", 10), "😀\nx\ny\n");
});

test("clipboard JSON metadata rejects escaped expansion before allocation", () => {
  assert.throws(() => serializeMetadata({ text: "\u0000".repeat(1000) }, 100), {
    code: "ERR_CLIPBOARD_METADATA_LIMIT",
  });
  const value = JSON.parse('{"__proto__":{"x":1},"text":"😀\\r\\n"}');
  assert.deepEqual(JSON.parse(serializeMetadata(value)), value);
  assert.throws(() => serializeMetadata({ bigint: 1n }), TypeError);
});

test("bounded clipboard signatures preserve UTF-8 surrogate and CRLF boundary semantics", () => {
  for (const boundary of ["😀", "\r\n", "\ud800", "\r"]) {
    const text = "x".repeat(65535) + boundary + "end";
    const expected = (value) => crypto.createHash("md5").update(value, "utf8").digest("hex");
    assert.equal(hashText(text), expected(text));
    assert.equal(hashText(text, true), expected(text.replace(/\r\n?|\n/g, "\n")));
  }
});
