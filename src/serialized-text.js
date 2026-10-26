const { PieceTree } = require("./text-model");
const { isDeepStrictEqual } = require("node:util");

const INLINE_TEXT_LIMIT = 1024 * 1024;

function isSegmentedText(value) {
  return value?.type === "LumineText" && value.version === 1;
}

function serializeText(snapshot, deferred = false) {
  return snapshot.serializeSnapshot(deferred);
}

function deserializeText(value) {
  return PieceTree.deserializeSnapshot(value);
}

// Preserve immutable text roots while retaining the JSON value semantics of
// all other package state. Layout capture must not flatten document payloads.
function cloneSessionSnapshot(state) {
  const texts = [];
  const token = `lumine-snapshot-${require("node:crypto").randomUUID()}`;
  return JSON.parse(
    JSON.stringify(state, function (key, value) {
      const original = this[key];
      if (original instanceof PieceTree || isSegmentedText(original)) {
        texts.push(original instanceof PieceTree ? original : deserializeText(original));
        return { [token]: texts.length - 1 };
      }
      if (typeof value === "string" && value.length >= INLINE_TEXT_LIMIT) {
        texts.push(value);
        return { [token]: texts.length - 1 };
      }
      return value;
    }),
    (_key, value) => {
      if (value && Object.hasOwn(value, token)) return texts[value[token]];
      return value?.type === "Buffer" ? Buffer.from(value.data) : value;
    },
  );
}

function portableSessionSnapshot(state) {
  const snapshot = cloneSessionSnapshot(state);
  const visit = (value) => {
    if (value instanceof PieceTree) return value.serializeSnapshot(false);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object" && !Buffer.isBuffer(value))
      for (const key of Object.keys(value)) value[key] = visit(value[key]);
    return value;
  };
  return visit(snapshot);
}

function sessionSnapshotsEqual(left, right) {
  if (left === right) return true;
  // Private roots are intentionally invisible to ordinary structural equality.
  // A different root may represent edits made while a previous save yielded.
  if (left instanceof PieceTree || right instanceof PieceTree) return false;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) return isDeepStrictEqual(left, right);
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sessionSnapshotsEqual(left[key], right[key]))
  );
}

module.exports = {
  INLINE_TEXT_LIMIT,
  serializeText,
  deserializeText,
  isSegmentedText,
  cloneSessionSnapshot,
  portableSessionSnapshot,
  sessionSnapshotsEqual,
};
