const { constants } = require("node:buffer");
const crypto = require("node:crypto");

function hashText(text, normalizeLineEndings = false) {
  const hash = crypto.createHash("md5");
  let carry = "";
  for (let offset = 0; offset < text.length; offset += 65536) {
    let part = carry + text.slice(offset, offset + 65536);
    carry = "";
    const last = part.charCodeAt(part.length - 1);
    if (
      offset + 65536 < text.length &&
      ((last >= 0xd800 && last <= 0xdbff) || (normalizeLineEndings && last === 13))
    ) {
      carry = part.slice(-1);
      part = part.slice(0, -1);
    }
    hash.update(normalizeLineEndings ? part.replace(/\r\n?|\n/g, "\n") : part, "utf8");
  }
  return hash.digest("hex");
}

function normalizeText(text, platform, maxLength = constants.MAX_STRING_LENGTH) {
  let length = text.length;
  if (platform === "win32" && length > maxLength / 2) {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
      else if (code === 10 || code === 13) length++;
    }
  }
  if (length > maxLength)
    throw Object.assign(
      new RangeError(
        "Clipboard text exceeds the runtime string limit after newline normalization.",
      ),
      {
        code: "ERR_CLIPBOARD_TEXT_LIMIT",
      },
    );
  return text.replace(/\r\n?|\n/g, platform === "win32" ? "\r\n" : "\n");
}

// Custom metadata is optional. Its JSON escape expansion must be bounded
// before the stringifier attempts to allocate an individual escaped string.
function serializeMetadata(value, maxLength = 1024 * 1024) {
  let units = 0;
  return JSON.stringify(value, (key, item) => {
    units += 32 + key.length * 6 + (typeof item === "string" ? item.length * 6 : 0);
    if (units > maxLength)
      throw Object.assign(new RangeError("Clipboard metadata exceeds its serialization budget."), {
        code: "ERR_CLIPBOARD_METADATA_LIMIT",
      });
    return item;
  });
}

module.exports = { normalizeText, serializeMetadata, hashText };
