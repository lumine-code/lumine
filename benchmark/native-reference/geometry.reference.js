const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extentForText } = require("../../src/helpers");
const { TextBuffer } = require("../../script/native-superstring-reference").load();

test("UTF-16 extents agree with historical native storage", () => {
  for (const text of ["", "\r", "\r\n", "😀e\u0301", "a\r\nb\nc\r", "line\n".repeat(10000)])
    assert.deepEqual(extentForText(text), new TextBuffer(text).getExtent());
});
