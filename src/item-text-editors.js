const TextEditor = require("./text-editor");

function fileEditorForItem(item) {
  if (item instanceof TextEditor) return item;
  const editor = item?.getFileTextEditor?.();
  return editor instanceof TextEditor ? editor : undefined;
}

function embeddedEditorForItem(item) {
  if (item instanceof TextEditor) return item;
  const editor = item?.getActiveEmbeddedTextEditor?.();
  return editor instanceof TextEditor ? editor : undefined;
}

module.exports = { fileEditorForItem, embeddedEditorForItem };
