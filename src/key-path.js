// A key path is a dot-separated string addressing a nested property, where a
// literal dot inside a key is escaped as `\.`. That escaping is what lets a
// scoped setting name such as `editor.invisibles.cr` be told apart from a key
// that genuinely contains a dot, like a `core.customFileTypes` entry keyed by
// the scope name `source.js`.
//
// Inlined from the archived atom/key-path-helpers. `hasKeyPath` is left out:
// nothing here uses it.

const ESCAPED_DOT = /\\\./g;
const ANY_DOT = /\./g;

function splitKeyPath(keyPath) {
  if (keyPath == null) return [];

  let startIndex = 0;
  const keyPathArray = [];

  for (let i = 0, len = keyPath.length; i < len; i++) {
    if (keyPath[i] === "." && (i === 0 || keyPath[i - 1] !== "\\")) {
      keyPathArray.push(keyPath.substring(startIndex, i).replace(ESCAPED_DOT, "."));
      startIndex = i + 1;
    }
  }
  keyPathArray.push(keyPath.substring(startIndex).replace(ESCAPED_DOT, "."));

  return keyPathArray;
}

function getValueAtKeyPath(object, keyPath) {
  if (!keyPath) return object;

  for (const key of splitKeyPath(keyPath)) {
    object = object[key];
    if (object == null) {
      return object;
    }
  }
  return object;
}

function setValueAtKeyPath(object, keyPath, value) {
  const keys = splitKeyPath(keyPath);
  while (keys.length > 1) {
    const key = keys.shift();
    object[key] ??= {};
    object = object[key];
  }
  object[keys.shift()] = value;
}

function deleteValueAtKeyPath(object, keyPath) {
  const keys = splitKeyPath(keyPath);
  while (keys.length > 1) {
    const key = keys.shift();
    if (object[key] == null) return;
    object = object[key];
  }
  delete object[keys.shift()];
}

function pushKeyPath(keyPath, key) {
  key = key.replace(ANY_DOT, "\\.");
  return keyPath && keyPath.length > 0 ? `${keyPath}.${key}` : key;
}

module.exports = {
  splitKeyPath,
  getValueAtKeyPath,
  setValueAtKeyPath,
  deleteValueAtKeyPath,
  pushKeyPath,
};
