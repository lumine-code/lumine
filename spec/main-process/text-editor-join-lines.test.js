const { test } = require("node:test");
const assert = require("node:assert/strict");
const TextBuffer = require("../../src/text-buffer");
const { joinEdits } = require("../../src/text-editor-join-lines");

function expected(text) {
  const rows = text.split(/\r?\n/);
  let joined = rows.shift();
  for (const row of rows) {
    joined = joined.replace(/[ \t]+$/, "");
    if (joined.length && row.length) joined += " ";
    const first = row.search(/\S/);
    joined += first < 0 ? row : row.slice(first);
  }
  return joined;
}
test("streamed joining matches line-by-line whitespace and CRLF semantics", async () => {
  const examples = [
    "a \r\n  b\n\n c\r\n  ",
    " \t\n a\n\t\n\n b",
    "a\n \t\n \t",
    "\n\n",
    "\t\n\u00a0\n c",
    "a\nb \t\nc",
    "a\n \n\tb\n",
    "😀 \n 𐐀",
  ];
  for (const text of examples) {
    const buffer = new TextBuffer(text);
    await buffer.applyTextEdits(
      joinEdits(buffer.getTextSnapshot(), [{ start: 0, end: buffer.getLastRow() }]),
    );
    assert.equal(buffer.getText(), expected(text), JSON.stringify(text));
    buffer.destroy();
  }
});
