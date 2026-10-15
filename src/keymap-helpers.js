/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS103: Rewrite code to no longer use __guard__, or convert again using --optional-chaining
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/main/docs/suggestions.md
 */
const {
  normalizeKeystroke,
  normalizeKeystrokes,
  MODIFIERS,
  isKeyup,
} = require("./keymap-normalization");
const { calculateSpecificity } = require("./css-selectors");
const KeyboardLayout = require("@lumine-code/keyboard-layout");

const ENDS_IN_MODIFIER_REGEX = /(ctrl|alt|shift|cmd)$/;
const KEY_NAMES_BY_KEYBOARD_EVENT_CODE = {
  Space: "space",
  Backspace: "backspace",
  Backquote: "backquote",
};
const NON_CHARACTER_KEY_NAMES_BY_KEYBOARD_EVENT_KEY = {
  Control: "ctrl",
  Meta: "cmd",
  ArrowDown: "down",
  ArrowUp: "up",
  ArrowLeft: "left",
  ArrowRight: "right",
};
const NUMPAD_KEY_NAMES_BY_KEYBOARD_EVENT_CODE = {
  Numpad0: "numpad0",
  Numpad1: "numpad1",
  Numpad2: "numpad2",
  Numpad3: "numpad3",
  Numpad4: "numpad4",
  Numpad5: "numpad5",
  Numpad6: "numpad6",
  Numpad7: "numpad7",
  Numpad8: "numpad8",
  Numpad9: "numpad9",
};

const LATIN_KEYMAP_CACHE = new WeakMap();
const isLatinKeymap = function (keymap) {
  if (keymap == null) {
    return true;
  }

  let isLatin = LATIN_KEYMAP_CACHE.get(keymap);
  if (isLatin != null) {
    return isLatin;
  } else {
    // To avoid exceptions, if the native keymap does not have entries for a key,
    // assume that key is latin.
    isLatin =
      (keymap.KeyA == null || isLatinCharacter(keymap.KeyA.unmodified)) &&
      (keymap.KeyS == null || isLatinCharacter(keymap.KeyS.unmodified)) &&
      (keymap.KeyD == null || isLatinCharacter(keymap.KeyD.unmodified)) &&
      (keymap.KeyF == null || isLatinCharacter(keymap.KeyF.unmodified));
    LATIN_KEYMAP_CACHE.set(keymap, isLatin);
    return isLatin;
  }
};

const isASCIICharacter = (character) =>
  character != null && character.length === 1 && character.charCodeAt(0) <= 127;

var isLatinCharacter = (character) =>
  character != null && character.length === 1 && character.charCodeAt(0) <= 0x024f;

const isUpperCaseCharacter = (character) =>
  character != null && character.length === 1 && character.toLowerCase() !== character;

const isLowerCaseCharacter = (character) =>
  character != null && character.length === 1 && character.toUpperCase() !== character;

let usKeymap = null;
const usCharactersForKeyCode = function (code) {
  if (usKeymap == null) {
    usKeymap = require("./us-keymap");
  }
  return usKeymap[code];
};

let slovakCmdKeymap = null;
let slovakQwertyCmdKeymap = null;
const slovakCmdCharactersForKeyCode = function (code, layout) {
  if (slovakCmdKeymap == null) {
    slovakCmdKeymap = require("./slovak-cmd-keymap");
  }
  if (slovakQwertyCmdKeymap == null) {
    slovakQwertyCmdKeymap = require("./slovak-qwerty-cmd-keymap");
  }

  if (layout === "com.apple.keylayout.Slovak") {
    return slovakCmdKeymap[code];
  } else {
    return slovakQwertyCmdKeymap[code];
  }
};

exports.normalizeKeystrokes = normalizeKeystrokes;

