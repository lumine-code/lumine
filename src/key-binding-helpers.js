const _ = require("@lumine-code/underscore-plus");

// KeymapManager orders applicable bindings by precedence. Tooltip and menu
// hints must show the same winning binding, including user overrides.
function keyBindingLabelForCommand(keymapManager, command, target) {
  const binding = keymapManager?.findKeyBindings({ command, target })?.[0];
  return binding?.keystrokes ? _.humanizeKeystroke(binding.keystrokes) : undefined;
}

module.exports = { keyBindingLabelForCommand };
