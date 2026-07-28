"use strict";

// `previewers.paneItem()` — the opt-in previewer that moves the real workspace.
//
// Everything else previews into a pooled background editor and leaves the
// workspace alone. This one exists for the case where the user genuinely wants
// the editor to follow the selection (jumping through symbols), and it is
// deliberately more expensive and more careful.
//
// Two facts drive the design, both verified against `workspace.open`:
//
//   * Opening a URI that is ALREADY open reuses the user's own editor. It never
//     becomes pending, so `Pane.addItem`'s replacing-pending-item cleanup never
//     runs — and `open` then moves that editor's cursor, unfolds a row and
//     re-centres its scroll. Arrowing through results that span several open
//     files therefore disturbs every one of them, which is why the snapshot is
//     per editor and not "the one editor that was active".
//   * Confirming has to un-pend the item it lands on, or the choice the user
//     just made lives in a preview tab that the next open destroys.

function createWorkspacePreviewer(get) {
  // Populated the first time a preview touches an editor, restored in full on
  // cancel. A Map, not a single slot: any number of editors can be disturbed.
  const snapshots = new Map();

  const snapshot = (editor) => {
    if (!editor || snapshots.has(editor)) return;
    snapshots.set(editor, {
      cursors: editor.getCursorBufferPositions(),
      selections: editor.getSelectedBufferRanges(),
      scrollTop: editor.element ? editor.element.getScrollTop() : null,
      foldedRows:
        typeof editor.getFoldedBufferRows === "function" ? editor.getFoldedBufferRows() : null,
    });
  };

  const previewer = {
    // Rendering happens through the workspace, so the column itself only ever
    // reports what it is doing.
    render: async (req) => {
      const target = get(req.item);
      if (!target || !target.uri) return null;

      const existing = atom.workspace
        .getTextEditors()
        .find((editor) => editor.getURI() === target.uri);
      snapshot(existing);

      const item = await atom.workspace.open(target.uri, {
        pending: true,
        activatePane: false,
        activateItem: true,
        initialLine: target.initialLine,
        initialColumn: target.initialColumn,
      });
      if (req.signal.aborted) return null;
      snapshot(item && item.getURI ? item : null);
      previewer.lastPreviewed = item;
      return { message: target.uri };
    },

    // Restores every editor this previewer disturbed. Called on any cancel —
    // including a replacement or a foreign force-hide — but never on confirm,
    // where landing where you chose is the point.
    restore() {
      for (const [editor, state] of snapshots) {
        if (!editor || (typeof editor.isDestroyed === "function" && editor.isDestroyed())) continue;
        if (state.selections && state.selections.length) {
          editor.setSelectedBufferRanges(state.selections);
        } else if (state.cursors && state.cursors.length) {
          editor.setCursorBufferPosition(state.cursors[0]);
        }
        if (state.foldedRows && typeof editor.foldBufferRow === "function") {
          for (const row of state.foldedRows) editor.foldBufferRow(row);
        }
        if (state.scrollTop != null && editor.element) {
          editor.element.setScrollTop(state.scrollTop);
        }
      }
      snapshots.clear();
    },

    // The previewed item is pending, so anything opened next would destroy it.
    // Confirming means the user chose it: make it a real item.
    keep() {
      const item = previewer.lastPreviewed;
      snapshots.clear();
      if (!item) return;
      const pane = atom.workspace.paneForItem(item);
      if (pane && pane.getPendingItem && pane.getPendingItem() === item) {
        pane.setPendingItem(null);
      }
    },
  };

  return previewer;
}

// `core.allowPendingPaneItems` off means the user has asked for no preview
// tabs at all; degrade to the pooled read-only editor rather than ignoring it.
function paneItem(get) {
  if (!atom.config.get("core.allowPendingPaneItems")) {
    const { previewers } = require("./modal-preview");
    return previewers.file((item) => {
      const target = get(item);
      if (!target || !target.uri) return null;
      return { path: target.uri, row: target.initialLine, column: target.initialColumn };
    });
  }
  return createWorkspacePreviewer(get);
}

module.exports = { paneItem, createWorkspacePreviewer };
