// Search immutable text without flattening the document. Windows are a proof
// boundary: a literal has a known width, and a line-local expression cannot
// inspect another line. Other expressions use one bounded native RegExp input.
const WINDOW_UNITS = 64 * 1024;
const NATIVE_LIMIT = 8 * 1024 * 1024;
const CHECKPOINT_INTERVAL = 1024;
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

function abortError() {
  return Object.assign(new Error("Search was cancelled"), { name: "AbortError" });
}

function unsupported() {
  return Object.assign(
    new Error(
      "This expression requires a complete multiline input. Narrow the search selection or use a literal or line-local expression for this large document.",
    ),
    { code: "ERR_SEARCH_INPUT_TOO_LARGE" },
  );
}

function searchPattern(
  pattern,
  endIsLineBoundary,
  unicodeSets,
  { startIsDocumentBoundary = true, endIsDocumentBoundary = true } = {},
) {
  let lineAnchors = true;
  const scopes = [];
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
    if (!depth && character === "(") {
      scopes.push(lineAnchors);
      const modifier = /^\(\?([ims]*)(?:-([ims]*))?:/.exec(pattern.slice(index));
      if (modifier?.[1].includes("m")) lineAnchors = true;
      if (modifier?.[2]?.includes("m")) lineAnchors = false;
    } else if (!depth && character === ")" && scopes.length) lineAnchors = scopes.pop();
    if (!depth && character === "^")
      result += lineAnchors ? "(?<![^\\n])" : startIsDocumentBoundary ? "^" : "(?!)";
    else if (!depth && character === "$")
      result += lineAnchors
        ? endIsLineBoundary
          ? "(?=\\r?\\n|$)"
          : "(?=\\r?\\n)"
        : endIsDocumentBoundary
          ? "$"
          : "(?!)";
    else result += character;
  }
  return result;
}

// Recognize escaped literals, including Find's optional whole-word wrapper.
// Returning null is always safe: it selects the more general engine.
function literalWidth(source) {
  if (source === "\\r\\n|\\n" || source === "(?:\\r\\n|\\n)") return 2;
  if (source.startsWith("\\b(?:") && source.endsWith(")\\b")) source = source.slice(5, -3);
  let width = 0;
  for (let i = 0; i < source.length; i++) {
    const newline = source.startsWith("(?:\\r?\\n)", i)
      ? "(?:\\r?\\n)"
      : source.startsWith("\\r?\\n", i)
        ? "\\r?\\n"
        : null;
    if (newline) {
      width += 2;
      i += newline.length - 1;
      continue;
    }
    const c = source[i];
    if (c === "\\") {
      const next = source[++i];
      if (!next || !"/\\^$*+?.()|[]{}nrtvf".includes(next)) return null;
    } else if ("^$*+?.()|[]{}".includes(c)) return null;
    width++;
  }
  return width;
}

// indexOf is exact for nonempty ASCII literals with no case-folding work.
// Everything else retains the regexp scanner; this is only a count fast path.
function countingLiteral(source, flags) {
  let text = "";
  const escapes = { n: "\n", r: "\r", t: "\t", v: "\v", f: "\f" };
  for (let i = 0; i < source.length; i++) {
    let c = source[i];
    if (c === "\\") {
      c = source[++i];
      if (!c || !"/\\^$*+?.()|[]{}nrtvf".includes(c)) return null;
      c = escapes[c] ?? c;
    } else if ("^$*+?.()|[]{}".includes(c)) return null;
    if (c.charCodeAt(0) > 127) return null;
    text += c;
  }
  return !text || (flags.includes("i") && /[a-z]/i.test(text)) ? null : text;
}

