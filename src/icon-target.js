const path = require("path");

// What an icon is being asked for. Always an object: a bare string would leave
// `iconFor("markdown")` ambiguous between a file path and a semantic name, and
// there is no way to guess correctly.
//
// This module is pure — no filesystem, no `atom` global — so it stays cheap
// enough to run once per row of a completion list and trivial to spec.

const EMPTY_HINTS = Object.freeze({});

// Fixed order, because the tri-state signature below is positional.
const HINT_KEYS = ["directory", "symlink", "submodule", "repositoryRoot", "expanded", "virtual"];

function normalizeTarget(target) {
  if (target == null || typeof target !== "object") {
    throw new TypeError("An icon target must be an object: {path}, {name}, {kind}, or {item}");
  }

  let { name = null, kind = null, item = null } = target;
  let filePath = target.path ?? null;

  // A pane item is resolved here, once, so tabs, the MRU switcher and the
  // workspace finder cannot drift apart on which wins.
  if (item != null) {
    if (name == null && typeof item.getIconName === "function") {
      name = item.getIconName() || null;
    }
    if (name == null && filePath == null) filePath = pathForItem(item);
  }

  let type;
  if (name != null) type = "name";
  else if (kind != null) type = "kind";
  else if (filePath != null) type = "path";
  else type = "none";

  return Object.freeze({
    type,
    path: type === "path" ? filePath : null,
    name: type === "name" ? name : null,
    kind: type === "kind" ? kind : null,
    item,
    context: target.context ?? null,
    hints: normalizeHints(target.hints),
  });
}

function normalizeHints(hints) {
  if (hints == null) return EMPTY_HINTS;
  const normalized = {};
  for (const key of HINT_KEYS) {
    if (hints[key] !== undefined) normalized[key] = !!hints[key];
  }
  return Object.keys(normalized).length > 0 ? Object.freeze(normalized) : EMPTY_HINTS;
}

function pathForItem(item) {
  if (typeof item.getPath === "function") {
    const itemPath = item.getPath();
    if (itemPath) return itemPath;
  }
  if (typeof item.getURI === "function") {
    const uri = item.getURI();
    if (uri && !uri.includes("://")) return uri;
  }
  return null;
}

// A hint left undefined means "I don't know", which is a different question
// from "I know it is false". Keeping the three states apart in the key is what
// lets a tree-view entry (which knows) and a fuzzy-finder guess (which does
// not) cache the same path separately instead of poisoning each other.
function hintSignature(hints) {
  let signature = "";
  for (const key of HINT_KEYS) {
    const value = hints[key];
    signature += value === undefined ? "?" : value ? "1" : "0";
  }
  return signature;
}

function cacheKeyFor(normalized, { context = true } = {}) {
  const scope = context ? (normalized.context ?? "") : "";
  switch (normalized.type) {
    case "path":
      return `p\0${scope}\0${normalized.path}\0${hintSignature(normalized.hints)}`;
    case "name":
      return `n\0${scope}\0${normalized.name}`;
    case "kind":
      return `k\0${scope}\0${normalized.kind}`;
    default:
      return null;
  }
}

// The `data-name` a consumer gets when it passes no explicit override. Matches
// what tree-view, tabs and the fuzzy finders write by hand today, which is what
// `[data-name$=".md"]` selectors in packages and user stylesheets match on.
function defaultDataName(normalized) {
  if (normalized.type !== "path" || !normalized.path) return null;
  return path.basename(normalized.path);
}

module.exports = { normalizeTarget, cacheKeyFor, hintSignature, defaultDataName, HINT_KEYS };
