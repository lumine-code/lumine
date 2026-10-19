const fs = require("node:fs");
const crypto = require("node:crypto");
const { once } = require("node:events");
const iconv = require("iconv-lite");
const { diffChars, diffLines } = require("diff");
const PieceTree = require("./piece-tree");
const { DocumentCore } = require("./document-core");
const Patch = require("./text-patch");
const zero = { row: 0, column: 0 };
const traverse = (a, b) => ({ row: a.row + b.row, column: b.row ? b.column : a.column + b.column });
const distance = (a, b) => ({
  row: a.row - b.row,
  column: a.row === b.row ? a.column - b.column : a.column,
});
const compare = (a, b) => a.row - b.row || a.column - b.column;
const asText = (text) => (text instanceof PieceTree ? text : new PieceTree(text));
const extent = (text) => text.positionAt(text.length);
const livePatch = () => new Patch({ discardIdentityChanges: true });

function encodingName(value) {
  const encoding = value || "utf8";
  if (!iconv.encodingExists(encoding)) throw new Error(`Invalid encoding name: ${encoding}`);
  return encoding;
}

function searchPattern(pattern, endIsLineBoundary, unicodeSets) {
  let result = "",
    depth = 0;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      result += character + (pattern[++index] ?? "");
      continue;
    }
    if (character === "[" && (!depth || unicodeSets)) depth++;
    if (character === "]" && depth) depth--;
    if (!depth && character === "^") result += "(?<![^\\n])";
    else if (!depth && character === "$")
      result += endIsLineBoundary ? "(?=\\r?\\n|$)" : "(?=\\r?\\n)";
    else result += character;
  }
  return result;
}

async function readSource(source, encoding) {
  const decoder = iconv.getDecoder(encodingName(encoding), { stripBOM: false });
  let text = new PieceTree();
  const stream = typeof source === "string" ? fs.createReadStream(source) : source;
  for await (const chunk of stream) {
    const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (decoded) text = text.replace(text.length, text.length, decoded);
  }
  const tail = decoder.end();
  if (tail) text = text.replace(text.length, text.length, tail);
  return text;
}

function* encode(snapshot, encoding) {
  const encoder = iconv.getEncoder(encodingName(encoding));
  let carry = "";
  for (const part of snapshot.chunks()) {
    let text = carry + part;
    carry = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      carry = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text) yield encoder.write(text);
  }
  if (carry) yield encoder.write(carry);
  const tail = encoder.end();
  if (tail?.length) yield tail;
}

