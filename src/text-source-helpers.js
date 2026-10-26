const { PieceTree } = require("./text-model");

// Preserve the usual insertion policy without crossing the string limit. Most
// snapshots already use the requested ending and return their shared root.
function normalizeLineEndings(text, ending) {
  if (typeof text === "string") return text.replace(/\r?\n/g, ending);
  if (!(text instanceof PieceTree))
    throw new TypeError("Expected text or an immutable text snapshot");
  const endings = text.getLineEndings();
  if (endings.size === 0 || (endings.size === 1 && endings.has(ending))) return text;
  let result = new PieceTree();
  let pendingCR = "";
  let offset = 0;
  for (const chunk of text.chunks()) {
    const joined = pendingCR + chunk;
    pendingCR = joined.endsWith("\r") ? "\r" : "";
    const part = pendingCR ? joined.slice(0, -1) : joined;
    const normalized = part.replace(/\r?\n/g, ending);
    const inserted = normalized === part ? text.subtext(offset, offset + part.length) : normalized;
    result = result.replace(result.length, result.length, inserted);
    offset += part.length;
  }
  return pendingCR ? result.replace(result.length, result.length, pendingCR) : result;
}

function rangeIsBlank(source, start = 0, end = source.length) {
  const read = source.reader(4096);
  for (let offset = start; offset < end;) {
    const part = read(offset).slice(0, end - offset);
    if (/\S/.test(part)) return false;
    offset += part.length;
  }
  return true;
}

function leadingIndentation(source, start, end, tabLength, initialColumn = 0) {
  const read = source.reader(4096);
  let offset = start,
    columns = initialColumn;
  while (offset < end) {
    const part = read(offset);
    const count = Math.min(part.length, end - offset);
    for (let index = 0; index < count; index++) {
      if (part[index] === " ") columns++;
      else if (part[index] === "\t") columns += tabLength - (columns % tabLength);
      else return { columns, length: offset + index - start, level: columns / tabLength };
    }
    offset += count;
  }
  return { columns, length: end - start, level: columns / tabLength };
}

function trimmedRange(source, start, end) {
  const read = source.reader(4096);
  while (start < end) {
    const part = read(start).slice(0, end - start);
    const index = part.search(/\S/);
    if (index >= 0) {
      start += index;
      break;
    }
    start += part.length;
  }
  while (end > start) {
    const offset = Math.max(start, end - 4096);
    const part = source.slice(offset, end);
    const trimmed = part.trimEnd();
    if (trimmed.length) {
      end = offset + trimmed.length;
      break;
    }
    end = offset;
  }
  return { start, end };
}

module.exports = { normalizeLineEndings, rangeIsBlank, leadingIndentation, trimmedRange };
