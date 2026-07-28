"use strict";

const path = require("path");

// Row construction for the modal list template: Entry derivation (the cheap
// per-item layer the matcher and selection engine read), Row descriptor → DOM,
// and the match-highlight helpers shared with every renderer.
//
// Layering (see the workspace design doc `_design-atom-modals.md`):
//   Item  — whatever the source produced; opaque to the kernel.
//   Entry — `{id, text, fields?, alwaysShow?, selectable?}` derived for EVERY
//           item; feeds the matcher, `selectionStrategy: "follow"`, the checked
//           set, preview dedup and ARIA. `text` is always a string.
//   Row   — presentation only; built lazily for visible rows.

// Derives the Entry for an item. `renderer.entry` overrides; this is the
// default. Identity may be an object (compared by ===) when items repeat their
// labels (pane items, Grammar objects).
function defaultEntry(item, index) {
  if (item == null) {
    return { id: index, text: "" };
  }
  if (typeof item === "string") {
    return { id: item, text: item };
  }
  const text = item.matchOn ?? item.filterKey ?? item.label ?? item.text ?? item.path;
  return {
    id: item.id ?? item,
    text: typeof text === "string" ? text : text != null ? String(text) : "",
    alwaysShow: !!item.alwaysShow,
    selectable: item.selectable !== false && item.kind !== "separator",
  };
}

function normalizeEntry(entry, item, index) {
  if (!entry || typeof entry !== "object") return defaultEntry(item, index);
  let text = entry.text;
  if (typeof text !== "string") {
    if (atom.inDevMode() || atom.inSpecMode()) {
      throw new TypeError(`modals: Entry.text must be a string (item ${index})`);
    }
    text = text != null ? String(text) : "";
  }
  return {
    id: entry.id ?? index,
    text,
    fields: entry.fields,
    alwaysShow: !!entry.alwaysShow,
    selectable: entry.selectable !== false,
  };
}

// Splits `className` inputs ("a b", ["a", "b"]) into clean class lists.
function classList(value) {
  if (!value) return [];
  const names = Array.isArray(value) ? value : String(value).split(/\s+/);
  return names.filter(Boolean);
}

function textAndTooltip(value) {
  if (value && typeof value === "object" && !(value instanceof Node) && "text" in value) {
    return { content: value.text, tooltip: value.tooltip };
  }
  return { content: value, tooltip: undefined };
}

function appendContent(parent, content) {
  if (content == null) return;
  if (typeof content === "string") {
    parent.appendChild(document.createTextNode(content));
  } else if (typeof content.nodeType === "number") {
    parent.appendChild(content);
  } else {
    parent.appendChild(document.createTextNode(String(content)));
  }
}

// Applies an IconSpec to `element`. Returns a disposable-ish undo or null.
function applyIcon(element, icon, rowPath) {
  if (icon === false) return null;
  if (icon == null && rowPath == null) return null;
  if (typeof icon === "string" || Array.isArray(icon)) {
    element.classList.add("icon", ...classList(icon));
    return null;
  }
  if (icon && typeof icon === "object") {
    if (icon.element instanceof HTMLElement) {
      element.classList.add("icon");
      element.appendChild(icon.element);
      return null;
    }
    if (icon.class) {
      element.classList.add("icon", ...classList(icon.class));
      return null;
    }
    if (icon.path) rowPath = icon.path;
  }
  if (rowPath != null && typeof atom !== "undefined" && atom.icons) {
    element.classList.add("icon");
    return atom.icons.applyTo(element, { path: rowPath }, { setData: false });
  }
  return null;
}

// Builds a DocumentFragment for `text` with `.character-match` spans at the
// given character offsets. Offsets outside the text are ignored.
function highlight(text, offsets, options = {}) {
  const { className = "character-match" } = options;
  const fragment = document.createDocumentFragment();
  if (text == null) return fragment;
  text = String(text);
  if (!offsets || offsets.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  const valid = offsets.filter((i) => i >= 0 && i < text.length);
  if (valid.length === 0) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }
  let last = 0;
  let run = "";
  const flush = () => {
    if (!run) return;
    const span = document.createElement("span");
    span.className = className;
    span.textContent = run;
    span.setAttribute("aria-hidden", "true");
    fragment.appendChild(span);
    run = "";
  };
  for (const index of valid) {
    if (index > last) {
      flush();
      fragment.appendChild(document.createTextNode(text.slice(last, index)));
    }
    run += text[index];
    last = index + 1;
  }
  flush();
  if (last < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(last)));
  }
  return fragment;
}

// Highlights across a CONCATENATION of styled segments, splitting offsets at
// segment boundaries. Replaces every hand-rolled `indices.map(i => i - offset)`.
// Segments: string | {text, className}.
function highlightSegments(segments, offsets, options = {}) {
  const fragment = document.createDocumentFragment();
  let start = 0;
  for (const segment of segments) {
    if (segment == null) continue;
    const text = typeof segment === "string" ? segment : (segment.text ?? "");
    const end = start + text.length;
    const local = offsets
      ? offsets.filter((i) => i >= start && i < end).map((i) => i - start)
      : null;
    const piece = highlight(text, local, options);
    if (typeof segment === "object" && segment.className) {
      const span = document.createElement("span");
      span.classList.add(...classList(segment.className));
      span.appendChild(piece);
      fragment.appendChild(span);
    } else {
      fragment.appendChild(piece);
    }
    start = end;
  }
  return fragment;
}