exports.keystrokeForKeyboardEvent = function (event, customKeystrokeResolvers) {
  let characters;
  let { key, code, ctrlKey, altKey, shiftKey, metaKey } = event;

  const currentLayout = KeyboardLayout.getCurrentKeyboardLayout();

  if (key === "Dead") {
    if (
      process.platform === "darwin" &&
      (characters = __guard__(KeyboardLayout.getCurrentKeymap(), (x) => x[event.code]))
    ) {
      if (altKey && shiftKey && characters.withAltGraphShift != null) {
        key = characters.withAltGraphShift;
      } else if (altKey && characters.withAltGraph != null) {
        key = characters.withAltGraph;
      } else if (shiftKey && characters.withShift != null) {
        key = characters.withShift;
      } else if (characters.unmodified != null) {
        key = characters.unmodified;
      }
    }
  }

  if (NUMPAD_KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code] != null && event.getModifierState("NumLock")) {
    key = NUMPAD_KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code];
  }

  if (KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code] != null) {
    key = KEY_NAMES_BY_KEYBOARD_EVENT_CODE[code];
  }

  // Work around Chrome bugs on Linux
  if (process.platform === "linux") {
    // Fix NumpadDecimal key value being '' with NumLock disabled.
    if (code === "NumpadDecimal" && !event.getModifierState("NumLock")) {
      key = "delete";
    }
    // Fix 'Unidentified' key value for '/' key on Brazillian keyboards
    if (code === "IntlRo" && key === "Unidentified" && ctrlKey) {
      key = "/";
    }
  }

  let isAltModifiedKey = false;
  const isNonCharacterKey = key.length > 1;
  if (isNonCharacterKey) {
    key =
      NON_CHARACTER_KEY_NAMES_BY_KEYBOARD_EVENT_KEY[key] != null
        ? NON_CHARACTER_KEY_NAMES_BY_KEYBOARD_EVENT_KEY[key]
        : key.toLowerCase();
    if (key === "altgraph" && process.platform === "win32") {
      key = "alt";
    }
  } else {
    // Deal with caps-lock issues. Whether a binding includes `shift` must follow
    // the shiftKey state and never the state of the caps-lock key. The primary
    // key itself is lowercased before the keystroke is returned.
    if (shiftKey) {
      key = key.toUpperCase();
    } else {
      key = key.toLowerCase();
    }

    if (event.getModifierState("AltGraph") || (process.platform === "darwin" && altKey)) {
      // All macOS layouts have an alt-modified character variant for every
      // single key. Therefore, if we always favored the alt variant, it would
      // become impossible to bind `alt-*` to anything. Since `alt-*` bindings
      // are rare and we bind very few by default on macOS, we will only shadow
      // an `alt-*` binding with an alt-modified character variant if it is a
      // basic ASCII character.
      let nonAltModifiedKey;
      if (process.platform === "darwin" && event.code) {
        nonAltModifiedKey = nonAltModifiedKeyForKeyboardEvent(event);
        if (nonAltModifiedKey && (ctrlKey || metaKey || !isASCIICharacter(key))) {
          key = nonAltModifiedKey;
        } else if (key !== nonAltModifiedKey) {
          altKey = false;
          isAltModifiedKey = true;
        }
        // Windows layouts are more sparing in their use of AltGr-modified
        // characters, and the U.S. layout doesn't have any of them at all. That
        // means that if an AltGr variant character exists for the current
        // keystroke, it likely to be the intended character, and we always
        // interpret it as such rather than favoring a `ctrl-alt-*` binding
        // interpretation, including non-ASCII letters such as Polish ż.
      } else if (process.platform === "win32" && event.code) {
        nonAltModifiedKey = nonAltModifiedKeyForKeyboardEvent(event);
        if (nonAltModifiedKey && metaKey) {
          key = nonAltModifiedKey;
        } else if (isWindowsAltGraphCharacter(event)) {
          ctrlKey = false;
          altKey = false;
          isAltModifiedKey = true;
        }
        // Linux has a dedicated `AltGraph` key that is distinct from all other
        // modifiers, including LeftAlt. However, if AltGraph is used in
        // combination with other modifiers, we want to treat it as a modifier and
        // fall back to the non-alt-modified character.
      } else if (process.platform === "linux") {
        nonAltModifiedKey = nonAltModifiedKeyForKeyboardEvent(event);
        if (nonAltModifiedKey && (ctrlKey || altKey || metaKey)) {
          key = nonAltModifiedKey;
          altKey = event.getModifierState("AltGraph");
          isAltModifiedKey = !altKey;
        }
      }
    }
  }

  // Ensure that shifted writing system characters are reported correctly
  if (event.code && key.length === 1) {
    characters =
      // TODO: Remove the com.apple.keylayout.DVORAK-QWERTYCMD
      // case when we are using an Electron version based on Chromium M62
      // That issue was fixed in https://bugs.chromium.org/p/chromium/issues/detail?id=747358
      // Use US equivalent character for non-latin characters in keystrokes with modifiers
      // or when using the dvorak-qwertycmd layout and holding down the command key.
      // if (key.length is 1 and not isLatinKeymap(KeyboardLayout.getCurrentKeymap())) or
      (() => {
        if (
          (!isAltModifiedKey && !isLatinKeymap(KeyboardLayout.getCurrentKeymap())) ||
          (metaKey && currentLayout.indexOf("DVORAK-QWERTYCMD") > -1)
        ) {
          return usCharactersForKeyCode(event.code);
          // As of Chromium ~62, KeyboardEvent.key is now sent in its un-shifted
          // for writing system characters (`8` vs `*`) so we need to manually
          // fetch the shifted version to maintain our former keystroke output
        } else if (!isAltModifiedKey) {
          return __guard__(KeyboardLayout.getCurrentKeymap(), (x1) => x1[event.code]);
        }
      })();

    if (characters) {
      if (event.shiftKey) {
        key = characters.withShift;
      } else if (characters.unmodified != null) {
        key = characters.unmodified;
      }
    }
  }

  // Work around https://bugs.chromium.org/p/chromium/issues/detail?id=766800
  // TODO: Remove this workaround when we are using an Electron version based on chrome M62
  if (
    (metaKey && currentLayout === "com.apple.keylayout.Slovak") ||
    currentLayout === "com.apple.keylayout.Slovak-QWERTY"
  ) {
    if ((characters = slovakCmdCharactersForKeyCode(event.code, currentLayout))) {
      if (event.shiftKey) {
        key = characters.withShift;
      } else {
        key = characters.unmodified;
      }
    }
  }

  const isShiftModifiedLetter =
    isLatinCharacter(key) && (isUpperCaseCharacter(key) || isLowerCaseCharacter(key));
  key = key.toLowerCase();

  let keystroke = "";
  if (key === "ctrl" || (ctrlKey && event.type !== "keyup")) {
    keystroke += "ctrl";
  }

  if (key === "alt" || (altKey && event.type !== "keyup")) {
    if (keystroke.length > 0) {
      keystroke += "-";
    }
    keystroke += "alt";
  }

  if (
    key === "shift" ||
    (shiftKey && event.type !== "keyup" && (isNonCharacterKey || isShiftModifiedLetter))
  ) {
    if (keystroke) {
      keystroke += "-";
    }
    keystroke += "shift";
  }

  if (key === "cmd" || (metaKey && event.type !== "keyup")) {
    if (keystroke) {
      keystroke += "-";
    }
    keystroke += "cmd";
  }

  if (!MODIFIERS.has(key)) {
    if (keystroke) {
      keystroke += "-";
    }
    keystroke += key;
  }

  if (event.type === "keyup") {
    keystroke = normalizeKeystroke(`^${keystroke}`);
  }

  if (customKeystrokeResolvers != null) {
    for (var resolver of Array.from(customKeystrokeResolvers)) {
      var customKeystroke = resolver({
        keystroke,
        event,
        layoutName: KeyboardLayout.getCurrentKeyboardLayout(),
        keymap: KeyboardLayout.getCurrentKeymap(),
      });
      if (customKeystroke) {
        keystroke = normalizeKeystroke(customKeystroke);
      }
    }
  }

  return keystroke;
};

