const parentPort = (typeof require === "function"
  ? require("node:worker_threads").parentPort
  : null) || {
  on: (_name, callback) => {
    globalThis.onmessage = ({ data }) => callback(data);
  },
  postMessage: (message) => globalThis.postMessage(message),
};

let text, expression, counting;
parentPort.on("message", (request) => {
  try {
    if (!request.next) {
      text = request.text;
      expression = new RegExp(request.source, request.flags);
      expression.lastIndex = request.lastIndex;
      counting = request.counting ? { ...request.counting, count: 0 } : null;
    }
    if (counting) {
      const checkpoints = [],
        preview = [];
      let count = 0,
        done = false;
      for (let i = 0; i < 50000; i++) {
        const match = expression.exec(text);
        if (!match) {
          done = true;
          break;
        }
        const start = counting.contextStart + match.index,
          end = start + match[0].length;
        if (start >= counting.boundary && !counting.final) {
          done = true;
          break;
        }
        if (!match[0].length)
          expression.lastIndex +=
            (expression.unicode || expression.unicodeSets) &&
            text.codePointAt(expression.lastIndex) > 0xffff
              ? 2
              : 1;
        if (start < counting.cursor) continue;
        counting.cursor = counting.contextStart + expression.lastIndex;
        const addressStart =
          text.charCodeAt(match.index) === 10 && text.charCodeAt(match.index - 1) === 13
            ? start - 1
            : start;
        const addressEnd =
          text.charCodeAt(match.index + match[0].length) === 10 &&
          text.charCodeAt(match.index + match[0].length - 1) === 13
            ? end - 1
            : end;
        if (addressStart === counting.previousStart && addressEnd === counting.previousEnd)
          continue;
        counting.previousStart = addressStart;
        counting.previousEnd = addressEnd;
        const index = counting.base + counting.count;
        if (index % 1024 === 0) checkpoints.push({ index, offset: start });
        if (counting.preview > 0) {
          preview.push({ start, end });
          counting.preview--;
        }
        counting.count++;
        count++;
      }
      parentPort.postMessage({
        count,
        checkpoints,
        preview,
        done,
        cursor: counting.cursor,
        previousStart: counting.previousStart,
        previousEnd: counting.previousEnd,
      });
      if (done) {
        text = expression = counting = null;
      }
      return;
    }
    const matches = [];
    let done = false;
    for (let i = 0; i < 512; i++) {
      const match = expression.exec(text);
      if (!match) {
        done = true;
        break;
      }
      const result = Array.from(match);
      result.index = match.index;
      result.groups = match.groups;
      matches.push(result);
      if (!match[0].length)
        expression.lastIndex +=
          (expression.unicode || expression.unicodeSets) &&
          text.codePointAt(expression.lastIndex) > 0xffff
            ? 2
            : 1;
    }
    parentPort.postMessage({ matches, done });
    if (done) {
      text = null;
      expression = null;
    }
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
