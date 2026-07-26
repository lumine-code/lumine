// Maps LSP semantic-token legends onto the conventional syntax--* compound
// classes emitted by the grammar layer (classNameForScopeId turns a scope like
// entity.name.function into "syntax--entity syntax--name syntax--function"),
// so existing themes color semantic tokens without knowing about them.

// The LSP 3.17 standard token types, each resolved to the scope existing
// grammars would assign the same construct.
const TYPE_CLASSES = {
  namespace: "syntax--entity syntax--name syntax--namespace",
  type: "syntax--entity syntax--name syntax--type",
  class: "syntax--entity syntax--name syntax--type syntax--class",
  enum: "syntax--entity syntax--name syntax--type syntax--enum",
  interface: "syntax--entity syntax--name syntax--type syntax--interface",
  struct: "syntax--entity syntax--name syntax--type syntax--struct",
  typeParameter: "syntax--entity syntax--name syntax--type syntax--parameter",
  parameter: "syntax--variable syntax--parameter",
  variable: "syntax--variable",
  property: "syntax--variable syntax--other syntax--property",
  enumMember: "syntax--constant syntax--other syntax--enum",
  event: "syntax--variable syntax--other syntax--event",
  function: "syntax--entity syntax--name syntax--function",
  method: "syntax--entity syntax--name syntax--function syntax--method",
  macro: "syntax--entity syntax--name syntax--function syntax--macro",
  keyword: "syntax--keyword",
  modifier: "syntax--storage syntax--modifier",
  comment: "syntax--comment",
  string: "syntax--string",
  number: "syntax--constant syntax--numeric",
  regexp: "syntax--string syntax--regexp",
  operator: "syntax--keyword syntax--operator",
  decorator: "syntax--entity syntax--name syntax--decorator",
};

// Modifiers only contribute a class where a conventional mapping exists;
// everything else (declaration, static, async, ...) is ignored.
const MODIFIER_CLASSES = {
  deprecated: "ide-client-strike",
  // Standard-library names are what the support.* scopes mark in grammars.
  defaultLibrary: "syntax--support",
};

const BASE_CLASS = "ide-client-semantic-token";
const BASE_PROPERTIES = Object.freeze({ type: "text", class: BASE_CLASS });

exports.STANDARD_TOKEN_TYPES = Object.keys(TYPE_CLASSES);
exports.STANDARD_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];

// Builds a resolver for one server legend. propertiesFor returns a memoized
// LayerDecoration override — overrides replace the base properties entirely,
// so every result carries type:"text" and the base class itself. Reusing the
// same object per (type, modifier-bitset) keeps decoration comparisons cheap.
exports.createScopeMap = (legend) => {
  const typeClasses = (legend?.tokenTypes || []).map((name) => TYPE_CLASSES[name] || null);
  const modifierClasses = (legend?.tokenModifiers || []).map(
    (name) => MODIFIER_CLASSES[name] || null,
  );
  const memo = new Map();
  return {
    propertiesFor(typeIndex, modifierBits = 0) {
      const key = `${typeIndex}:${modifierBits}`;
      let properties = memo.get(key);
      if (properties) return properties;
      let className = BASE_CLASS;
      if (typeClasses[typeIndex]) className += ` ${typeClasses[typeIndex]}`;
      for (let bit = 0; bit < modifierClasses.length; bit++)
        if (modifierBits & (1 << bit) && modifierClasses[bit])
          className += ` ${modifierClasses[bit]}`;
      properties = className === BASE_CLASS ? BASE_PROPERTIES : { type: "text", class: className };
      memo.set(key, properties);
      return properties;
    },
  };
};
