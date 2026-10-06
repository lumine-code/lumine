// Compares “informal” points like the ones in a Tree-sitter tree; saves us
// from having to convert them to actual `Point`s.
function comparePoints(a, b) {
  const rows = a.row - b.row;
  if (rows === 0) {
    return a.column - b.column;
  } else {
    return rows;
  }
}

function resolveNodeDescriptor(node, descriptor) {
  let parts = descriptor.split(".");
  let result = node;
  while (result !== null && parts.length > 0) {
    let part = parts.shift();
    if (!result[part]) {
      return null;
    }
    result = result[part];
  }
  return result;
}

function resolveNodePosition(node, descriptor) {
  let parts = descriptor.split(".");
  let lastPart = parts.pop();
  let result = parts.length === 0 ? node : resolveNodeDescriptor(node, parts.join("."));
  if (!result) {
    return null;
  }
  return result[lastPart];
}

module.exports = { comparePoints, resolveNodePosition };
