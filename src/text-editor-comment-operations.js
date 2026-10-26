const { PieceTree } = require("./text-model");
const { rowBounds } = require("./text-editor-row-operations");
const pause = () => new Promise((resolve) => setImmediate(resolve));

function inspectRows(source, tabLength, check) {
  const line = source.lineReader();
  return function inspect(row) {
    const { start, end } = rowBounds(source, row);
    const prefix = end - start <= 4096 ? line(row) : source.slice(start, start + 4096);
    let length = 0,
      columns = 0,
      firstTab = null;
    const addIndent = (text) => {
      let index = 0;
      for (; index < text.length; index++) {
        if (text[index] === " ") columns++;
        else if (text[index] === "\t") {
          firstTab ??= length + index;
          columns += tabLength - (columns % tabLength);
        } else break;
      }
      length += index;
      return index === text.length;
    };
    let indentPending = addIndent(prefix);
    const found = prefix.search(/\S/);
    const result = (contentStart) => ({
      start,
      end,
      indentLength: length,
      indentColumns: columns,
      firstTab,
      indentLevel: columns / tabLength,
      contentStart,
      blank: contentStart === end,
    });
    if (found >= 0 || prefix.length === end - start) return result(found < 0 ? end : start + found);
    return (async () => {
      let offset = start + prefix.length,
        deadline = performance.now() + 4;
      const read = source.reader(4096);
      while (offset < end) {
        check();
        const text = read(offset).slice(0, end - offset);
        if (indentPending) indentPending = addIndent(text);
        const found = text.search(/\S/);
        if (found >= 0) return result(offset + found);
        offset += text.length;
        if (performance.now() >= deadline) {
          await pause();
          deadline = performance.now() + 4;
        }
      }
      return result(end);
    })();
  };
}

function repeat(text, count) {
  if (text.length * count <= 32768) return text.repeat(count);
  let result = new PieceTree(),
    part = new PieceTree(text);
  while (count > 0) {
    if (count % 2) result = result.replace(result.length, result.length, part);
    count = Math.floor(count / 2);
    if (count) part = part.replace(part.length, part.length, part);
  }
  return result;
}

function indentSource(editor, level) {
  if (editor.getSoftTabs()) return repeat(" ", Math.floor(level * editor.getTabLength()));
  const tabs = repeat("\t", Math.floor(level));
  const spaces = " ".repeat(Math.round((level - Math.floor(level)) * editor.getTabLength()));
  return typeof tabs === "string" ? tabs + spaces : tabs.replace(tabs.length, tabs.length, spaces);
}

async function columnForIndent(source, info, level, tabLength, check) {
  let columns = 0,
    offset = info.start,
    deadline = performance.now() + 4;
  const goal = level * tabLength,
    read = source.reader(4096);
  while (columns < goal && offset < info.end) {
    const text = read(offset).slice(0, info.end - offset);
    for (let index = 0; index < text.length && columns < goal; index++) {
      if (text[index] === " ") columns++;
      else if (text[index] === "\t") columns += tabLength - (columns % tabLength);
      else return offset - info.start;
      offset++;
    }
    if (performance.now() >= deadline) {
      await pause();
      check();
      deadline = performance.now() + 4;
    }
  }
  return offset - info.start;
}

