const { PieceTree } = require("./text-model");
const { leadingIndentation } = require("./text-source-helpers");

const BULK_ROWS = 4096;
const pause = () => new Promise((resolve) => setImmediate(resolve));

function selectedRowCount(selections) {
  return selections.reduce((count, selection) => {
    const [start, end] = selection.getBufferRowRange();
    return count + end - start + 1;
  }, 0);
}

function rowBounds(source, row) {
  const start = source.lineStart(row);
  let end = row + 1 < source.lineCount ? source.lineStart(row + 1) - 1 : source.length;
  if (row + 1 < source.lineCount && source.charCodeAt(end - 1) === 13) end--;
  return { start, end };
}

function leadingWhitespaceLength(source, start, end) {
  const read = source.reader(4096);
  let offset = start;
  while (offset < end) {
    const part = read(offset).slice(0, end - offset);
    const index = part.search(/\S/);
    if (index >= 0) return offset + index - start;
    offset += part.length;
  }
  return end - start;
}

function* rowSegments(selections) {
  const events = new Map();
  for (const selection of selections) {
    const [start, end] = selection.getBufferRowRange();
    events.set(start, (events.get(start) || 0) + 1);
    events.set(end + 1, (events.get(end + 1) || 0) - 1);
  }
  let start = 0,
    count = 0;
  for (const [row, delta] of [...events].sort(([a], [b]) => a - b)) {
    if (count && row > start) yield { start, end: row - 1, count };
    start = row;
    count += delta;
  }
}

function repeatText(text, count) {
  if (text.length * count <= 32768) return text.repeat(count);
  let output = new PieceTree(),
    part = new PieceTree(text);
  while (count) {
    if (count % 2) output = output.replace(output.length, output.length, part);
    count = Math.floor(count / 2);
    if (count) part = part.replace(part.length, part.length, part);
  }
  return output;
}

function indentRows(editor, selections, options = {}, outdent = false) {
  const buffer = editor.getBuffer();
  const source = buffer.getTextSnapshot();
  const expectedRevision = buffer.getTextRevision();
  const isCurrent = editor.captureTextMutationGuard(options);
  const tabLength = editor.getTabLength();
  const tabText = editor.getTabText();
  const segments = [...rowSegments(selections)];
  async function* edits() {
    let deadline = performance.now() + 4;
    let batch = [];
    for (const segment of segments) {
      const inserted = outdent ? "" : repeatText(tabText, segment.count);
      for (let row = segment.start; row <= segment.end; row++) {
        const { start, end } = rowBounds(source, row);
        let removed = 0;
        if (outdent) {
          let offset = start;
          for (let repeat = 0; repeat < segment.count && offset < end; repeat++) {
            if (source.charCodeAt(offset) === 9) {
              offset++;
              continue;
            }
            let spaces = 0;
            while (spaces < tabLength && offset < end && source.charCodeAt(offset) === 32) {
              spaces++;
              offset++;
            }
            if (!spaces) break;
          }
          removed = offset - start;
        }
        if (outdent ? removed > 0 : end > start) {
          batch.push({
            range: [
              [row, 0],
              [row, removed],
            ],
            text: inserted,
          });
          if (batch.length === 64) {
            yield batch;
            batch = [];
          }
        }
        if ((row - segment.start) % 64 === 0 && performance.now() >= deadline) {
          await pause();
          deadline = performance.now() + 4;
        }
      }
    }
    if (batch.length) yield batch;
  }
  return buffer.applyTextEdits(edits(), { expectedRevision, signal: options.signal, isCurrent });
}

async function indentSelections(editor, selections, options) {
  const rowSelections = selections.filter((selection) => !selection.isEmpty());
  if (rowSelections.length === selections.length) return indentRows(editor, selections, options);
  const buffer = editor.getBuffer();
  const source = buffer.getTextSnapshot();
  const expectedRevision = buffer.getTextRevision();
  const isCurrent = editor.captureTextMutationGuard(options);
  const tabLength = editor.getTabLength();
  const tabText = editor.getTabText();
  const languageMode = buffer.getLanguageMode();
  const rows = [
    ...new Set(
      selections
        .filter((selection) => selection.isEmpty())
        .map((selection) => selection.getBufferRange().start.row),
    ),
  ];
  let hints;
  if (options.autoIndent && languageMode.suggestedIndentForBufferRowsAtRows)
    hints = await languageMode.suggestedIndentForBufferRowsAtRows(rows, tabLength, {
      isReindenting: false,
    });
  else if (options.autoIndent) {
    hints = new Map();
    for (const row of rows)
      hints.set(row, await languageMode.suggestedIndentForBufferRow?.(row, tabLength));
  }
  if (!isCurrent()) return;
  const anchors = buffer.addMarkerLayer();
  const cursors = [];
  const inline = [];
  try {
    for (const selection of selections) {
      if (!selection.isEmpty()) continue;
      const point = selection.getBufferRange().start;
      const { start, end } = rowBounds(source, point.row);
      const indent = leadingIndentation(source, start, end, tabLength);
      const column = Math.max(point.column, indent.length);
      const hint =
        options.autoIndent && point.column <= indent.length ? hints?.get(point.row) : undefined;
      let delta = Number.isFinite(hint) ? hint - indent.level : 0;
      if (delta > 0 && !editor.getSoftTabs()) delta = Math.max(delta, 1);
      const text =
        delta > 0 ? editor.buildIndentString(delta) : editor.buildIndentString(1, column);
      const marker = anchors.markPosition([point.row, column], { invalidate: "never" });
      cursors.push({ selection, marker });
      inline.push({
        range: [
          [point.row, column],
          [point.row, column],
        ],
        text,
      });
    }
    inline.sort((a, b) => a.range[0][0] - b.range[0][0] || a.range[0][1] - b.range[0][1]);
    async function* edits() {
      let cursor = 0,
        deadline = performance.now() + 4;
      for (const segment of rowSegments(rowSelections)) {
        const text = repeatText(tabText, segment.count);
        for (let row = segment.start; row <= segment.end; row++) {
          while (cursor < inline.length && inline[cursor].range[0][0] < row) yield inline[cursor++];
          const bounds = rowBounds(source, row);
          if (bounds.end > bounds.start)
            yield {
              range: [
                [row, 0],
                [row, 0],
              ],
              text,
            };
          while (cursor < inline.length && inline[cursor].range[0][0] === row)
            yield inline[cursor++];
          if (row % 64 === 0 && performance.now() >= deadline) {
            await pause();
            deadline = performance.now() + 4;
          }
        }
      }
      while (cursor < inline.length) yield inline[cursor++];
    }
    return await buffer.applyTextEdits(edits(), {
      expectedRevision,
      isCurrent,
      signal: options.signal,
      didCommit() {
        for (const { selection, marker } of cursors)
          selection.setBufferRange(marker.getRange(), { autoscroll: false });
      },
    });
  } finally {
    anchors.destroy();
  }
}

module.exports = {
  BULK_ROWS,
  selectedRowCount,
  rowBounds,
  leadingWhitespaceLength,
  indentRows,
  indentSelections,
};