function diff(before, after) {
  const patch = livePatch();
  if (before === after) return patch;
  let start = 0,
    end = 0;
  const length = Math.min(before.length, after.length);
  const a = before.reader(32768),
    b = after.reader(32768);
  while (start < length) {
    const left = a(start),
      right = b(start),
      count = Math.min(left.length, right.length);
    if (left.slice(0, count) === right.slice(0, count)) {
      start += count;
      continue;
    }
    while (start < length && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    break;
  }
  while (end < length - start) {
    const count = Math.min(32768, length - start - end);
    if (
      before.slice(before.length - end - count, before.length - end) ===
      after.slice(after.length - end - count, after.length - end)
    ) {
      end += count;
      continue;
    }
    while (
      end < length - start &&
      before.charCodeAt(before.length - end - 1) === after.charCodeAt(after.length - end - 1)
    )
      end++;
    break;
  }
  if (start === before.length && start === after.length) return patch;
  const oldMiddle = before.subtext(start, before.length - end),
    newMiddle = after.subtext(start, after.length - end);
  let parts = null;
  if (oldMiddle.length && newMiddle.length) {
    const oldValue = oldMiddle.toString(),
      newValue = newMiddle.toString();
    if (oldMiddle.length + newMiddle.length < 262144)
      parts = diffChars(oldValue, newValue, { timeout: 100 });
    parts ??= diffLines(oldValue, newValue, { timeout: 1000 });
  }
  if (!parts) {
    // Keep timeout degradation explicit: common prefix/suffix trimming means
    // this coarse replacement need not span the full document.
    if (oldMiddle.length && newMiddle.length) patch.isCoarse = true;
    patch.splice(
      before.positionAt(start),
      extent(oldMiddle),
      extent(newMiddle),
      oldMiddle,
      newMiddle,
    );
    return patch;
  }
  let oldOffset = start,
    newOffset = start;
  for (let index = 0; index < parts.length;) {
    if (!parts[index].added && !parts[index].removed) {
      oldOffset += parts[index].value.length;
      newOffset += parts[index].value.length;
      index++;
      continue;
    }
    const oldStart = oldOffset,
      newStart = newOffset;
    while (index < parts.length && (parts[index].added || parts[index].removed)) {
      if (parts[index].added) newOffset += parts[index].value.length;
      else oldOffset += parts[index].value.length;
      index++;
    }
    const removed = before.subtext(oldStart, oldOffset),
      inserted = after.subtext(newStart, newOffset);
    patch.splice(after.positionAt(newStart), extent(removed), extent(inserted), removed, inserted);
  }
  return patch;
}

// Authoritative JavaScript text storage. The editor facade owns notification
// ordering and marker/selection policy; this layer owns immutable text roots,
// prepared edits, saved-base identity, search, and snapshot-based file I/O.
class TextStore {
  #document;
  #base;
  #changes = livePatch();
  #revision = 0;
  #digest = null;
  #saveSequence = 0;
  #lastSaved = 0;
  #resetGeneration = 0;
  #lines = new Map();
  #lastLine = null;
  #wordIndex;

  constructor(text = "", { wordIndex = true } = {}) {
    this.#base = asText(text);
    this.#document = new DocumentCore(this.#base, { historyLimit: 0 });
    this.#wordIndex = wordIndex ? new (require("./word-index"))() : null;
  }
  get #text() {
    return this.#document.getTextSnapshot();
  }
  getTextSnapshot() {
    return this.#text;
  }
  getText() {
    return this.#text.toString();
  }
  getLength() {
    return this.#text.length;
  }
  getLineCount() {
    return this.#text.lineCount;
  }
  getExtent() {
    return extent(this.#text);
  }

  #line(row) {
    if (!Number.isInteger(row) || row < 0 || row >= this.getLineCount()) return undefined;
    let line = this.#lines.get(row);
    if (line) return line;
    const text = this.#text;
    const start = text.lineStart(row);
    const last = row === text.lineCount - 1;
    const end = last ? text.length : text.lineStart(row + 1);
    const ending = last ? "" : text.charCodeAt(end - 2) === 13 ? "\r\n" : "\n";
    line = { start, length: end - start - ending.length, ending };
    if (this.#lines.size === 256) this.#lines.delete(this.#lines.keys().next().value);
    this.#lines.set(row, line);
    return line;
  }
  #invalidateLines() {
    this.#lines.clear();
    this.#lastLine = null;
  }
  lineEndingForRow(row) {
    return this.#line(row)?.ending;
  }
  lineLengthForRow(row) {
    return this.#line(row)?.length;
  }
  lineForRow(row) {
    if (this.#lastLine?.row === row) return this.#lastLine.text;
    const line = this.#line(row);
    if (!line) return undefined;
    const text = this.#text.slice(line.start, line.start + line.length);
    // Rendering and cursor operations repeatedly request the same long line.
    // Keep one materialized line and bounded geometry, never a document cache.
    this.#lastLine = { row, text };
    return text;
  }
  getLines() {
    return Array.from(this.#text.lines());
  }

  clipPosition(position) {
    let row = Math.max(0, Math.min(this.getLineCount() - 1, Math.trunc(position.row) || 0));
    const column =
      position.row >= this.getLineCount()
        ? this.lineLengthForRow(row)
        : Math.max(0, Math.min(this.lineLengthForRow(row), Math.trunc(position.column) || 0));
    return { row, column };
  }
  characterIndexForPosition(position) {
    const clipped = this.clipPosition(position);
    return this.#line(clipped.row).start + clipped.column;
  }
  positionForCharacterIndex(index) {
    index = Math.max(0, Math.min(this.#text.length, Math.trunc(index) || 0));
    return this.clipPosition(this.#text.positionAt(index));
  }
  getCharacterAtPosition(position) {
    const index = this.characterIndexForPosition(position);
    return this.#text.slice(index, index + 1);
  }
  getTextInRange(range) {
    return this.#text.slice(
      this.characterIndexForPosition(range.start),
      this.characterIndexForPosition(range.end),
    );
  }
  hasAstral() {
    return this.#text.hasAstral;
  }

  prepareEdit(range, value) {
    return this.#prepare(
      this.characterIndexForPosition(range.start),
      this.characterIndexForPosition(range.end),
      asText(value),
    );
  }

  // Offsets address one source snapshot. The facade validates the independent-edit
  // contract; storage shares untouched pieces and publishes only one root.
  prepareEdits(edits) {
    const revision = this.#revision;
    const draft = this.#document.begin();
    try {
      draft.replaceAll(edits);
    } catch (error) {
      draft.abort();
      throw error;
    }
    const snapshot = draft.text;
    const deltas = draft.changeSet.changes;
    let active = true;
    return {
      snapshot,
      commit: () => {
        if (!active) throw new Error("Prepared edit is closed");
        active = false;
        if (revision !== this.#revision)
          throw Object.assign(new Error("Prepared edits no longer match the buffer revision"), {
            code: "ERR_STALE_EDIT",
          });
        let oldEnd = zero,
          newEnd = zero;
        let changes =
          this.#changes.getChangeCount() === 0
            ? Patch.fromIndependentChanges(
                deltas
                  .slice()
                  .reverse()
                  .map((delta) => {
                    const newStart = traverse(newEnd, distance(delta.oldRange.start, oldEnd));
                    oldEnd = delta.oldRange.end;
                    newEnd = traverse(newStart, extent(delta.inserted));
                    return {
                      oldStart: delta.oldRange.start,
                      oldEnd: delta.oldRange.end,
                      newStart,
                      newEnd,
                      oldTextSource: delta.removed,
                      newTextSource: delta.inserted,
                    };
                  }),
                { discardIdentityChanges: true },
              )
            : null;
        if (!changes) {
          changes = this.#changes.copy();
          for (const delta of deltas) {
            changes.splice(
              delta.oldRange.start,
              extent(delta.removed),
              extent(delta.inserted),
              delta.removed,
              delta.inserted,
            );
          }
        }
        draft.commit();
        this.#wordIndex?.invalidateBatch(deltas);
        this.#changes = changes;
        this.#invalidateLines();
        this.#revision++;
      },
      dispose: () => {
        active = false;
        draft.abort();
      },
    };
  }
  prepareEditFromChange(change) {
    const startPosition = change.newStart;
    const endPosition = traverse(startPosition, distance(change.oldEnd, change.oldStart));
    const start = this.#text.offsetAt(startPosition),
      end = this.#text.offsetAt(endPosition);
    const old = change.oldTextSource ?? asText(change.oldText);
    if (!this.#text.subtext(start, end).equals(old))
      throw new Error("Patch change does not match the current buffer");
    return this.#prepare(start, end, change.newTextSource ?? asText(change.newText));
  }

  #prepare(start, end, inserted) {
    const before = this.#text,
      revision = this.#revision;
    // Expand boundaries that split or create CRLF. Parser deltas and history
    // describe the same exact code units; cursor positions remain clipped.
    if (before.charCodeAt(start - 1) === 13 && before.charCodeAt(start) === 10) {
      start--;
      inserted = new PieceTree("\r").replace(1, 1, inserted);
    }
    if (before.charCodeAt(end - 1) === 13 && before.charCodeAt(end) === 10) {
      end++;
      inserted = inserted.replace(inserted.length, inserted.length, "\n");
    }
    if (
      before.charCodeAt(start - 1) === 13 &&
      (inserted.charCodeAt(0) === 10 || (!inserted.length && before.charCodeAt(end) === 10))
    ) {
      start--;
      inserted = new PieceTree("\r").replace(1, 1, inserted);
    }
    if (before.charCodeAt(end) === 10 && inserted.charCodeAt(inserted.length - 1) === 13) {
      end++;
      inserted = inserted.replace(inserted.length, inserted.length, "\n");
    }
    const removed = before.subtext(start, end);
    const draft = this.#document.begin().replace(start, end, inserted);
    const after = draft.text;
    let oldText,
      newText,
      active = true;
    const oldStart = Object.freeze(before.positionAt(start)),
      oldEnd = Object.freeze(before.positionAt(end)),
      newEnd = Object.freeze(after.positionAt(start + inserted.length));
    const change = Object.freeze({
      oldStart,
      oldEnd,
      newStart: oldStart,
      newEnd,
      startIndex: start,
      oldEndIndex: end,
      newEndIndex: start + inserted.length,
      oldTextSource: removed,
      newTextSource: inserted,
      get oldText() {
        return (oldText ??= removed.toString());
      },
      get newText() {
        return (newText ??= inserted.toString());
      },
    });
    const check = () => {
      if (!active) throw new Error("Prepared edit is closed");
    };
    return {
      getChange: () => {
        check();
        return change;
      },
      createPatch: () => {
        check();
        const patch = new Patch();
        patch.splice(oldStart, extent(removed), extent(inserted), removed, inserted);
        return patch;
      },
      commit: () => {
        check();
        active = false;
        if (revision !== this.#revision)
          throw Object.assign(new Error("Prepared edit no longer matches the buffer revision"), {
            code: "ERR_STALE_EDIT",
          });
        this.#changes.splice(oldStart, extent(removed), extent(inserted), removed, inserted);
        draft.commit();
        this.#wordIndex?.invalidate(oldStart.row, oldEnd.row, newEnd.row);
        this.#invalidateLines();
        this.#revision++;
      },
      dispose: () => {
        active = false;
        draft.abort();
      },
    };
  }

  setTextInRange(range, text) {
    const edit = this.prepareEdit(range, text);
    try {
      edit.commit();
    } finally {
      edit.dispose();
    }
  }
  setText(text) {
    this.setTextInRange({ start: zero, end: this.getExtent() }, text);
  }
  reset(text) {
    this.#wordIndex?.clear();
    this.#base = asText(text);
    this.#document = new DocumentCore(this.#base, { historyLimit: 0 });
    this.#invalidateLines();
    this.#changes = livePatch();
    this.#digest = null;
    this.#revision++;
    this.#resetGeneration++;
  }
  isModified() {
    return this.#changes.getChangeCount() !== 0;
  }
  diff(text) {
    return diff(this.#text, asText(text));
  }
  baseTextDigest() {
    if (!this.#digest) {
      const hash = crypto.createHash("sha256");
      for (const chunk of this.#base.chunks()) hash.update(Buffer.from(chunk, "utf16le"));
      this.#digest = hash.digest("hex");
    }
    return this.#digest;
  }
  serializeChanges() {
    return this.#changes.serialize();
  }
  deserializeChanges(bytes) {
    const patch = Patch.deserialize(bytes);
    for (const change of patch.getChanges()) {
      const edit = this.prepareEditFromChange(change);
      edit.commit();
    }
  }

  async load(source, options = {}, progress) {
    if (typeof options === "function") {
      progress = options;
      options = {};
    }
    if (!options.force && this.isModified()) return null;
    const before = this.#text;
    const text = await readSource(source, options.encoding);
    if (!options.force && (this.isModified() || !this.#text.equals(before))) return null;
    const patch = options.patch === false ? null : diff(this.#text, text);
    let error;
    try {
      if (progress?.(100, patch) === false) return null;
    } catch (caught) {
      error = caught;
    }
    if (!options.force && !this.#text.equals(before)) return null;
    this.reset(text);
    if (error) throw error;
    return patch;
  }
  loadSync(filePath, encoding = "utf8", progress) {
    if (this.isModified()) return undefined;
    const text = new PieceTree(
      iconv.decode(fs.readFileSync(filePath), encodingName(encoding), { stripBOM: false }),
    );
    const patch = diff(this.#text, text);
    let error;
    try {
      if (progress?.(100, patch) === false) return null;
    } catch (caught) {
      error = caught;
    }
    this.reset(text);
    if (error) throw error;
    return patch;
  }
  async baseTextMatchesFile(source, encoding) {
    const base = this.#base;
    return base.equals(await readSource(source, encoding));
  }
  async save(destination, encoding = "utf8") {
    encoding = encodingName(encoding);
    const snapshot = this.#text,
      sequence = ++this.#saveSequence;
    const resetGeneration = this.#resetGeneration;
    const stream =
      typeof destination === "string" ? fs.createWriteStream(destination) : destination;
    // Register completion before writing, including synchronously failing streams.
    const completion = once(stream, "finish");
    completion.catch(() => {});
    try {
      for (const chunk of encode(snapshot, encoding)) {
        if (!stream.write(chunk)) await once(stream, "drain");
      }
      stream.end();
      await completion;
      if (sequence > this.#lastSaved && resetGeneration === this.#resetGeneration) {
        this.#lastSaved = sequence;
        this.#base = snapshot;
        this.#digest = null;
        this.#changes = diff(snapshot, this.#text);
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  *#matches(regex, range) {
    const snapshot = this.#text;
    const start = range ? this.characterIndexForPosition(range.start) : 0;
    const end = range ? this.characterIndexForPosition(range.end) : snapshot.length;
    const contextStart = Math.max(0, start - 1);
    const text = snapshot.slice(contextStart, end);
    const pattern = typeof regex === "string" ? regex : regex.source;
    const flags =
      typeof regex === "string"
        ? "gm"
        : [...new Set(regex.flags.replace(/[gmy]/g, "") + "g")].join("");
    const endPosition = snapshot.positionAt(end);
    const endIsLineBoundary =
      end === snapshot.length || endPosition.column === this.lineLengthForRow(endPosition.row);
    const expression = new RegExp(
      searchPattern(pattern, endIsLineBoundary, flags.includes("v")),
      flags.replace("m", ""),
    );
    expression.lastIndex = start - contextStart;
    let previous;
    const initialPosition = snapshot.positionAt(contextStart);
    let row = initialPosition.row,
      lineStart = -initialPosition.column,
      nextNewline = text.indexOf("\n");
    // RegExp results are ordered and non-overlapping. Advance one line cursor
    // rather than searching the piece tree again for every match endpoint.
    const positionAt = (offset) => {
      while (nextNewline >= 0 && nextNewline < offset) {
        row++;
        lineStart = nextNewline + 1;
        nextNewline = text.indexOf("\n", lineStart);
      }
      const point = { row, column: offset - lineStart };
      if (text.charCodeAt(offset) === 10 && text.charCodeAt(offset - 1) === 13) point.column--;
      return point;
    };
    for (let match; (match = expression.exec(text));) {
      // V8 may move a Unicode lastIndex backwards when it splits a surrogate
      // pair. Context retained for anchors must never become a range result.
      if (match.index < start - contextStart) {
        const width =
          (expression.unicode || expression.unicodeSets) && text.codePointAt(match.index) > 0xffff
            ? 2
            : 1;
        expression.lastIndex = match.index + Math.max(match[0].length, width);
        continue;
      }
      const a = positionAt(match.index),
        b = positionAt(match.index + match[0].length);
      // Do not publish the unaddressable boundary between CR and LF twice.
      if (!previous || compare(previous.start, a) || compare(previous.end, b)) {
        previous = { start: a, end: b };
        yield previous;
      }
      if (!match[0].length) {
        const code = text.codePointAt(expression.lastIndex);
        expression.lastIndex +=
          (expression.unicode || expression.unicodeSets) && code > 0xffff ? 2 : 1;
      }
    }
  }
  findSync(regex) {
    return this.#matches(regex, null).next().value ?? null;
  }
  findAllSync(regex) {
    return Array.from(this.#matches(regex, null));
  }
  findInRangeSync(regex, range) {
    return this.#matches(regex, range).next().value ?? null;
  }
  findAllInRangeSync(regex, range) {
    return Array.from(this.#matches(regex, range));
  }
  async find(regex) {
    return this.#asyncFind(regex, null, false);
  }
  async findAll(regex) {
    return this.#asyncFind(regex, null, true);
  }
  async findInRange(regex, range) {
    return this.#asyncFind(regex, range, false);
  }
  async findAllInRange(regex, range) {
    return this.#asyncFind(regex, range, true);
  }

  async #asyncFind(regex, range, all) {
    const snapshot = new TextStore(this.#text);
    const pattern = typeof regex === "string" ? regex : new RegExp(regex.source, regex.flags);
    const bounds = range && { start: { ...range.start }, end: { ...range.end } };
    await new Promise((resolve) => setImmediate(resolve));
    const result = [];
    let deadline = performance.now() + 4;
    for (const match of snapshot.#matches(pattern, bounds)) {
      if (!all) return match;
      result.push(match);
      if (result.length % 512 === 0 && performance.now() >= deadline) {
        await new Promise((resolve) => setImmediate(resolve));
        deadline = performance.now() + 4;
      }
    }
    return all ? result : null;
  }

  async findWordsWithSubsequence(query, extra, maxCount) {
    return this.findWordsWithSubsequenceInRange(query, extra, maxCount, {
      start: zero,
      end: this.getExtent(),
    });
  }
  async findWordsWithSubsequenceInRange(query, extra, maxCount, range) {
    const { findWords } = require("./text-store-search");
    return findWords(
      this.#text.subtext(
        this.characterIndexForPosition(range.start),
        this.characterIndexForPosition(range.end),
      ),
      query,
      extra,
      maxCount,
    );
  }

  async findWordCandidates(
    query,
    { range, position, extraWordCharacters = "", maxCount = 20, signal } = {},
  ) {
    if (/[\r\n]/.test(extraWordCharacters))
      throw new RangeError("Completion word characters cannot include line endings");
    const { findWords } = require("./text-store-search");
    const start = range ? this.characterIndexForPosition(range.start) : 0;
    const end = range ? this.characterIndexForPosition(range.end) : this.#text.length;
    const origin = this.#text.positionAt(start);
    const finish = this.#text.positionAt(end);
    const capturedPosition = position ? { row: position.row, column: position.column } : undefined;
    if (
      this.#wordIndex &&
      origin.column === 0 &&
      (finish.column === 0 || end === this.#text.length) &&
      end > start &&
      end - start <= 2 * 1024 * 1024
    )
      return this.#wordIndex.find(
        this.#text,
        origin.row,
        end === this.#text.length ? this.#text.lineCount : finish.row,
        query,
        extraWordCharacters,
        maxCount,
        { position: capturedPosition, signal },
      );
    return findWords(this.#text.subtext(start, end), query, extraWordCharacters, maxCount, {
      compact: true,
      position: capturedPosition,
      origin,
      signal,
    });
  }
}

module.exports = TextStore;
