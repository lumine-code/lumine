// Read the export section only. Discovering a grammar name must not compile a
// second copy of the Wasm module in the renderer's JavaScript engine.
function grammarExportName(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (
    bytes.length < 8 ||
    !bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
  ) {
    throw new TypeError("Invalid Tree-sitter Wasm header");
  }
  let cursor = 8,
    limit = bytes.length;
  const uint = () => {
    let result = 0,
      shift = 0;
    for (let n = 0; n < 5; n++) {
      if (cursor >= limit) throw new RangeError("Truncated Wasm export section");
      const byte = bytes[cursor++];
      if (n === 4 && byte > 15) throw new RangeError("Invalid Wasm section length");
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return result;
      shift += 7;
    }
    throw new RangeError("Invalid Wasm integer");
  };
  while (cursor < bytes.length) {
    limit = bytes.length;
    const section = bytes[cursor++],
      length = uint(),
      end = cursor + length;
    if (end > bytes.length) throw new RangeError("Truncated Wasm section");
    if (section === 7) {
      limit = end;
      const count = uint(),
        names = [];
      for (let i = 0; i < count; i++) {
        const size = uint();
        if (cursor + size >= end) throw new RangeError("Truncated Wasm export");
        const name = bytes.toString("utf8", cursor, cursor + size);
        cursor += size;
        const kind = bytes[cursor++];
        uint();
        if (
          kind === 0 &&
          /^tree_sitter_[A-Za-z0-9_]+$/.test(name) &&
          !name.includes("_external_scanner_")
        ) {
          names.push(name.slice("tree_sitter_".length));
        }
      }
      if (cursor !== end) throw new RangeError("Invalid Wasm export section length");
      if (names.length !== 1) throw new Error("Wasm must export exactly one Tree-sitter grammar");
      return names[0];
    }
    cursor = end;
  }
  throw new Error("Wasm has no Tree-sitter grammar export");
}

module.exports = { grammarExportName };
