let ParsedColor = null;
const SIMPLE_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * @public
 * @status essential
 *
 * A simple color class returned from {@link Config#get} when the value
 * at the key path is of type 'color'.
 */
module.exports = class Color {
  /**
   * @public
   * @status essential
   *
   * Parse a `String` or `Object` into a {@link Color}.
   *
   * @param value - A `String` such as `'white'`, `#ff00ff`, or `'rgba(255, 15, 60, .75)'` or an `Object` with `red`, `green`, `blue`, and `alpha` properties.
   * @returns {Color} or `null` if it cannot be parsed.
   */
  static parse(value) {
    switch (typeof value) {
      case "string":
        break;
      case "object":
        if (Array.isArray(value)) {
          return null;
        }
        value = Object.values(value);
        break;
      default:
        return null;
    }

    // Most package schemas use hexadecimal or rgb() defaults. Parse those
    // forms locally so registering a large schema does not synchronously load
    // the full `color` dependency just to coerce its first default. Formats
    // outside this small CSS subset retain the existing parser below.
    if (typeof value === "string") {
      const channels = parseFastColor(value);
      if (channels !== undefined) {
        return new Color(...channels);
      }
    }

    if (!ParsedColor) {
      ParsedColor = require("color").default;
    }

    try {
      var parsedColor = ParsedColor(value);
    } catch {
      return null;
    }

    return new Color(
      parsedColor.red(),
      parsedColor.green(),
      parsedColor.blue(),
      parsedColor.alpha(),
    );
  }

  constructor(red, green, blue, alpha) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha;
  }

  set red(red) {
    this._red = parseColor(red);
  }

  set green(green) {
    this._green = parseColor(green);
  }

  set blue(blue) {
    this._blue = parseColor(blue);
  }

  set alpha(alpha) {
    this._alpha = parseAlpha(alpha);
  }

  get red() {
    return this._red;
  }

  get green() {
    return this._green;
  }

  get blue() {
    return this._blue;
  }

  get alpha() {
    return this._alpha;
  }

  /**
   * @public
   * @status essential
   *
   * @returns {String} in the form `'#abcdef'`.
   */
  toHexString() {
    return `#${numberToHexString(this.red)}${numberToHexString(
      this.green,
    )}${numberToHexString(this.blue)}`;
  }

  /**
   * @public
   * @status essential
   *
   * @returns {String} in the form `'rgba(25, 50, 75, .9)'`.
   */
  toRGBAString() {
    return `rgba(${this.red}, ${this.green}, ${this.blue}, ${this.alpha})`;
  }

  toJSON() {
    return this.alpha === 1 ? this.toHexString() : this.toRGBAString();
  }

  toString() {
    return this.toRGBAString();
  }

  isEqual(color) {
    if (this === color) {
      return true;
    }

    if (!(color instanceof Color)) {
      color = Color.parse(color);
    }

    if (color == null) {
      return false;
    }

    return (
      color.red === this.red &&
      color.blue === this.blue &&
      color.green === this.green &&
      color.alpha === this.alpha
    );
  }

  clone() {
    return new Color(this.red, this.green, this.blue, this.alpha);
  }
};

function parseColor(colorString) {
  const color = parseInt(colorString, 10);
  return isNaN(color) ? 0 : Math.min(Math.max(color, 0), 255);
}

function parseAlpha(alphaString) {
  const alpha = parseFloat(alphaString);
  return isNaN(alpha) ? 1 : Math.min(Math.max(alpha, 0), 1);
}

// Return `undefined` when the value is not one of the cheap forms handled
// here (or uses a syntax whose edge cases belong to the full parser). This
// lets callers preserve support for named colours, hsl(), and other CSS
// syntaxes without loading that parser for ordinary schema defaults.
function parseFastColor(value) {
  const hex = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const channels = [...digits].map((digit) => parseInt(`${digit}${digit}`, 16));
      return [channels[0], channels[1], channels[2], digits.length === 4 ? channels[3] / 255 : 1];
    }
    const channels = [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ];
    return [
      channels[0],
      channels[1],
      channels[2],
      digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    ];
  }

  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return undefined;

  const components = rgb[1].split(",").map((component) => component.trim());
  // Leave modern space-separated `rgb(1 2 3 / .5)` syntax to the full
  // parser. The comma form is the only one this fast path claims.
  if (components.length !== (value.toLowerCase().startsWith("rgba(") ? 4 : 3)) {
    return undefined;
  }

  // Percentage channels have subtle rounding rules in the full CSS parser;
  // leave them there rather than risk changing a user's configured color.
  const channels = components.slice(0, 3).map((component) => {
    if (component.endsWith("%")) return NaN;
    return SIMPLE_NUMBER.test(component) ? Number.parseFloat(component) : NaN;
  });
  const alphaComponent = components[3];
  if (alphaComponent?.endsWith("%")) return undefined;
  const alpha =
    components.length === 4 && SIMPLE_NUMBER.test(alphaComponent)
      ? Number.parseFloat(alphaComponent)
      : components.length === 4
        ? NaN
        : 1;
  if (channels.some((channel) => !Number.isFinite(channel)) || !Number.isFinite(alpha)) {
    return undefined;
  }

  return [
    Math.min(Math.max(channels[0], 0), 255),
    Math.min(Math.max(channels[1], 0), 255),
    Math.min(Math.max(channels[2], 0), 255),
    Math.min(Math.max(alpha, 0), 1),
  ];
}

function numberToHexString(number) {
  const hex = number.toString(16);
  return number < 16 ? `0${hex}` : hex;
}
