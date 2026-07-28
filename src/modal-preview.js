"use strict";

const fs = require("fs");
const path = require("path");
const { CompositeDisposable, Disposable } = require("event-kit");
const TextEditor = require("./text-editor");

// The preview column.
//
// Arrowing through a two-hundred-row picker must not create two hundred
// editors, so previewing a file does not open it: one long-lived read-only
// editor per window is reused, fed a windowed slice of the file, and given a
// language mode resolved from the path. No pane item, no tab, no history entry,
// no watcher, no serialization.
//
// `previewers.paneItem()` is the deliberate exception — see
// `modal-workspace-preview.js` — for the case where the user genuinely wants
// the editor to move.

const DEFAULT_DEBOUNCE = 120;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINES = 400;
const SPLIT_BELOW = 900;
const COLLAPSE_BELOW = 640;
const BINARY_SNIFF_BYTES = 8192;

function normalizePreviewer(value) {
  if (value == null || value === false) return null;
  if (typeof value === "function") return { render: value };
  if (typeof value.render === "function") return value;
  throw new TypeError("modals: `preview` must be false, a function, or {render}");
}

const previewers = {
  file(get) {
    return {
      render: async (req) => {
        const target = get(req.item);
        if (!target) return null;
        return typeof target === "string" ? { path: target } : { ...target, path: target.path };
      },
    };
  },

  buffer(get) {
    return {
      render: (req) => {
        const target = get(req.item);
        return target ? { text: target.text, grammar: target.grammar, row: target.row } : null;
      },
    };
  },

  element(get) {
    return {
      render: (req) => {
        const element = get(req.item, req);
        return element ? { element } : null;
      },
    };
  },

  markdown(get) {
    return {
      render: (req) => {
        const markdown = get(req.item);
        return markdown ? { markdown } : null;
      },
    };
  },

  none() {
    return false;
  },
};

