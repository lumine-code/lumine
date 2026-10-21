function comments(context, position) {
  const { commentStartString, commentEndString, commentDelimiters } =
    context.getCommentStringsForBufferPosition(position);
  if (commentDelimiters) return commentDelimiters;
  if (!commentStartString) return null;
  return commentEndString
    ? { block: [commentStartString.trim(), commentEndString.trim()] }
    : { line: commentStartString.trim() };
}

exports.points = async function (context, { positions, kind }, { signal, emit }) {
  const dictionary = new Map();
  for (let start = 0; start < positions.length; start += 512) {
    const end = Math.min(start + 512, positions.length);
    const labels = new Uint32Array((end - start) / 2);
    const values = [];
    for (let index = start; index < end; index += 2) {
      signal.throwIfAborted();
      const position = new context.Point(positions[index], positions[index + 1]);
      const value =
        kind === "scopes"
          ? context.scopeDescriptorForBufferPosition(position).getScopesArray()
          : comments(context, position);
      const key = JSON.stringify(value);
      let id = dictionary.get(key);
      if (id === undefined) {
        id = dictionary.size;
        dictionary.set(key, id);
        values.push(value);
      }
      labels[(index - start) / 2] = id;
    }
    await emit({ labels, values }, [labels.buffer]);
  }
  return { count: positions.length / 2 };
};

exports.paragraphs = async function (context, { rows }, { signal, emit }) {
  const found = new Map();
  let previous,
    steps = 0;
  const pause = () => new Promise((resolve) => setImmediate(resolve));
  for (const row of [...new Set(rows)].sort((a, b) => a - b)) {
    signal.throwIfAborted();
    if (previous && row >= previous.start.row && row <= previous.end.row) {
      found.set(row, previous);
      continue;
    }
    const line = context.lineTextForBufferRow(row);
    if (typeof line !== "string" || !/\S/.test(line)) {
      found.set(row, null);
      continue;
    }
    const commented = context.isBufferRowCommented(row);
    let start = row,
      end = row;
    while (
      start > 0 &&
      /\S/.test(context.lineTextForBufferRow(start - 1)) &&
      context.isBufferRowCommented(start - 1) === commented
    ) {
      start--;
      if (++steps % 128 === 0) {
        await pause();
        signal.throwIfAborted();
      }
    }
    while (
      end < context.getLastBufferRow() &&
      /\S/.test(context.lineTextForBufferRow(end + 1)) &&
      context.isBufferRowCommented(end + 1) === commented
    ) {
      end++;
      if (++steps % 128 === 0) {
        await pause();
        signal.throwIfAborted();
      }
    }
    previous = new context.Range([start, 0], [end, context.buffer.lineLengthForRow(end)]);
    found.set(row, previous);
  }
  for (let start = 0; start < rows.length; start += 256) {
    signal.throwIfAborted();
    await emit(rows.slice(start, start + 256).map((row) => found.get(row)));
  }
  return { count: rows.length };
};