var nonAltModifiedKeyForKeyboardEvent = function (event) {
  let characters;
  if (
    event.code &&
    (characters = __guard__(KeyboardLayout.getCurrentKeymap(), (x) => x[event.code]))
  ) {
    if (event.shiftKey) {
      return characters.withShift;
    } else {
      return characters.unmodified;
    }
  }
};

function isWindowsAltGraphCharacter(event) {
  if (
    process.platform !== "win32" ||
    !event.code ||
    event.key.length !== 1 ||
    event.metaKey ||
    !event.getModifierState("AltGraph")
  ) {
    return false;
  }
  const key = event.shiftKey ? event.key.toUpperCase() : event.key.toLowerCase();
  return key !== nonAltModifiedKeyForKeyboardEvent(event);
}

exports.MODIFIERS = MODIFIERS;

exports.characterForKeyboardEvent = function (event) {
  if (
    event.key.length === 1 &&
    (!(event.ctrlKey || event.metaKey) || isWindowsAltGraphCharacter(event))
  ) {
    return event.key;
  }
};

exports.calculateSpecificity = calculateSpecificity;

exports.isBareModifier = (keystroke) => ENDS_IN_MODIFIER_REGEX.test(keystroke);

exports.isModifierKeyup = (keystroke) =>
  isKeyup(keystroke) && ENDS_IN_MODIFIER_REGEX.test(keystroke);

exports.isKeyup = isKeyup;

exports.keydownEvent = (key, options) => buildKeyboardEvent(key, "keydown", options);

exports.keyupEvent = (key, options) => buildKeyboardEvent(key, "keyup", options);

exports.getModifierKeys = function (keystroke) {
  const keys = keystroke.split("-");
  const mod_keys = [];
  for (var key of Array.from(keys)) {
    if (MODIFIERS.has(key)) {
      mod_keys.push(key);
    }
  }
  return mod_keys;
};

var buildKeyboardEvent = function (key, eventType, param) {
  if (param == null) {
    param = {};
  }
  const { ctrl, shift, alt, cmd, target } = param;
  const ctrlKey = ctrl != null ? ctrl : false;
  const altKey = alt != null ? alt : false;
  const shiftKey = shift != null ? shift : false;
  const metaKey = cmd != null ? cmd : false;
  const bubbles = true;
  const cancelable = true;

  const event = new KeyboardEvent(eventType, {
    key,
    ctrlKey,
    altKey,
    shiftKey,
    metaKey,
    bubbles,
    cancelable,
  });

  if (target != null) {
    Object.defineProperty(event, "target", {
      get() {
        return target;
      },
    });
    Object.defineProperty(event, "path", {
      get() {
        return [target];
      },
    });
  }
  return event;
};

function __guard__(value, transform) {
  return typeof value !== "undefined" && value !== null ? transform(value) : undefined;
}
