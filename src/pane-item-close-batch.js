const { fileEditorForItem } = require("./item-text-editors");

function documentForItem(item) {
  return item.getPaneItemDocument?.() ?? fileEditorForItem(item)?.getBuffer() ?? item;
}

async function confirmItemsClose(workspace, entries, options = {}) {
  const closing = new Set(entries.map(({ item }) => item));
  const remaining = (workspace?.getPaneItems() ?? []).filter((item) => !closing.has(item));
  const confirmed = new Set();
  for (const { pane, item } of entries) {
    const document = documentForItem(item);
    if (confirmed.has(document)) continue;
    const lastView = !remaining.some((candidate) => documentForItem(candidate) === document);
    if (!(await pane.promptToSaveItem(item, { ...options, lastView }))) return false;
    confirmed.add(document);
  }
  return true;
}

module.exports = { confirmItemsClose, documentForItem };
