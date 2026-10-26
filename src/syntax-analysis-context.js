const Point = require("./point");
const Range = require("./range");
const { leadingIndentation } = require("./text-source-helpers");

function guarded(methods, signal) {
  for (const [name, value] of Object.entries(methods)) {
    if (typeof value !== "function" || value === Point || value === Range) continue;
    methods[name] = (...args) => {
      signal?.throwIfAborted();
      return value(...args);
    };
  }
  return Object.freeze(methods);
}

function contextFor(mode, signal, revision = mode.buffer.getTextRevision()) {
  const buffer = mode.buffer;
  const scan = (reverse, regex, range, callback) =>
    buffer.scanInRange(
      regex,
      range,
      {},
      (result) => {
        signal?.throwIfAborted();
        callback({
          range: result.range,
          match: result.match,
          matchText: result.matchText,
          stop: () => result.stop(),
        });
      },
      reverse,
    );
  const document = guarded(
    {
      getText: () => buffer.getText(),
      getTextSnapshot: () => buffer.getTextSnapshot(),
      getTextRevision: () => revision,
      getPath: () => buffer.getPath(),
      getLastRow: () => buffer.getLastRow(),
      getLineCount: () => buffer.getLineCount(),
      getLength: () => buffer.getLength(),
      clipPosition: (position) => buffer.clipPosition(position),
      isRowBlank: (row) => buffer.isRowBlank(row),
      getEndPosition: () => buffer.getEndPosition(),
      getTextInRange: (range) => buffer.getTextInRange(range),
      lineForRow: (row) => buffer.lineForRow(row),
      lineLengthForRow: (row) => buffer.lineLengthForRow(row),
      characterIndexForPosition: (point) => buffer.characterIndexForPosition(point),
      positionForCharacterIndex: (index) => buffer.positionForCharacterIndex(index),
    },
    signal,
  );
  return guarded(
    {
      signal,
      Point,
      Range,
      buffer: document,
      getBuffer: () => document,
      getGrammar: () => mode.grammar,
      getText: document.getText,
      getPath: document.getPath,
      getTextInBufferRange: document.getTextInRange,
      lineTextForBufferRow: document.lineForRow,
      getLastBufferRow: document.getLastRow,
      getLineCount: document.getLineCount,
      getEofBufferPosition: document.getEndPosition,
      indentationForBufferRow: (row, tabLength) => {
        const source = buffer.getTextSnapshot();
        const start = source.lineStart(row);
        return leadingIndentation(source, start, start + buffer.lineLengthForRow(row), tabLength)
          .level;
      },
      getFoldableRangeAtBufferRow: (row, tabLength) =>
        mode.getFoldRangeForRow?.(row, tabLength) ?? null,
      isFoldableAtBufferRow: (row) => mode.isFoldableAtRow?.(row) ?? false,
      isBufferRowCommented: (row) => mode.isRowCommented(row),
      scopeDescriptorForBufferPosition: (point) => mode.scopeDescriptorForPosition(point),
      scopeRanges: (range) => require("./syntax-scope-ranges")(mode, range, signal),
      getCommentStringsForBufferPosition: (point) =>
        mode.commentStringsForPosition(Point.fromObject(point)),
      getRootSyntaxNode: () => mode.rootLanguageLayer?.tree?.rootNode ?? null,
      getLanguageLayers: () =>
        (mode.getAllLanguageLayers?.() ?? []).filter(Boolean).map((layer) =>
          Object.freeze({
            scopeName: layer.grammar?.scopeName,
            rootNode: layer.tree?.rootNode ?? null,
            ranges: layer.getCurrentRanges?.() ?? [],
            extent: layer.getExtent(),
          }),
        ),
      bufferRangeForScopeAtPosition: (selector, point) =>
        mode.bufferRangeForScopeAtPosition(selector, Point.fromObject(point)),
      scanInBufferRange: (regex, range, callback) => scan(false, regex, range, callback),
      backwardsScanInBufferRange: (regex, range, callback) => scan(true, regex, range, callback),
      getSyntaxNodeAtBufferPosition: (point, where) =>
        mode.getSyntaxNodeAtPosition?.(point, where) ?? null,
      getSyntaxNodeContainingBufferRange: (range, where) =>
        mode.getSyntaxNodeContainingRange?.(Range.fromObject(range), where) ?? null,
      getGrammarQueryCaptureGroups: (type) => mode.getQueryCaptureGroups?.(type, { signal }) ?? [],
    },
    signal,
  );
}

// Analysis code can use WASM nodes while it runs, but only data leaves its
// owner. Reject unexpected class instances instead of cloning broken handles.
function serialize(value, seen = new Map()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  )
    return value;
  if (typeof value !== "object") throw new TypeError("Syntax analysis must return data");
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Point) return { row: value.row, column: value.column };
  if (value instanceof Range) return { start: serialize(value.start), end: serialize(value.end) };
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(serialize(item, seen));
    return result;
  }
  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [key, item] of value) result.set(serialize(key, seen), serialize(item, seen));
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Syntax analysis cannot return syntax nodes or class instances");
  const result = {};
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value"))
      throw new TypeError("Syntax analysis cannot return accessors");
    Object.defineProperty(result, key, {
      value: serialize(descriptor.value, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

module.exports = { contextFor, serialize };
