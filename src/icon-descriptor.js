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

/**
 * @public
 * @status public
 *
 * Factories and helpers for the frozen icon descriptors consumed by
 * {@link IconRegistry}. Available as `require('lumine').Icon`.
 *
 * A descriptor contains a `render` discriminator (`classes`, `image`, `svg`,
 * `letter` or `none`), a frozen `classes` array, and nullable `source`, `svg`,
 * `viewBox`, `letter`, `color`, `title` and `providerId` fields. Always use these
 * factories: a plain object with the same fields is not a descriptor.
 *
 * Providers return a descriptor when they claim an icon, {@link .none} when
 * they intentionally suppress one, and `null` to let the next provider answer.
 *
 * @memberof require('lumine')
 */
const Icon = {
  /**
   * @public
   * @status public
   *
   * Create a glyph-font icon. The provider supplies the CSS for the given
   * classes; the editor applies them unchanged.
   *
   * @param {String|Array<String>} value - A whitespace-separated class string or
   *   an array of class names. Empty input returns {@link .none}.
   * @param {Object} [options] - Presentation options.
   * @param {String|null} [options.color=null] - The glyph color.
   * @param {String|null} [options.title=null] - The tooltip title.
   * @returns {Object} A frozen icon descriptor.
   */
  classes(value, { color = null, title = null } = {}) {
    const classes = freezeClasses(value);
    if (classes.length === 0) return NONE;
    return create({ render: "classes", classes, color, title });
  },

  /**
   * @public
   * @status public
   *
   * Create an image icon addressed by URL, such as a `data:` URL from the OS
   * or a `file:` URL from an icon theme. The editor paints it in its icon box.
   *
   * @param {String} source - The image URL. Empty input returns {@link .none}.
   * @param {Object} [options] - Presentation options.
   * @param {String|null} [options.title=null] - The tooltip title.
   * @returns {Object} A frozen icon descriptor.
   */
  image(source, { title = null } = {}) {
    if (!source) return NONE;
    return create({ render: "image", source: String(source), title });
  },

  /**
   * @public
   * @status public
   *
   * Create an inline SVG icon rendered into a child element. Markup is supplied
   * by the provider and is not sanitized.
   *
   * @param {String} markup - SVG markup. Empty input returns {@link .none}.
   * @param {Object} [options] - Presentation options.
   * @param {String|null} [options.viewBox=null] - The SVG view box.
   * @param {String|null} [options.color=null] - The icon color.
   * @param {String|null} [options.title=null] - The tooltip title.
   * @returns {Object} A frozen icon descriptor.
   */
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

  /**
   * @public
   * @status public
   *
   * Create a badge from the first Unicode code point of a string.
   *
   * @param {String} character - Badge text. Empty input returns {@link .none}.
   * @param {Object} [options] - Presentation options.
   * @param {String|null} [options.color=null] - The badge color.
   * @param {String|null} [options.title=null] - The tooltip title.
   * @returns {Object} A frozen icon descriptor.
   */
  letter(character, { color = null, title = null } = {}) {
    const text = character == null ? "" : Array.from(String(character))[0];
    if (!text) return NONE;
    return create({ render: "letter", letter: text, color, title });
  },

  /**
   * @public
   * @status public
   *
   * Explicitly suppress an icon. This stops provider resolution; returning
   * `null` instead lets the next provider answer.
   *
   * @returns {Object} The shared frozen descriptor with `render: 'none'`.
   */
  none() {
    return NONE;
  },

  /**
   * @public
   * @status public
   *
   * Test whether a value was created by these descriptor factories.
   *
   * @param {*} value - The value to inspect.
   * @returns {Boolean} Whether the value is an icon descriptor.
   */
  isDescriptor(value) {
    return value != null && typeof value === "object" && value[DESCRIPTOR] === true;
  },

  /**
   * @public
   * @status public
   *
   * Compare descriptors by their rendered fields. Provider identity is ignored;
   * two identical absent values also compare equal.
   *
   * @param {Object|null|undefined} left - An icon descriptor or an absent value.
   * @param {Object|null|undefined} right - An icon descriptor or an absent value.
   * @returns {Boolean} Whether the descriptors would render identically.
   */
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

  /**
   * @public
   * @status public
   *
   * Rebuild a provider's descriptor with its structural classes and provider
   * identity. Throws a `TypeError` for values that are not descriptors.
   *
   * @param {Object|null|undefined} value - An icon descriptor, or an absent value
   *   that passes through as `null`.
   * @param {Object} [options] - Provider metadata.
   * @param {String|null} [options.providerId=null] - The provider identity. A
   *   non-null value overrides the descriptor's existing identity.
   * @returns {Object|null} A rebuilt frozen descriptor, or `null`.
   */
  coerce(value, { providerId = null } = {}) {
    if (value == null) return null;
    if (!Icon.isDescriptor(value)) {
      throw new TypeError("Icon providers must return an Icon descriptor or null");
    }
    return create({ ...value, providerId: providerId ?? value.providerId ?? null });
  },
};

module.exports = { Icon, NONE };
