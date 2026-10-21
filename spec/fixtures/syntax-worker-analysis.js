exports.summary = (context) => {
  const node = context.getSyntaxNodeAtBufferPosition([0, 0]);
  return { type: node.type, text: context.getText(), position: node.startPosition, path: context.getPath() };
};

exports.illegalNode = (context) => context.getSyntaxNodeAtBufferPosition([0, 0]);

exports.rootChildren = (context) => context.getRootSyntaxNode().namedChildren.map((node) => node.text);

exports.structure = async (context) => {
  const { createHash } = require("node:crypto");
  const result = [];
  for (const layer of context.getLanguageLayers()) {
    const hash = createHash("sha256"), stack = layer.rootNode ? [layer.rootNode] : [];
    let count = 0;
    while (stack.length) {
      context.signal.throwIfAborted();
      const node = stack.pop();
      hash.update(JSON.stringify([node.type, node.startIndex, node.endIndex, node.startPosition, node.endPosition, node.hasError]));
      const children = node.children;
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
      if (++count % 512 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    result.push({ scope: layer.scopeName, hash: hash.digest("hex"), count, ranges: layer.ranges });
  }
  return result.sort((a, b) => a.scope.localeCompare(b.scope) || a.hash.localeCompare(b.hash));
};

exports.rootRanges = (snapshot, { prefix }) => {
  const ranges = [];
  let row = 0;
  for (const line of snapshot.lines()) {
    if (line.startsWith(prefix)) ranges.push([[row, 0], [row, line.length]]);
    row++;
  }
  return ranges;
};

exports.waitForCancellation = async (_context, _params, { signal, emit }) => {
  await emit("started");
  signal.throwIfAborted();
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  signal.throwIfAborted();
};