async function toggleComments(
  editor,
  startRow,
  endRow,
  startToken,
  endToken,
  options,
  prepareOnly = false,
) {
  if (/[\r\n]/.test(startToken) || /[\r\n]/.test(endToken || ""))
    throw new Error("Comment delimiters must occupy one line");
  const buffer = editor.getBuffer(),
    source = buffer.getTextSnapshot();
  const expectedRevision = buffer.getTextRevision();
  const ownerCurrent = editor.captureTextMutationGuard(options);
  const mode = buffer.getLanguageMode(),
    tabLength = editor.getTabLength(),
    softTabs = editor.getSoftTabs();
  const isCurrent = () =>
    ownerCurrent() &&
    buffer.getLanguageMode() === mode &&
    editor.getTabLength() === tabLength &&
    editor.getSoftTabs() === softTabs;
  const check = () => {
    if (options.signal?.aborted)
      throw Object.assign(new Error("Comment edit cancelled"), { name: "AbortError" });
    if (!isCurrent())
      throw Object.assign(new Error("Comment edit is stale"), { code: "ERR_STALE_EDIT" });
  };
  const inspect = inspectRows(source, editor.getTabLength(), check);
  const startColumns = (info) => {
    if (
      info.blank ||
      source.slice(info.contentStart, Math.min(info.end, info.contentStart + startToken.length)) !==
        startToken
    )
      return null;
    const end = info.contentStart + startToken.length;
    return [
      info.contentStart - info.start,
      end - info.start + (source.charCodeAt(end) === 32 ? 1 : 0),
    ];
  };
  if (endToken) {
    const first = await inspect(startRow);
    const opening = startColumns(first);
    let edits;
    if (opening) {
      const last = rowBounds(source, endRow);
      let end = last.end,
        deadline = performance.now() + 4;
      while (end > last.start) {
        const offset = Math.max(last.start, end - 4096);
        const text = source.slice(offset, end),
          trimmed = text.trimEnd();
        end = offset + trimmed.length;
        if (trimmed.length) break;
        if (performance.now() >= deadline) {
          await pause();
          check();
          deadline = performance.now() + 4;
        }
      }
      if (
        end - last.start < endToken.length ||
        source.slice(end - endToken.length, end) !== endToken
      )
        return 0;
      let from = end - endToken.length;
      if (source.charCodeAt(from - 1) === 32) from--;
      edits = [
        {
          range: [
            [startRow, opening[0]],
            [startRow, opening[1]],
          ],
          text: "",
        },
        {
          range: [
            [endRow, from - last.start],
            [endRow, end - last.start],
          ],
          text: "",
        },
      ];
      if (startRow === endRow && opening[1] >= from - last.start)
        edits = [
          {
            range: [
              [startRow, opening[0]],
              [endRow, end - last.start],
            ],
            text: "",
          },
        ];
    } else {
      const end = rowBounds(source, endRow);
      const column = first.contentStart - first.start;
      edits = [
        {
          range: [
            [startRow, column],
            [startRow, column],
          ],
          text: startToken + " ",
        },
        {
          range: [
            [endRow, end.end - end.start],
            [endRow, end.end - end.start],
          ],
          text: " " + endToken,
        },
      ];
      if (startRow === endRow && column === end.end - end.start)
        edits = [{ range: edits[0].range, text: startToken + "  " + endToken }];
    }
    const commitOptions = {
      expectedRevision,
      isCurrent,
      signal: options.signal,
      didCommit:
        !opening && options.correctSelection && options.selection
          ? () => {
              for (const selection of options.selections || [options.selection]) {
                const range = selection.getBufferRange();
                const endLength = buffer.lineLengthForRow(endRow);
                const indentLength = first.contentStart - first.start;
                if (range.isEmpty()) {
                  if (range.start.row === endRow && range.start.column === endLength) {
                    const point = [endRow, endLength - endToken.length - 1];
                    selection.setBufferRange([point, point], { autoscroll: false });
                  }
                } else {
                  const startDelta =
                    range.start.row === startRow && range.start.column === indentLength
                      ? [0, startToken.length + 1]
                      : [0, 0];
                  const endDelta =
                    range.end.row === endRow && range.end.column === endLength
                      ? [0, -endToken.length - 1]
                      : [0, 0];
                  selection.setBufferRange(range.translate(startDelta, endDelta), {
                    autoscroll: false,
                  });
                }
              }
            }
          : undefined,
    };
    return prepareOnly
      ? { edits, didCommit: commitOptions.didCommit }
      : buffer.applyTextEdits(edits, commitOptions);
  }
  let commented = false,
    uncommented = false,
    minIndent = Infinity,
    minBlank = Infinity;
  let deadline = performance.now() + 4;
  for (let row = startRow; row <= endRow; row++) {
    check();
    const pending = inspect(row),
      info = pending?.then ? await pending : pending;
    if (info.blank) minBlank = Math.min(minBlank, info.indentLevel);
    else {
      minIndent = Math.min(minIndent, info.indentLevel);
      if (startColumns(info)) commented = true;
      else uncommented = true;
    }
    if (row % 64 === 0 && performance.now() >= deadline) {
      await pause();
      deadline = performance.now() + 4;
    }
  }
  const remove = commented && !uncommented;
  minIndent = Number.isFinite(minIndent) ? minIndent : Number.isFinite(minBlank) ? minBlank : 0;
  const indentation = indentSource(editor, minIndent);
  const blankText =
    typeof indentation === "string"
      ? indentation + startToken + " "
      : indentation.replace(indentation.length, indentation.length, startToken + " ");
  async function* edits() {
    let batch = [],
      deadline = performance.now() + 4;
    for (let row = startRow; row <= endRow; row++) {
      check();
      const pending = inspect(row),
        info = pending?.then ? await pending : pending;
      if (remove) {
        const columns = startColumns(info);
        if (columns)
          batch.push({
            range: [
              [row, columns[0]],
              [row, columns[1]],
            ],
            text: "",
          });
      } else if (info.blank)
        batch.push({
          range: [
            [row, 0],
            [row, info.end - info.start],
          ],
          text: blankText,
        });
      else {
        const column =
          minIndent === 0
            ? 0
            : await columnForIndent(source, info, minIndent, editor.getTabLength(), check);
        batch.push({
          range: [
            [row, column],
            [row, column],
          ],
          text: startToken + " ",
        });
      }
      if (batch.length === 64) {
        yield batch;
        batch = [];
      }
      if (row % 64 === 0 && performance.now() >= deadline) {
        await pause();
        deadline = performance.now() + 4;
      }
    }
    if (batch.length) yield batch;
  }
  return prepareOnly
    ? { edits: edits() }
    : buffer.applyTextEdits(edits(), { expectedRevision, isCurrent, signal: options.signal });
}

