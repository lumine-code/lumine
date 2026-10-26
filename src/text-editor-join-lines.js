const Range = require("./range");

function rangesForSelections(editor, selections) {
  const lastRow = editor.buffer.getLastRow();
  const ranges = [];
  for (const selection of selections) {
    const selected = selection.getBufferRange();
    const start = selected.start.row;
    const end = Math.min(lastRow, Math.max(start + 1, selected.end.row));
    if (end <= start) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

function needsStreamingJoin(editor, selections) {
  const source = editor.buffer.getTextSnapshot();
  return rangesForSelections(editor, selections).some(
    ({ start, end }) =>
      end - start > 4096 ||
      source.offsetAt({ row: end, column: editor.buffer.lineLengthForRow(end) }) -
        source.lineStart(start) >
        1024 * 1024,
  );
}

async function* joinEdits(source, ranges, check = () => {}) {
  let deadline = performance.now() + 4;
  const pause = async () => {
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      check();
      deadline = performance.now() + 4;
    }
  };
  const lineEnd = (row) => {
    if (row + 1 === source.lineCount) return source.length;
    let end = source.lineStart(row + 1) - 1;
    if (source.charCodeAt(end - 1) === 13) end--;
    return end;
  };
  const trailingStart = async (start, end) => {
    while (end > start) {
      const offset = Math.max(start, end - 32768);
      const part = source.slice(offset, end);
      const match = /[ \t]+$/.exec(part);
      if (!match) break;
      end -= match[0].length;
      if (match[0].length < part.length) break;
      await pause();
    }
    return end;
  };
  const leadingEnd = async (start, end) => {
    for (let offset = start; offset < end;) {
      const part = source.slice(offset, Math.min(end, offset + 32768));
      const index = part.search(/\S/);
      if (index >= 0) return offset + index;
      offset += part.length;
      await pause();
    }
    // The existing join command preserves whitespace on the final blank row.
    return start;
  };
  for (const rows of ranges) {
    let tail = await trailingStart(source.lineStart(rows.start), lineEnd(rows.start));
    let nonempty = tail > source.lineStart(rows.start);
    let pending;
    for (let row = rows.start + 1; row <= rows.end; row++) {
      check();
      const start = source.lineStart(row),
        end = lineEnd(row);
      const lead = await leadingEnd(start, end);
      const text = nonempty && end > start ? " " : "";
      if (pending && tail <= pending.end) {
        pending.end = lead;
        pending.text = text;
      } else {
        if (pending)
          yield {
            range: new Range(source.positionAt(pending.start), source.positionAt(pending.end)),
            text: pending.text,
          };
        pending = { start: tail, end: lead, text };
      }
      tail = await trailingStart(lead, end);
      if (tail > lead) nonempty = true;
      await pause();
    }
    if (pending)
      yield {
        range: new Range(source.positionAt(pending.start), source.positionAt(pending.end)),
        text: pending.text,
      };
  }
}

async function joinSelections(editor, selections, options = {}) {
  const buffer = editor.buffer;
  const source = buffer.getTextSnapshot();
  const revision = buffer.getTextRevision();
  const ranges = rangesForSelections(editor, selections);
  const isCurrent = editor.captureTextMutationGuard(options);
  const check = () => {
    if (options.signal?.aborted || !isCurrent())
      throw Object.assign(
        new Error("Joining lines was cancelled because the document or selections changed"),
        { name: "AbortError" },
      );
  };
  const markers = selections.map((selection) => {
    const range = selection.getBufferRange();
    const empty = range.isEmpty();
    return {
      selection,
      empty,
      marker: empty
        ? editor.markBufferPosition([range.start.row, 0], { invalidate: "never" })
        : editor.markBufferRange(range, { invalidate: "never" }),
    };
  });
  for (const item of markers)
    if (item.empty) {
      const row = item.selection.getBufferRange().start.row;
      const start = source.lineStart(row),
        end = start + buffer.lineLengthForRow(row);
      const { runBoundary } = require("./cursor-word-navigation");
      item.cursorColumn = runBoundary(source, end, start, "[ \t]", -1) - start;
    }
  try {
    await buffer.applyTextEdits(joinEdits(source, ranges, check), {
      expectedRevision: revision,
      signal: options.signal,
      isCurrent,
      didCommit() {
        for (const { selection, empty, marker, cursorColumn } of markers) {
          if (!empty) selection.setBufferRange(marker.getBufferRange(), { autoscroll: false });
          else {
            const end = marker.getHeadBufferPosition();
            selection.cursor.setBufferPosition([end.row, end.column + cursorColumn], {
              autoscroll: false,
            });
          }
        }
      },
    });
    editor.getLastSelection().autoscroll();
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    throw error;
  } finally {
    for (const { marker } of markers) marker.destroy();
  }
}

module.exports = { joinSelections, needsStreamingJoin, joinEdits };
