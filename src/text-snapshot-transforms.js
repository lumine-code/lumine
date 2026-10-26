const { PieceTree } = require("./text-model");
const CHUNK_UNITS = 32768;
const caseIgnorable = /\p{Case_Ignorable}/u;
const cased = /\p{Cased}/u;
const firstSignificant = /[^\p{Case_Ignorable}]/u;

const high = (code) => code >= 0xd800 && code <= 0xdbff;
const low = (code) => code >= 0xdc00 && code <= 0xdfff;

function* chunks(source, start = 0, size = CHUNK_UNITS) {
  size = Math.max(2, size);
  while (start < source.length) {
    let end = Math.min(source.length, start + size);
    if (end < source.length && high(source.charCodeAt(end - 1)) && low(source.charCodeAt(end)))
      end--;
    yield { start, end, text: source.slice(start, end) };
    start = end;
  }
}

function lastSignificant(text) {
  for (let end = text.length; end > 0;) {
    let start = end - 1;
    if (start > 0 && low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start--;
    const character = text.slice(start, end);
    if (!caseIgnorable.test(character)) return character;
    end = start;
  }
  return null;
}

function* followingIsCased(source, offset) {
  for (const chunk of chunks(source, offset)) {
    const match = firstSignificant.exec(chunk.text);
    if (match) return cased.test(match[0]);
    yield null;
  }
  return false;
}

// Default Unicode lowercasing has one context-sensitive mapping: Final_Sigma.
// Supply the original cased/ignorable context at both chunk edges to V8's
// native mapping, without retaining an arbitrarily long combining-mark run.
// https://www.unicode.org/Public/UCD/latest/ucd/SpecialCasing.txt
function* caseParts(source, kind, size = CHUNK_UNITS) {
  let precededByCased = false;
  for (const chunk of chunks(source, 0, size)) {
    let text;
    if (kind === "upper") text = chunk.text.toUpperCase();
    else {
      const last = lastSignificant(chunk.text);
      const following = last === "Σ" && (yield* followingIsCased(source, chunk.end));
      text = ((precededByCased ? "A" : ".") + chunk.text + (following ? "A" : "."))
        .toLowerCase()
        .slice(1, -1);
      if (last !== null) precededByCased = cased.test(last);
    }
    yield {
      text: text === chunk.text ? source.subtext(chunk.start, chunk.end) : new PieceTree(text),
      changed: text !== chunk.text,
    };
  }
}

function* reverseParts(source, size = CHUNK_UNITS) {
  let end = source.length;
  while (end > 0) {
    let start = Math.max(0, end - size);
    if (start > 0 && low(source.charCodeAt(start)) && high(source.charCodeAt(start - 1))) start--;
    yield {
      text: new PieceTree(Array.from(source.slice(start, end)).reverse().join("")),
      changed: true,
    };
    end = start;
  }
}

function parts(source, kind, size) {
  if (kind === "reverse") return reverseParts(source, size);
  if (kind === "upper" || kind === "lower") return caseParts(source, kind, size);
  throw new TypeError(`Unknown text transform: ${kind}`);
}

function transformSnapshotSync(source, kind, { chunkSize = CHUNK_UNITS } = {}) {
  let result = new PieceTree(),
    changed = false;
  for (const part of parts(source, kind, chunkSize))
    if (part) {
      result = result.replace(result.length, result.length, part.text);
      changed ||= part.changed;
    }
  return changed ? result : source;
}

async function transformSnapshot(source, kind, { check = () => {}, chunkSize = CHUNK_UNITS } = {}) {
  await new Promise((resolve) => setImmediate(resolve));
  check();
  let result = new PieceTree(),
    changed = false,
    deadline = performance.now() + 4;
  for (const part of parts(source, kind, chunkSize)) {
    if (part) {
      result = result.replace(result.length, result.length, part.text);
      changed ||= part.changed;
    }
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      check();
      deadline = performance.now() + 4;
    }
  }
  check();
  return changed ? result : source;
}

module.exports = { transformSnapshot, transformSnapshotSync };