async function toggleSelections(editor, options) {
  const buffer = editor.getBuffer(),
    mode = buffer.getLanguageMode();
  const revision = buffer.getTextRevision(),
    epoch = mode.getSyntaxRequestEpoch?.();
  const ownerCurrent = editor.captureTextMutationGuard(options);
  const isCurrent = () =>
    ownerCurrent() && buffer.getLanguageMode() === mode && mode.getSyntaxRequestEpoch?.() === epoch;
  const selections = editor.getSelectionsOrderedByBufferPosition();
  const rows = selections.map((selection) => selection.getBufferRowRange());
  let comments;
  if (!Object.hasOwn(options, "commentStrings") && mode.asynchronousSyntax)
    comments = await mode.commentStringsForRows([...new Set(rows.map(([start]) => start))]);
  if (!isCurrent()) return;
  const groups = [];
  for (let index = 0; index < selections.length; index++) {
    const [start, end] = rows[index];
    const descriptor = Object.hasOwn(options, "commentStrings")
      ? options.commentStrings
      : comments
        ? comments.get(start)
        : await mode.commentStringsForPosition?.({ row: start, column: 0 });
    const startToken = descriptor?.commentStartString?.trim(),
      endToken = descriptor?.commentEndString?.trim();
    if (!startToken) continue;
    if (/[\r\n]/.test(startToken) || /[\r\n]/.test(endToken || ""))
      throw new Error("Comment delimiters must occupy one line");
    const previous = groups.at(-1);
    if (previous && start <= previous.end) {
      if (startToken !== previous.startToken || endToken !== previous.endToken)
        throw new Error("Overlapping selections require different comment delimiters");
      previous.end = Math.max(previous.end, end);
      previous.selections.push(selections[index]);
    } else groups.push({ start, end, startToken, endToken, selections: [selections[index]] });
  }
  if (!isCurrent() || !groups.length) return;
  const plans = [];
  for (const group of groups) {
    const plan = await toggleComments(
      editor,
      group.start,
      group.end,
      group.startToken,
      group.endToken,
      {
        ...options,
        selection: group.selections[0],
        selections: group.selections,
        correctSelection: true,
      },
      true,
    );
    if (plan) plans.push(plan);
  }
  if (!isCurrent() || !plans.length) return;
  async function* edits() {
    for (const plan of plans) for await (const batch of plan.edits) yield batch;
  }
  return buffer.applyTextEdits(edits(), {
    expectedRevision: revision,
    isCurrent,
    signal: options.signal,
    didCommit() {
      for (const plan of plans) plan.didCommit?.();
    },
  });
}

module.exports = { inspectRows, indentSource, toggleComments, toggleSelections };