function canSeekLiteral(source, flags) {
  const literal = countingLiteral(source, "");
  if (literal === null || literal.length > 4096) return false;
  const text = flags.includes("i") ? literal.toLowerCase() : literal;
  const borders = new Uint32Array(text.length);
  for (let i = 1, border = 0; i < text.length; i++) {
    while (border && text[i] !== text[border]) border = borders[border - 1];
    if (text[i] === text[border]) border++;
    borders[i] = border;
  }
  return borders[text.length - 1] === 0;
}

// Conservative lexical proof that no atom (including atoms in assertions and
// captures later referenced) can consume LF. Escapes/classes are checked by V8
// itself. Unicode-set classes and special group extensions use the fallback.
function isLineLocal(source, flags) {
  if (flags.includes("s") || flags.includes("v")) return false;
  const atomFlags = flags.replace(/[gmyd]/g, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") return false;
    if (c === "(" && source[i + 1] === "?" && /^[ims-]+:/.test(source.slice(i + 2))) return false;
    if (c === "[") {
      const begin = i++;
      for (; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
      if (i === source.length) return false;
      try {
        if (new RegExp(source.slice(begin, i + 1), atomFlags).test("\n")) return false;
      } catch {
        return false;
      }
    } else if (c === "\\") {
      const begin = i;
      const next = source[++i];
      if (/\d/.test(next)) {
        // Ambiguous legacy octal escapes can represent LF (\12).
        return false;
      }
      if (next === "k") return false;
      if (next === "b" || next === "B") continue;
      if (next === "x") i += 2;
      else if (next === "u") {
        if (source[i + 1] === "{") {
          i = source.indexOf("}", i + 2);
          if (i < 0) return false;
        } else i += 4;
      } else if (next === "p" || next === "P") {
        i = source.indexOf("}", i + 2);
        if (i < 0) return false;
      } else if (next === "c") i++;
      try {
        if (new RegExp(source.slice(begin, i + 1), atomFlags).test("\n")) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

class DocumentSearch {
  constructor(snapshot, regex, range, options = {}) {
    this.snapshot = snapshot;
    this.start = range?.start ?? 0;
    this.end = range?.end ?? snapshot.length;
    this.source = typeof regex === "string" ? regex : regex.source;
    this.flags = typeof regex === "string" ? "g" : regex.flags.replace(/[gmy]/g, "") + "g";
    this.unicode = this.flags.includes("u") || this.flags.includes("v");
    this.width = literalWidth(this.source);
    this.localLiteral = this.width !== null && canSeekLiteral(this.source, this.flags);
    this.lineLocal = this.width === null && isLineLocal(this.source, this.flags);
    this.windowUnits = options.windowUnits ?? WINDOW_UNITS;
    this.nativeLimit = options.nativeLimit ?? NATIVE_LIMIT;
    this.signal = options.signal;
    this.revision = options.revision;
    this.isCurrent = options.isCurrent ?? (() => true);
    this.count = 0;
    this.complete = false;
    this.checkpoints = [];
    // Validate syntax immediately, before presenting a pending query.
    new RegExp(this.source, this.flags);
    if (this.width === null && !this.lineLocal && this.end - this.start > this.nativeLimit)
      throw unsupported();
    if (this.width !== null && this.width + 4 > this.nativeLimit) throw unsupported();
  }

  check() {
    if (this.signal?.aborted) throw abortError();
    if (!this.isCurrent())
      throw Object.assign(new Error("The document changed during search"), {
        code: "ERR_STALE_SEARCH",
      });
  }

  withSignal(signal) {
    const task = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    task.signal = this.signal ? AbortSignal.any([this.signal, signal]) : signal;
    return task;
  }

  range(match) {
    return {
      start: this.snapshot.positionAt(match.start),
      end: this.snapshot.positionAt(match.end),
    };
  }

  *windows(resume) {
    const snapshot = this.snapshot;
    let cursor = Math.max(this.start, resume);
    while (cursor <= this.end) {
      this.check();
      let contextStart, inputEnd, boundary;
      if (this.width !== null) {
        contextStart = Math.max(0, cursor - 2);
        boundary = Math.min(this.end, cursor + this.windowUnits);
        inputEnd = Math.min(this.end, boundary + this.width + 2);
      } else if (this.lineLocal) {
        const row = snapshot.positionAt(cursor).row;
        contextStart = Math.max(
          Math.max(0, this.start - 1),
          snapshot.offsetAt({ row, column: 0 }) - 1,
        );
        const tentative = Math.min(this.end, cursor + this.windowUnits);
        const lastRow = snapshot.positionAt(tentative).row;
        inputEnd =
          tentative === this.end || lastRow + 1 === snapshot.lineCount
            ? this.end
            : Math.min(this.end, snapshot.offsetAt({ row: lastRow + 1, column: 0 }));
        boundary = inputEnd;
        if (inputEnd - contextStart > this.nativeLimit) throw unsupported();
      } else {
        contextStart = Math.max(0, this.start - 1);
        inputEnd = boundary = this.end;
      }
      if (
        this.unicode &&
        boundary < this.end &&
        snapshot.charCodeAt(boundary) >= 0xdc00 &&
        snapshot.charCodeAt(boundary) <= 0xdfff
      )
        boundary--;
      const text = snapshot.slice(contextStart, inputEnd);
      const endPoint = snapshot.positionAt(inputEnd);
      const nextLine =
        endPoint.row + 1 < snapshot.lineCount
          ? snapshot.offsetAt({ row: endPoint.row + 1, column: 0 })
          : snapshot.length;
      const endIsLineBoundary =
        inputEnd === this.end &&
        (inputEnd === snapshot.length ||
          (snapshot.charCodeAt(nextLine - 1) === 10 &&
            (inputEnd === nextLine - 1 ||
              (snapshot.charCodeAt(nextLine - 2) === 13 && inputEnd === nextLine - 2))));
      const source = searchPattern(this.source, endIsLineBoundary, this.flags.includes("v"), {
        startIsDocumentBoundary: contextStart === 0,
        endIsDocumentBoundary: inputEnd === snapshot.length,
      });
      const nextCursor = yield { text, contextStart, boundary, source, cursor };
      if (boundary === this.end) return;
      cursor = Math.max(nextCursor ?? cursor, boundary);
    }
  }

  accept(window, match, state) {
    const { text, contextStart, boundary } = window;
    const start = contextStart + match.index,
      end = start + match[0].length;
    if (start >= boundary && boundary < this.end) return false;
    const next =
      end +
      (!match[0].length ? (this.unicode && text.codePointAt(match.index) > 0xffff ? 2 : 1) : 0);
    if (start < state.cursor) return null;
    state.cursor = next;
    const addressStart =
      text.charCodeAt(match.index) === 10 && text.charCodeAt(match.index - 1) === 13
        ? start - 1
        : start;
    const addressEnd =
      text.charCodeAt(match.index + match[0].length) === 10 &&
      text.charCodeAt(match.index + match[0].length - 1) === 13
        ? end - 1
        : end;
    if (addressStart === state.previousStart && addressEnd === state.previousEnd) return null;
    state.previousStart = addressStart;
    state.previousEnd = addressEnd;
    return { start, end, match, inputOffset: contextStart };
  }

  *scan(resume = this.start, { onWindow } = {}) {
    const state = { cursor: Math.max(this.start, resume), previousStart: -1, previousEnd: -1 };
    const windows = this.windows(resume);
    for (let item = windows.next(); !item.done; item = windows.next(state.cursor)) {
      const window = item.value;
      state.cursor = Math.max(state.cursor, window.cursor);
      const expression = new RegExp(window.source, this.flags);
      expression.lastIndex = window.cursor - window.contextStart;
      for (let match; (match = expression.exec(window.text));) {
        if (!match[0].length)
          expression.lastIndex +=
            this.unicode && window.text.codePointAt(expression.lastIndex) > 0xffff ? 2 : 1;
        const result = this.accept(window, match, state);
        if (result === false) break;
        if (result) yield result;
      }
      onWindow?.(Math.max(state.cursor, window.boundary), window.boundary === this.end);
      yield null;
    }
  }

  async *batches(resume = this.start) {
    await yieldTurn();
    let deadline = performance.now() + 4;
    if (this.width !== null) {
      let batch = [];
      for (const match of this.scan(resume)) {
        if (match) batch.push(match);
        if (!match || batch.length === 512) {
          if (batch.length) {
            yield batch;
            batch = [];
          }
          if (performance.now() >= deadline) {
            await yieldTurn();
            this.check();
            deadline = performance.now() + 4;
          }
        }
      }
      if (batch.length) yield batch;
    } else {
      // Native regexp execution is indivisible and can backtrack indefinitely.
      // Isolate it so cancellation and a hard budget can terminate the worker.
      const SearchWorker = require("./document-search-worker-client");
      const worker = new SearchWorker(this.signal);
      const state = { cursor: Math.max(this.start, resume), previousStart: -1, previousEnd: -1 };
      const windows = this.windows(resume);
      try {
        for (let item = windows.next(); !item.done; item = windows.next(state.cursor)) {
          this.check();
          const window = item.value;
          state.cursor = Math.max(state.cursor, window.cursor);
          let batch = await worker.request({
            text: window.text,
            source: window.source,
            flags: this.flags,
            lastIndex: window.cursor - window.contextStart,
          });
          let finished = false;
          while (!finished) {
            this.check();
            const results = [];
            for (const match of batch.matches) {
              const result = this.accept(window, match, state);
              if (result === false) {
                finished = true;
                break;
              }
              if (result) results.push(result);
            }
            if (results.length) yield results;
            if (performance.now() >= deadline) {
              await yieldTurn();
              this.check();
              deadline = performance.now() + 4;
            }
            if (batch.done || finished) break;
            batch = await worker.request({ next: true });
          }
        }
      } finally {
        worker.dispose();
      }
    }
    this.check();
  }

  async *matches(resume = this.start) {
    let deadline = performance.now() + 4;
    for await (const batch of this.batches(resume)) {
      for (const match of batch) {
        yield match;
        if (performance.now() >= deadline) {
          await yieldTurn();
          this.check();
          deadline = performance.now() + 4;
        }
      }
    }
  }

  async collect({ limit = 2000, onProgress } = {}) {
    this.count = 0;
    this.complete = false;
    this.checkpoints = [];
    const ranges = [];
    const checkpoint = (offset) => {
      const previous = this.checkpoints.at(-1);
      if (!previous || previous.offset < offset)
        this.checkpoints.push({ index: this.count, offset });
    };
    let notified = 0,
      deadline = performance.now() + 4,
      progressDeadline = performance.now() + 50;
    const record = (start, end) => {
      if (this.count % CHECKPOINT_INTERVAL === 0)
        this.checkpoints.push({ index: this.count, offset: start });
      if (ranges.length < limit) ranges.push(this.range({ start, end }));
      this.count++;
      if (this.count !== 1 && this.count % 256 !== 0) return false;
      const now = performance.now();
      if (onProgress && (this.count === 1 || now >= progressDeadline)) {
        onProgress({ count: this.count, complete: false, ranges: ranges.slice(notified) });
        notified = ranges.length;
        progressDeadline = now + 50;
      }
      return now >= deadline;
    };
    const pause = async () => {
      await yieldTurn();
      this.check();
      deadline = performance.now() + 4;
    };
    if (this.width !== null) {
      await pause();
      const literal = countingLiteral(this.source, this.flags);
      if (literal !== null) {
        // Counts do not need capture arrays, strings or one Promise per hit.
        const windows = this.windows(this.start);
        let cursor = this.start;
        for (let item = windows.next(); !item.done; item = windows.next(cursor)) {
          const window = item.value;
          cursor = Math.max(cursor, window.cursor);
          let at = window.text.indexOf(literal, cursor - window.contextStart);
          while (at >= 0) {
            const start = at + window.contextStart;
            if (start >= window.boundary && window.boundary < this.end) break;
            cursor = start + literal.length;
            if (record(start, cursor)) await pause();
            at = window.text.indexOf(literal, cursor - window.contextStart);
          }
          if (window.boundary < this.end) checkpoint(Math.max(cursor, window.boundary));
          if (performance.now() >= deadline) await pause();
        }
      } else {
        for (const match of this.scan(this.start, {
          onWindow: (offset, final) => {
            if (!final) checkpoint(offset);
          },
        })) {
          if (match ? record(match.start, match.end) : performance.now() >= deadline) await pause();
        }
      }
    } else {
      const SearchWorker = require("./document-search-worker-client");
      const worker = new SearchWorker(this.signal);
      const windows = this.windows(this.start);
      let cursor = this.start,
        previousStart = -1,
        previousEnd = -1;
      try {
        for (let item = windows.next(); !item.done; item = windows.next(cursor)) {
          const window = item.value;
          cursor = Math.max(cursor, window.cursor);
          let batch = await worker.request({
            text: window.text,
            source: window.source,
            flags: this.flags,
            lastIndex: window.cursor - window.contextStart,
            counting: {
              contextStart: window.contextStart,
              boundary: window.boundary,
              final: window.boundary === this.end,
              cursor,
              previousStart,
              previousEnd,
              base: this.count,
              preview: Math.max(0, limit - ranges.length),
            },
          });
          for (;;) {
            this.check();
            this.count += batch.count;
            this.checkpoints.push(...batch.checkpoints);
            for (const match of batch.preview) ranges.push(this.range(match));
            cursor = batch.cursor;
            previousStart = batch.previousStart;
            previousEnd = batch.previousEnd;
            const now = performance.now();
            if (
              onProgress &&
              ((this.count === batch.count && batch.count > 0) || now >= progressDeadline)
            ) {
              onProgress({ count: this.count, complete: false, ranges: ranges.slice(notified) });
              notified = ranges.length;
              progressDeadline = now + 50;
            }
            if (now >= deadline) await pause();
            if (batch.done) {
              if (window.boundary < this.end) checkpoint(Math.max(cursor, window.boundary));
              break;
            }
            batch = await worker.request({ next: true });
          }
        }
      } finally {
        worker.dispose();
      }
    }
    this.check();
    this.complete = true;
    onProgress?.({ count: this.count, complete: true, ranges: ranges.slice(notified) });
    return { count: this.count, ranges, complete: true };
  }

  async matchAt(index) {
    if (index < 0 || (this.complete && index >= this.count)) return null;
    let checkpoint = { index: 0, offset: this.start };
    for (const item of this.checkpoints) {
      if (item.index > index) break;
      checkpoint = item;
    }
    let ordinal = checkpoint.index;
    for await (const match of this.matches(checkpoint.offset)) {
      if (ordinal++ === index) return { ...match, index, range: this.range(match) };
    }
    return null;
  }

  async findNear(
    offset,
    { backwards = false, inclusive = false, intersecting = false, allowLocal = true } = {},
  ) {
    let checkpoint = { index: 0, offset: this.start };
    for (const item of this.checkpoints) {
      if (item.offset >= offset) break;
      checkpoint = item;
    }
    const clipped = Math.min(this.end, Math.max(this.start, offset));
    if (
      allowLocal &&
      clipped - checkpoint.offset > this.windowUnits * 2 &&
      (this.localLiteral || this.lineLocal)
    ) {
      let upper = clipped;
      let resume = backwards
        ? Math.max(this.start, clipped - this.windowUnits - (this.width ?? 0))
        : Math.max(this.start, clipped - (intersecting ? (this.width ?? 0) : 0));
      for (;;) {
        if (this.lineLocal)
          resume = Math.max(
            this.start,
            this.snapshot.offsetAt({ row: this.snapshot.positionAt(resume).row, column: 0 }),
          );
        const task = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
        if (backwards) {
          if (this.lineLocal) {
            const row = this.snapshot.positionAt(upper).row;
            task.end =
              upper < clipped
                ? upper
                : Math.min(
                    this.end,
                    row + 1 < this.snapshot.lineCount
                      ? this.snapshot.offsetAt({ row: row + 1, column: 0 })
                      : this.snapshot.length,
                  );
          } else task.end = Math.min(this.end, upper + (this.width ?? 0) + 2);
        }
        const result = await task.findNearFrom(resume, offset, {
          backwards,
          inclusive,
          intersecting,
          ordinal: -1,
        });
        if (result || !backwards || resume === this.start) return result;
        upper = resume;
        resume = Math.max(this.start, resume - this.windowUnits - (this.width ?? 0));
      }
    }
    const result = await this.findNearFrom(checkpoint.offset, offset, {
      backwards,
      inclusive,
      intersecting,
      ordinal: checkpoint.index,
    });
    return !result && backwards && checkpoint.index > 0
      ? this.matchAt(checkpoint.index - 1)
      : result;
  }

  async findNearFrom(resume, offset, { backwards, inclusive, intersecting, ordinal }) {
    const finish = (match, index) => (match ? { ...match, index, range: this.range(match) } : null);
    const literal =
      ordinal < 0 &&
      this.localLiteral &&
      backwards &&
      this.end - resume <= this.windowUnits + (this.width ?? 0) * 2 + 2
        ? countingLiteral(this.source, this.flags)
        : null;
    if (literal !== null) {
      this.check();
      const text = this.snapshot.slice(resume, this.end);
      const from = offset - resume - literal.length - (inclusive ? 0 : 1);
      if (from < 0) return null;
      const at = text.lastIndexOf(literal, from);
      if (at < 0) return null;
      const start = resume + at;
      return finish(
        { start, end: start + literal.length, match: [literal], inputOffset: resume },
        -1,
      );
    }
    let previous,
      previousIndex = -1,
      index = ordinal;
    for await (const batch of this.batches(resume)) {
      for (const match of batch) {
        const matchIndex = index < 0 ? -1 : index++;
        if (backwards) {
          if (match.end < offset || (inclusive && match.end === offset)) {
            previous = match;
            previousIndex = matchIndex;
          } else return finish(previous, previousIndex);
        } else if (
          (intersecting && match.end >= offset) ||
          match.start > offset ||
          (inclusive && match.start === offset)
        )
          return finish(match, matchIndex);
      }
    }
    return finish(previous, previousIndex);
  }
}

// Build output without a per-match edit array, retaining unchanged large spans.
// Frequent tiny replacements are compacted into ordinary text blocks rather
// than leaving one tree node per occurrence. The live document is untouched.
async function buildReplacement(snapshot, sessions, replacement, options = {}) {
  const { PieceTree } = require("./text-model");
  const getSubstitution = require("./text-substitution");
  let output = new PieceTree(),
    parts = [],
    units = 0,
    offset = 0,
    count = 0;
  const flush = () => {
    if (units) output = output.replace(output.length, output.length, parts.join(""));
    parts = [];
    units = 0;
  };
  let outputLast = NaN,
    capturing = false,
    insertedFirst = NaN,
    insertedLast;
  const append = (text) => {
    if (!text.length) return;
    outputLast = text.charCodeAt(text.length - 1);
    if (capturing) {
      if (Number.isNaN(insertedFirst)) insertedFirst = text.charCodeAt(0);
      insertedLast = outputLast;
    }
    if (text.length > 32768) {
      flush();
      output = output.replace(output.length, output.length, text);
    } else {
      parts.push(typeof text === "string" ? text : text.toString());
      units += text.length;
      if (units >= 32768) flush();
    }
  };
  let deadline = performance.now() + 4;
  const readSource = snapshot.reader(32768);
  let sourceChunk = "",
    sourceChunkStart = 0;
  const appendSource = (start, end) => {
    if (end - start > 32768) {
      append(snapshot.subtext(start, end));
      return;
    }
    while (start < end) {
      if (start < sourceChunkStart || start >= sourceChunkStart + sourceChunk.length) {
        sourceChunkStart = start;
        sourceChunk = readSource(start);
      }
      const count = Math.min(end - start, sourceChunkStart + sourceChunk.length - start);
      append(sourceChunk.slice(start - sourceChunkStart, start - sourceChunkStart + count));
      start += count;
    }
  };
  const template = /\$([$&'`]|\d{1,2}|<[^>]*>)/g;
  for (const session of sessions) {
    matchBatches: for await (const batch of session.batches(
      options.onlyMatch ? Math.max(session.start, options.onlyMatch.start) : session.start,
    )) {
      for (const found of batch) {
        if (
          options.onlyMatch &&
          (found.start !== options.onlyMatch.start || found.end !== options.onlyMatch.end)
        )
          break matchBatches;
        if (options.shouldReplace) {
          let accepted = options.shouldReplace(found);
          if (accepted && typeof accepted.then === "function") {
            accepted = await accepted;
            session.check();
          }
          if (typeof accepted !== "boolean")
            throw new TypeError("Replacement predicates must return or resolve to a boolean");
          if (!accepted) continue;
        }
        appendSource(offset, found.start);
        const outputStart = output.length + units;
        const previousUnit = outputLast;
        insertedFirst = insertedLast = NaN;
        capturing = true;
        if (options.literalReplacement) {
          append(
            options.transformReplacement
              ? options.transformReplacement(replacement, found.match[0])
              : replacement,
          );
        } else if (options.transformReplacement) {
          if (
            (replacement.includes("$`") && found.start > NATIVE_LIMIT) ||
            (replacement.includes("$'") && snapshot.length - found.end > NATIVE_LIMIT)
          )
            throw Object.assign(
              new Error(
                "Preserve case cannot transform this very large prefix/suffix replacement.",
              ),
              { code: "ERR_SEARCH_INPUT_TOO_LARGE" },
            );
          append(
            options.transformReplacement(
              getSubstitution(
                found.match[0],
                snapshot,
                found.start,
                found.match.slice(1),
                found.match.groups,
                replacement,
              ),
              found.match[0],
            ),
          );
        } else {
          // Prefix/suffix substitutions can themselves exceed V8's string limit.
          // Expand those references as shared snapshots, not strings.
          let cursor = 0;
          for (const token of replacement.matchAll(template)) {
            append(replacement.slice(cursor, token.index));
            let value;
            if (token[1] === "`") value = snapshot.subtext(0, found.start);
            else if (token[1] === "'") value = snapshot.subtext(found.end);
            else
              value = getSubstitution(
                found.match[0],
                "",
                0,
                found.match.slice(1),
                found.match.groups,
                token[0],
              );
            append(value);
            cursor = token.index + token[0].length;
          }
          const tail = replacement.slice(cursor);
          append(tail);
        }
        capturing = false;
        options.onReplacement?.(found.start, found.end, output.length + units - outputStart, {
          previousUnit,
          insertedFirst,
          insertedLast,
        });
        offset = found.end;
        count++;
        if (options.onlyMatch) break matchBatches;
        if (count % 32 === 0 && performance.now() >= deadline) {
          await yieldTurn();
          session.check();
          deadline = performance.now() + 4;
        }
      }
    }
  }
  appendSource(offset, snapshot.length);
  flush();
  return { snapshot: output, count };
}

module.exports = { DocumentSearch, searchPattern, literalWidth, isLineLocal, buildReplacement };
