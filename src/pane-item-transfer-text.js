const { PieceTree } = require("./text-model");

const CHUNK_LENGTH = 64 * 1024;

function capture(item) {
  return item.getBuffer?.()?.getTextSnapshot?.() ?? item.getText?.();
}

function matches(item, captured) {
  if (captured === undefined) return true;
  return capture(item) === captured;
}

function restore(item, captured) {
  if (captured instanceof PieceTree) {
    const buffer = item.getBuffer();
    buffer.setTextInRange(buffer.getRange(), captured, { normalizeLineEndings: false });
  } else item.setText(captured);
}

function descriptor(captured) {
  if (captured === undefined) return {};
  if (captured.length <= CHUNK_LENGTH)
    return { modifiedText: typeof captured === "string" ? captured : captured.toString() };
  return { textTransfer: { version: 1, length: captured.length } };
}

function validDescriptor(value) {
  return value?.version === 1 && Number.isSafeInteger(value.length) && value.length >= 0;
}

function readChunk(captured, request) {
  const offset = request?.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= captured.length)
    throw new Error("Invalid text transfer offset");
  const end = Math.min(captured.length, offset + CHUNK_LENGTH);
  return { offset, text: captured.slice(offset, end), length: captured.length };
}

async function receive(manager, token, metadata, options, assertAvailable) {
  if (!validDescriptor(metadata)) throw new Error("Invalid text transfer metadata");
  let text = new PieceTree();
  while (text.length < metadata.length) {
    assertAvailable();
    const offset = text.length;
    const part = await manager.readSessionData(token, { offset }, options);
    assertAvailable();
    if (
      part?.offset !== offset ||
      part.length !== metadata.length ||
      typeof part.text !== "string" ||
      part.text.length === 0 ||
      part.text.length > CHUNK_LENGTH ||
      part.text.length > metadata.length - offset
    )
      throw new Error("Invalid or incomplete text transfer chunk");
    text = text.replace(offset, offset, part.text);
  }
  return text;
}

module.exports = { capture, matches, restore, descriptor, validDescriptor, readChunk, receive };