// Builds the right-hand block of the primary line: badges, keybinding chips,
// buttons, and free-form trailing entries.
function buildTrailing(row, ctx) {
  const parts = [];

  if (row.badges) {
    for (const badge of [].concat(row.badges)) {
      if (badge == null) continue;
      const span = document.createElement("span");
      span.classList.add("badge");
      if (typeof badge === "object") {
        span.classList.add(...classList(badge.className));
        span.textContent = badge.text ?? "";
        if (badge.tooltip) span.title = badge.tooltip;
      } else {
        span.textContent = String(badge);
      }
      parts.push(span);
    }
  }

  if (row.keybinding) {
    for (const binding of [].concat(row.keybinding)) {
      if (binding == null) continue;
      let keystrokes = null;
      if (typeof binding === "string") {
        keystrokes = [binding];
      } else if (binding.command && typeof atom !== "undefined") {
        const target = binding.target ?? ctx?.session?.target?.element ?? document.body;
        const found = atom.keymaps.findKeyBindings({ command: binding.command, target });
        const seen = new Set();
        keystrokes = [];
        for (const kb of found) {
          if (seen.has(kb.keystrokes)) continue;
          seen.add(kb.keystrokes);
          keystrokes.push(kb.keystrokes);
          if (binding.max && keystrokes.length >= binding.max) break;
        }
      }
      for (const keystroke of keystrokes ?? []) {
        const kbd = document.createElement("kbd");
        kbd.classList.add("key-binding");
        kbd.textContent = keystroke;
        parts.push(kbd);
      }
    }
  }

  if (row.buttons) {
    for (const button of row.buttons) {
      if (!button) continue;
      const el = document.createElement("button");
      el.classList.add("modals-row-button");
      el.tabIndex = -1;
      applyIcon(el, button.icon, null);
      if (button.tooltip) el.title = button.tooltip;
      el.dataset.modalRowButton = typeof button.action === "string" ? button.action : "";
      if (typeof button.action === "function") el._modalRowAction = button.action;
      parts.push(el);
    }
  }

  if (row.trailing) {
    for (const entry of [].concat(row.trailing)) {
      if (!entry) continue;
      if (typeof entry.nodeType === "number") {
        parts.push(entry);
        continue;
      }
      const span = document.createElement("span");
      span.classList.add(...classList(entry.className));
      span.textContent = entry.text ?? "";
      parts.push(span);
    }
  }

  if (parts.length === 0) return null;
  const block = document.createElement("span");
  block.classList.add("trailing-block");
  for (const part of parts) block.appendChild(part);
  return block;
}

// Row descriptor → <li>. `ctx.highlights` supplies per-field offsets; the
// default renderer highlights the label with the "label" field's offsets.
function buildRowElement(row, ctx) {
  if (row.element instanceof HTMLElement) {
    return row.element;
  }

  const li = document.createElement("li");
  li.classList.add(...classList(row.className));
  if (row.kind === "separator") {
    li.classList.add("separator");
    li.setAttribute("role", "presentation");
    const { content } = textAndTooltip(row.label);
    appendContent(li, content);
    return li;
  }

  const label = textAndTooltip(row.label ?? (row.path != null ? path.basename(row.path) : ""));
  const detailValues =
    row.detail == null ? [] : Array.isArray(row.detail) ? row.detail : [row.detail];
  if (detailValues.length > 0) li.classList.add("two-lines");
  if (row.disabled) li.classList.add("disabled");
  if (row.active) li.classList.add("mark-active");
  if (row.dataset) {
    for (const key of Object.keys(row.dataset)) li.dataset[key] = row.dataset[key];
  }

  const primary = document.createElement("div");
  primary.classList.add("primary-line");
  applyIcon(primary, row.icon, row.path ?? null);

  const primaryText = document.createElement("span");
  primaryText.classList.add("primary-text");
  if (label.tooltip) primaryText.title = label.tooltip;
  const labelOffsets = ctx && ctx.highlights ? ctx.highlights.label : null;
  if (typeof label.content === "string" && labelOffsets && labelOffsets.length) {
    primaryText.appendChild(highlight(label.content, labelOffsets));
  } else {
    appendContent(primaryText, label.content);
  }
  primary.appendChild(primaryText);

  if (row.description != null) {
    const desc = textAndTooltip(row.description);
    const span = document.createElement("span");
    span.classList.add("description");
    if (desc.tooltip) span.title = desc.tooltip;
    const descOffsets = ctx && ctx.highlights ? ctx.highlights.description : null;
    if (typeof desc.content === "string" && descOffsets && descOffsets.length) {
      span.appendChild(highlight(desc.content, descOffsets));
    } else {
      appendContent(span, desc.content);
    }
    primary.appendChild(span);
  }

  const trailing = buildTrailing(row, ctx);
  if (trailing) primary.appendChild(trailing);
  li.appendChild(primary);

  for (const value of detailValues) {
    const detail = textAndTooltip(value);
    const line = document.createElement("div");
    line.classList.add("secondary-line");
    if (detail.tooltip) line.title = detail.tooltip;
    const detailOffsets = ctx && ctx.highlights ? ctx.highlights.detail : null;
    if (typeof detail.content === "string" && detailOffsets && detailOffsets.length) {
      line.appendChild(highlight(detail.content, detailOffsets));
    } else {
      appendContent(line, detail.content);
    }
    li.appendChild(line);
  }

  return li;
}

module.exports = {
  defaultEntry,
  normalizeEntry,
  buildRowElement,
  highlight,
  highlightSegments,
  classList,
  applyIcon,
};