// Reads at most `maxBytes` and returns the window of lines around `row`, so a
// huge file costs a bounded read rather than a full one.
async function readSlice(filePath, { maxBytes, maxLines, row }) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return { message: "Not a file" };

    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);

    // A NUL byte early on is the cheap, conventional binary tell; rendering
    // binary as text is worse than saying so.
    const sniff = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, length));
    if (sniff.includes(0)) return { message: "Binary file" };

    let text = buffer.toString("utf8");
    let truncated = stat.size > maxBytes;
    let firstRow = 0;

    if (maxLines) {
      const lines = text.split("\n");
      if (lines.length > maxLines) {
        const half = Math.floor(maxLines / 2);
        firstRow = Math.max(0, (row ?? 0) - half);
        text = lines.slice(firstRow, firstRow + maxLines).join("\n");
        truncated = true;
      }
    }

    return { text, truncated, firstRow };
  } catch (error) {
    return { message: error.code === "ENOENT" ? "File not found" : error.message };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

class ModalPreview {
  constructor(host) {
    this.host = host;
    this.subscriptions = new CompositeDisposable();
    this.previewer = null;
    this.generation = 0;
    this.lastItemId = null;
    this.debounceTimer = null;
    this.controller = null;

    this.element = document.createElement("div");
    this.element.classList.add("modals-preview");
    this.element.style.display = "none";

    this.message = document.createElement("div");
    this.message.classList.add("modals-preview-message");
    this.element.appendChild(this.message);

    this.content = document.createElement("div");
    this.content.classList.add("modals-preview-content");
    this.element.appendChild(this.content);
  }

  // One editor per window, created on first preview and reused forever. It is
  // registered `background` so cross-editor features skip it.
  ensureEditor() {
    if (this.editor) return this.editor;
    this.editor = new TextEditor({ readOnly: true, keyboardInputEnabled: false });
    this.editor.element.classList.add("modals-preview-editor");
    this.editorSubscriptions = new CompositeDisposable(
      atom.textEditors.add(this.editor, { role: "background" }),
      atom.textEditors.maintainConfig(this.editor),
    );
    return this.editor;
  }

  applyView(spec) {
    this.previewer = normalizePreviewer(spec.preview);
    this.collapsed = !!(this.previewer && this.previewer.collapsed);
    this.lastItemId = null;
    this.abort();
    this.clear();
    this.element.style.display = this.previewer ? "" : "none";
    return !!this.previewer;
  }

  get isActive() {
    return !!this.previewer && !this.collapsed;
  }

  toggleCollapsed() {
    if (!this.previewer) return;
    this.collapsed = !this.collapsed;
    this.element.style.display = this.collapsed ? "none" : "";
    this.host.updateLayout();
    if (!this.collapsed) this.request(this.host.session, { immediate: true });
  }

  // Resolves the layout from the host's own width, not the window's: a modal
  // that is not wide enough to show both columns stacks, and below that hides
  // the preview until it is asked for.
  layoutFor(width) {
    const previewer = this.previewer ?? {};
    const splitBelow = previewer.splitBelow ?? SPLIT_BELOW;
    const collapseBelow = previewer.collapseBelow ?? COLLAPSE_BELOW;
    if (width >= splitBelow) return "split";
    if (width >= collapseBelow) return "stacked";
    return "list";
  }

  request(session, { immediate = false } = {}) {
    if (!this.isActive || !session) return;
    const item = session.getFocusedItem();
    if (item == null) {
      this.abort();
      this.clear();
      this.lastItemId = null;
      return;
    }

    // A provisional focused row — the source is still running for this query —
    // is not worth previewing yet. Checked before the dedupe below, or the
    // first request would claim the row id and the real one would be dropped.
    if (session.frame.source && !session.frame.settled) return;

    // Dedupe by row identity: focus notifications can repeat for the same row,
    // and re-reading the same file on each one is pure waste.
    const entry = session.frame.focusedEntry();
    const id = entry ? entry.id : item;
    if (id === this.lastItemId) return;
    this.lastItemId = id;

    if (this.debounceTimer != null) clearTimeout(this.debounceTimer);
    const delay = immediate ? 0 : (this.previewer.debounce ?? DEFAULT_DEBOUNCE);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pending = this.render(session, item);
    }, delay);
  }

  // Resolves when nothing is in flight. Specs await this rather than guessing
  // how many microtask turns a file read takes.
  async whenIdle() {
    for (let pass = 0; pass < 5; pass++) {
      const pending = this.pending;
      if (!pending) return;
      await pending;
      if (pending === this.pending) return;
    }
  }

  abort() {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  async render(session, item) {
    this.abort();
    const generation = ++this.generation;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const rect = this.element.getBoundingClientRect();
    const req = {
      item,
      query: session.getQuery(),
      signal,
      session,
      width: rect.width,
      height: rect.height,
      horizontal: this.host.dataset.layout === "split",
    };

    let content;
    try {
      content = await this.previewer.render(req);
    } catch (error) {
      console.error("modals: previewer threw", error);
      content = { message: error.message || String(error), severity: "error" };
    }

    // Anything resolved for a row the user has already moved off must never
    // reach the DOM.
    if (generation !== this.generation || signal.aborted) return;
    await this.present(content, generation, signal);
  }

  async present(content, generation, signal) {
    if (!content) {
      this.clear();
      return;
    }

    if (content.message != null) {
      this.showMessage(content.message, content.severity);
      return;
    }

    if (content.element) {
      this.showElement(content.element);
      return;
    }

    if (content.markdown != null) {
      const html = document.createElement("div");
      html.classList.add("markdown", "native-key-bindings");
      html.innerHTML =
        atom.ui.markdown && atom.ui.markdown.render
          ? atom.ui.markdown.render(content.markdown)
          : content.markdown;
      this.showElement(html);
      return;
    }

    const previewer = this.previewer ?? {};
    let text = content.text;
    let firstRow = 0;

    if (content.path != null) {
      const slice = await readSlice(content.path, {
        maxBytes: previewer.maxBytes ?? DEFAULT_MAX_BYTES,
        maxLines: previewer.maxLines ?? DEFAULT_MAX_LINES,
        row: content.row,
      });
      if (generation !== this.generation || signal.aborted) return;
      if (slice.message) {
        this.showMessage(slice.message);
        return;
      }
      text = slice.text;
      firstRow = slice.firstRow;
      if (slice.truncated) text += "\n…truncated";
    }

    if (text == null) {
      this.clear();
      return;
    }

    const editor = this.ensureEditor();
    // Through the buffer: TextEditor.setText refuses to mutate a read-only
    // editor, and throws rather than no-oping in dev and spec mode.
    editor.getBuffer().setText(text);

    const scopeName = content.grammar ?? (content.path ? this.scopeForPath(content.path) : null);
    if (scopeName) {
      atom.grammars.assignLanguageMode(editor.getBuffer(), scopeName);
    }

    this.showElement(editor.element);

    if (content.row != null) {
      const row = Math.max(0, content.row - firstRow);
      editor.setCursorBufferPosition([row, content.column ?? 0]);
      editor.scrollToBufferPosition([row, content.column ?? 0], { center: true });
    }
  }

  scopeForPath(filePath) {
    const grammar = atom.grammars.selectGrammar(filePath, "");
    return grammar ? grammar.scopeName : null;
  }

  showElement(element) {
    this.message.style.display = "none";
    if (this.content.firstChild !== element) {
      this.content.replaceChildren(element);
    }
    this.content.style.display = "";
  }

  showMessage(text, severity) {
    this.content.replaceChildren();
    this.content.style.display = "none";
    this.message.textContent = typeof text === "string" ? text : String(text);
    this.message.dataset.severity = severity ?? "info";
    this.message.style.display = "";
  }

  clear() {
    this.content.replaceChildren();
    this.content.style.display = "none";
    this.message.style.display = "none";
  }

  destroy() {
    this.abort();
    this.subscriptions.dispose();
    if (this.editorSubscriptions) this.editorSubscriptions.dispose();
    if (this.editor) this.editor.destroy();
    this.editor = null;
    this.element.remove();
  }
}

module.exports = { ModalPreview, previewers, normalizePreviewer, readSlice, Disposable, path };
