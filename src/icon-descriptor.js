// The value every icon provider returns and every consumer renders. One frozen
// record discriminated by `render`, so descriptors are safe to cache, share
// between elements, and compare by identity — `applyTo` relies on that identity
// check to skip DOM writes when an icon has not actually changed.

const EMPTY_CLASSES = Object.freeze([]);
const DESCRIPTOR = Symbol("IconDescriptor");

function freezeClasses(value) {
  if (value == null) return EMPTY_CLASSES;
  const list = Array.isArray(value) ? value : String(value).split(/\s+/g);
  const filtered = list.filter((name) => typeof name === "string" && name.length > 0);
  return filtered.length > 0 ? Object.freeze(filtered) : EMPTY_CLASSES;
}

// The class each non-glyph variant needs for the core stylesheet to render it.
// Applied in `create` rather than in each factory so every descriptor variant
// receives the same structural treatment.
const STRUCTURAL_CLASSES = { image: "icon-image", svg: "icon-svg", letter: "icon-letter" };

function withStructuralClass(render, classes) {
  const structural = STRUCTURAL_CLASSES[render];
  if (!structural || classes.includes(structural)) return classes;
  return Object.freeze([structural, ...classes]);
}

function create(fields) {
  return Object.freeze({
    [DESCRIPTOR]: true,
    render: fields.render,
    classes: withStructuralClass(fields.render, freezeClasses(fields.classes)),
    source: fields.source ?? null,
    svg: fields.svg ?? null,
    viewBox: fields.viewBox ?? null,
    letter: fields.letter ?? null,
    color: fields.color ?? null,
    title: fields.title ?? null,
    providerId: fields.providerId ?? null,
  });
}

const NONE = create({ render: "none" });

const Icon = {
  // A glyph font icon: the classes are applied to the element as-is. The
  // provider owns whatever CSS makes them render.
  classes(value, { color = null, title = null } = {}) {
    const classes = freezeClasses(value);
    if (classes.length === 0) return NONE;
    return create({ render: "classes", classes, color, title });
  },

  // A raster or vector icon addressed by URL — a `data:` URL from the OS, or a
  // `file:` URL from an icon theme. Painted into `::before` by the core
  // `.icon-image` rule so it keeps the 16px box and margin every list layout
  // assumes.
  image(source, { title = null } = {}) {
    if (!source) return NONE;
    return create({ render: "image", source: String(source), title });
  },

  // Inline SVG markup, rendered into a child element. The markup is provider
  // owned and is NOT sanitized — the same trust level packages already have.
  svg(markup, { viewBox = null, color = null, title = null } = {}) {
    if (!markup) return NONE;
    return create({
      render: "svg",
      svg: String(markup),
      viewBox,
      color,
      title,
    });
  },

  // A single character badge. The fallback for a kind no vocabulary entry
  // covers, so an unknown symbol or completion type still reads as something.
  letter(character, { color = null, title = null } = {}) {
    const text = character == null ? "" : Array.from(String(character))[0];
    if (!text) return NONE;
    return create({ render: "letter", letter: text, color, title });
  },

  // "The answer is: no icon." Distinct from a provider returning `null`, which
  // means "not mine, ask the next provider" — this one stops the chain.
  none() {
    return NONE;
  },

  isDescriptor(value) {
    return value != null && typeof value === "object" && value[DESCRIPTOR] === true;
  },

  // Two descriptors that would render identically. Cached descriptors compare
  // by identity, but re-resolving after an invalidation produces a fresh
  // object — comparing by value is what lets `applyTo` skip the DOM write when
  // the answer did not actually change.
  equal(left, right) {
    if (left === right) return true;
    if (left == null || right == null) return false;
    if (
      left.render !== right.render ||
      left.source !== right.source ||
      left.svg !== right.svg ||
      left.viewBox !== right.viewBox ||
      left.letter !== right.letter ||
      left.color !== right.color ||
      left.title !== right.title ||
      left.classes.length !== right.classes.length
    ) {
      return false;
    }
    return left.classes.every((name, index) => name === right.classes[index]);
  },

  // Rebuild a provider's descriptor rather than passing it through, so it gains
  // the structural class its variant needs and records which provider answered.
  // Providers deliberately have one return shape: use `Icon.classes()` instead
  // of returning a bare class string or array.
  coerce(value, { providerId = null } = {}) {
    if (value == null) return null;
    if (!Icon.isDescriptor(value)) {
      throw new TypeError("Icon providers must return an Icon descriptor or null");
    }
    return create({ ...value, providerId: providerId ?? value.providerId ?? null });
  },
};

module.exports = { Icon, NONE };
