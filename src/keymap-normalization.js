// Keystroke syntax is independent of the native keyboard layout. Keep this
// module usable by workspace checks as well as the renderer's keymap helpers.
const MODIFIERS = new Set(["ctrl", "alt", "shift", "cmd"]);
const WHITESPACE_REGEX = /\s+/;
const isKeyup = (keystroke) => keystroke.startsWith("^") && keystroke !== "^";

function normalizeKeystrokes(keystrokes, platform = process.platform) {
  const normalizedKeystrokes = [];
  for (const keystroke of keystrokes.split(WHITESPACE_REGEX)) {
    const normalizedKeystroke = normalizeKeystroke(keystroke, platform);
    if (!normalizedKeystroke) return false;
    normalizedKeystrokes.push(normalizedKeystroke);
  }
  return normalizedKeystrokes.join(" ");
}

function normalizeKeystroke(keystroke, platform = process.platform) {
  const keyup = isKeyup(keystroke);
  if (keyup) keystroke = keystroke.slice(1);
  const keys = parseKeystroke(keystroke);
  if (!keys) return false;

  let primaryKey = null;
  const modifiers = new Set();
  for (let index = 0; index < keys.length; index++) {
    let key = keys[index].toLowerCase();
    if (key === "cmdorctrl") key = platform === "darwin" ? "cmd" : "ctrl";
    if (MODIFIERS.has(key)) {
      modifiers.add(key);
    } else if (index === keys.length - 1) {
      primaryKey = key;
    } else {
      return false;
    }
  }

  const normalized = [];
  if (!keyup || primaryKey == null) {
    for (const modifier of MODIFIERS) {
      if (modifiers.has(modifier)) normalized.push(modifier);
    }
  }
  if (primaryKey != null) normalized.push(primaryKey);
  return `${keyup ? "^" : ""}${normalized.join("-")}`;
}

function parseKeystroke(keystroke) {
  const keys = [];
  let keyStart = 0;
  for (let index = 0; index < keystroke.length; index++) {
    if (keystroke[index] === "-" && index > keyStart) {
      keys.push(keystroke.substring(keyStart, index));
      keyStart = index + 1;
      // A trailing separator is invalid, but `ctrl--` names the minus key.
      if (keyStart === keystroke.length) return false;
    }
  }
  if (keyStart < keystroke.length) keys.push(keystroke.substring(keyStart));
  return keys;
}

module.exports = { normalizeKeystroke, normalizeKeystrokes, MODIFIERS, isKeyup };
