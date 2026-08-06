const { Icon } = require("./icon-descriptor");

// The two closed icon vocabularies: semantic names and kinds.
//
// A *name* is what a pane item returns from `getIconName()` and what
// `atom.notifications.add*({icon})` takes — a bare octicon name the consumer
// used to prefix with `icon-` by hand.
//
// A *kind* is an LSP SymbolKind or something like one. Its table is the one
// that used to be duplicated between the symbol and symbol-tree-sitter packages;
// a kind with no entry falls back to a single-letter badge so an unrecognized
// symbol still reads as something.

// Deliberately not a hard-coded list of the 242 octicon names: that would
// duplicate the generated `static/icons/octicons.css` and rot against it. Any
// name resolves, and a typo shows as a missing glyph rather than an error.
function resolveName(name, overrides) {
  const override = overrides.get(name);
  if (override !== undefined) return override === null ? Icon.none() : Icon.classes(override);
  return Icon.classes([`icon-${name}`]);
}

// A `null` value means "this kind deliberately has no icon" — distinct from a
// kind that is simply absent, which gets the letter badge.
const DEFAULT_KINDS = new Map([
  // LSP SymbolKind, per the exhaustive list in the specification.
  ["file", "icon-file"],
  ["module", "icon-database"],
  ["namespace", "icon-tag"],
  ["package", "icon-package"],
  ["class", "icon-puzzle"],
  ["method", "icon-gear"],
  ["property", "icon-primitive-dot"],
  ["field", "icon-primitive-dot"],
  ["constructor", "icon-tools"],
  ["enum", "icon-list-unordered"],
  ["interface", "icon-key"],
  ["function", "icon-gear"],
  ["variable", "icon-code"],
  ["constant", "icon-primitive-square"],
  ["string", "icon-quote"],
  ["number", "icon-plus"],
  ["boolean", "icon-question"],
  ["array", "icon-list-ordered"],
  ["object", "icon-file-code"],
  ["key", "icon-key"],
  ["null", null],
  ["enum-member", "icon-primitive-dot"],
  ["struct", "icon-book"],
  ["event", "icon-calendar"],
  ["operator", "icon-plus"],
  ["type-parameter", null],
  // Kinds that are not LSP symbol kinds but that a list of code entities can
  // still be asked about. Autocomplete keeps its own small table: there the
  // type string doubles as the colour token, so the class has to stay whatever
  // the syntax theme keys on.
  ["snippet", "icon-move-right"],
  ["import", "icon-package"],
  ["require", "icon-package"],
  ["tag", "icon-code"],
  ["attribute", "icon-tag"],
]);

function resolveKind(kind, overrides) {
  const override = overrides.get(kind);
  if (override !== undefined) return override === null ? Icon.none() : Icon.classes(override);

  const known = DEFAULT_KINDS.get(kind);
  if (known === null) return Icon.none();
  if (known !== undefined) return Icon.classes(known);

  return Icon.letter(kind);
}

function createNameProvider(overrides) {
  return {
    id: "core-name",
    handles: ["name"],
    usesContext: false,
    iconFor(target) {
      if (typeof target.name !== "string" || target.name.length === 0) return null;
      return resolveName(target.name, overrides);
    },
  };
}

function createKindProvider(overrides) {
  return {
    id: "core-kind",
    handles: ["kind"],
    usesContext: false,
    iconFor(target) {
      if (typeof target.kind !== "string" || target.kind.length === 0) return null;
      return resolveKind(target.kind, overrides);
    },
  };
}

module.exports = { DEFAULT_KINDS, createNameProvider, createKindProvider };
