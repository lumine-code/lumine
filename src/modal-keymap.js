"use strict";

const { Disposable } = require("event-kit");

// Registers the default keystrokes an Action declares, scoped to the view that
// declared them.
//
// Priority matters more than it looks: `KeyBinding.compare` orders by priority
// FIRST and only then by selector specificity. Registering at 50 puts these
// above package keymaps (0) — so a modal's own verb beats some other package's
// stray `atom-text-editor` binding — while staying below the user keymap (100),
// so a user override still wins.

function selectorFor(viewId) {
  return `atom-modal[data-modal-view="${viewId}"]`;
}

function keystrokeFor(action) {
  const keystroke = action.keystroke;
  if (!keystroke) return null;
  if (typeof keystroke === "string") return keystroke;
  return keystroke[process.platform] ?? null;
}

function registerActionKeystrokes(keymaps, viewId, actions, priority) {
  const bindings = {};
  for (const action of actions) {
    const keystroke = keystrokeFor(action);
    if (!keystroke) continue;
    bindings[keystroke] = `modals:${action.name}`;
  }
  if (Object.keys(bindings).length === 0) return null;
  return keymaps.add(`modals:${viewId}`, { [selectorFor(viewId)]: bindings }, priority);
}

module.exports = { registerActionKeystrokes, selectorFor, keystrokeFor, Disposable };
