const pause = () => new Promise((resolve) => setImmediate(resolve));

function collapseWhitespace(editor, options, blankLines) {
  const buffer = editor.getBuffer();
  const source = buffer.getTextSnapshot();
  const expectedRevision = buffer.getTextRevision();
  const isCurrent = editor.captureTextMutationGuard(options);
  const at = (offset) => source.positionAt(offset);
  async function* edits() {
    let pending = null,
      offset = 0,
      inIndent = true;
    let deadline = performance.now() + 4;
    const finish = () => {
      if (!pending) return null;
      let { start, end } = pending;
      pending = null;
      if (blankLines) {
        for (let count = 0; count < 2 && start < end; count++)
          start += source.charCodeAt(start) === 13 && source.charCodeAt(start + 1) === 10 ? 2 : 1;
        return start < end ? { range: [at(start), at(end)], text: "" } : null;
      }
      return end - start > 1 ? { range: [at(start), at(end)], text: " " } : null;
    };
    for (const chunk of source.chunks()) {
      if (!isCurrent())
        throw Object.assign(new Error("Whitespace edit is stale"), { code: "ERR_STALE_EDIT" });
      if (options.signal?.aborted)
        throw Object.assign(new Error("Whitespace edit cancelled"), { name: "AbortError" });
      const pattern = blankLines ? /[\r\n]+/g : / +|\t+|\n|[^ \t\n]+/g;
      for (const match of chunk.matchAll(pattern)) {
        const start = offset + match.index;
        const end = start + match[0].length;
        const isRun = blankLines || (match[0][0] === " " && !inIndent);
        if (pending && (!isRun || pending.end !== start)) {
          const edit = finish();
          if (edit) yield edit;
        }
        if (isRun) {
          if (pending) pending.end = end;
          else pending = { start, end };
        }
        if (!blankLines) {
          if (match[0][0] === "\n") inIndent = true;
          else if (match[0][0] !== " " && match[0][0] !== "\t") inIndent = false;
        }
      }
      offset += chunk.length;
      if (blankLines && pending && pending.end < offset) {
        const edit = finish();
        if (edit) yield edit;
      }
      if (performance.now() >= deadline) {
        await pause();
        deadline = performance.now() + 4;
      }
    }
    const edit = finish();
    if (edit) yield edit;
  }
  const apply = () =>
    buffer.applyTextEdits(edits(), {
      expectedRevision,
      isCurrent,
      signal: options.signal,
    });
  return blankLines && editor.component ? editor.component.preserveScrollPosition(apply) : apply();
}

module.exports = { collapseWhitespace };
