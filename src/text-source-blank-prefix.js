// Only positively verified blank subtrees are remembered. Persistent snapshot
// identities let repeated leading Enter edits reuse the old prefix without
// retaining obsolete documents or rescanning a growing run of empty lines.
const blankNodes = new WeakMap();

module.exports = function canProveBlankPrefix(source, end) {
  const nodes = source.subtext(0, end).snapshotNodes(blankNodes);
  // A cold, arbitrarily large prefix must not block interactive input. Inspect
  // at most one backing buffer of new text; an unknown answer keeps the exact
  // syntax path. Later calls can reuse the already verified subtrees.
  let remaining = 32768;
  try {
    for (;;) {
      const next = nodes.next();
      if (next.done) return true;
      const { identity, text } = next.value;
      if (typeof text === "string") {
        if (text.length > remaining) return false;
        remaining -= text.length;
        if (/\S/.test(text)) return false;
      }
      // Nodes arrive in postorder. Reaching a branch means both children
      // were verified here or skipped because their identities were known.
      blankNodes.set(identity, true);
    }
  } finally {
    nodes.return();
  }
};
