const _ = require("@lumine-code/underscore-plus");

// Resolve static keymap precedence without dispatching or changing a pending
// keyboard sequence. A handler can still abort its binding at runtime; a hint
// cannot predict that decision. An unset rule skips its element's bindings,
// while native and abort rules block the keystroke through the ancestor chain.
function keyBindingsForTarget(keymapManager, target) {
  if (!keymapManager || typeof target?.webkitMatchesSelector !== "function") return [];
  const candidates = keymapManager.findKeyBindings({ target });
  const resolved = new Map();
  const document = target.ownerDocument ?? globalThis.document;
  for (let element = target; element && element !== document; element = element.parentElement) {
    const matching = candidates
      .filter((binding) => element.webkitMatchesSelector?.(binding.selector))
      .sort((left, right) => left.compare(right));
    const seenHere = new Set();
    for (const binding of matching) {
      if (resolved.has(binding.keystrokes) || seenHere.has(binding.keystrokes)) continue;
      seenHere.add(binding.keystrokes);
      if (binding.command !== "unset!") resolved.set(binding.keystrokes, binding);
    }
  }

  return [...resolved.values()].filter((binding) => {
    if (binding.command === "native!" || binding.command === "abort!") return false;
    // A native prefix prevents the keymap from entering a longer chord.
    const strokes = binding.keystrokes.split(" ");
    for (let length = 1; length < strokes.length; length++) {
      if (resolved.get(strokes.slice(0, length).join(" "))?.command === "native!") return false;
    }
    return true;
  });
}

// Unscoped tooltip callers retain their catalogue lookup. Targeted hints use
// the same static resolution as menu preparation, including user overrides.
function keyBindingLabelForCommand(keymapManager, command, target, bindingsByTarget) {
  let bindings;
  if (target !== undefined) {
    bindings = bindingsByTarget?.get(target);
    if (!bindings) {
      bindings = keyBindingsForTarget(keymapManager, target);
      bindingsByTarget?.set(target, bindings);
    }
  }
  const binding =
    target === undefined
      ? keymapManager?.findKeyBindings({ command, target })?.[0]
      : bindings.find((binding) => binding.command === command);
  return binding?.keystrokes ? _.humanizeKeystroke(binding.keystrokes) : undefined;
}

function resolveKeyBindingTarget(option, invokingElement, fallback) {
  if (option === undefined) return fallback;
  return typeof option === "function" ? option.call(invokingElement, invokingElement) : option;
}

module.exports = { keyBindingsForTarget, keyBindingLabelForCommand, resolveKeyBindingTarget };
