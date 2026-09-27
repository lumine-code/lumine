const { ipcRenderer } = require("electron");

const CHANNEL = "lumine:web-contents-view-shortcut";
const PAGE_EDIT_KEYS = new Set([
  "a",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "backspace",
  "c",
  "delete",
  "end",
  "home",
  "v",
  "x",
  "y",
  "z",
]);
const MODIFIER_KEYS = new Set(["Control", "Meta"]);
let altGraphActive = false;

function isLumineShortcut(event) {
  const key = event.key.toLowerCase();
  const commandModifier = event.ctrlKey || event.metaKey;
  const isMac = navigator.platform.includes("Mac");

  // AltGr is reported as Ctrl+Alt on some keyboard layouts. Never turn text
  // input into an editor command, even when Chromium does not label it AltGraph.
  if (event.ctrlKey && event.altKey && !event.metaKey) return false;
  if (commandModifier) {
    if (isMac && event.ctrlKey && !event.metaKey && key === " ") return false;
    return !PAGE_EDIT_KEYS.has(key);
  }
  if (event.altKey) {
    if (isMac || /^Numpad\d+$/.test(event.code)) return false;
    return /^[a-z0-9]$/.test(key) || key === "arrowleft" || key === "arrowright";
  }
  if (event.shiftKey && key === "f10") return false;
  return key === "f1" || key === "f5" || key === "f12";
}

// The guest page keeps ordinary input, composition, AltGr, and shortcuts it
// handles itself. Only trusted modified keys and function keys that remain
// unhandled are offered back to Lumine's normal keymap pipeline.
function sendShortcut(event) {
  ipcRenderer.send(CHANNEL, {
    type: event.type,
    key: event.key,
    code: event.code,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    repeat: event.repeat,
  });
}

function forwardShortcut(event) {
  if (!event.isTrusted || event.isComposing) return;
  if (event.key === "AltGraph" || (event.ctrlKey && event.altKey && !event.metaKey)) {
    altGraphActive = true;
    return;
  }
  if (!isLumineShortcut(event)) return;

  if (event.defaultPrevented) return;
  // The window-level bubble listener runs after the focused element and its
  // ancestors have had a chance to consume the event, but still before the
  // browser default action. Avoid executing both the page default and Lumine.
  event.preventDefault();
  event.stopPropagation();
  sendShortcut(event);
}

function forwardModifierRelease(event) {
  if (!event.isTrusted || event.isComposing) return;
  if (altGraphActive) {
    if (!event.ctrlKey && !event.altKey) altGraphActive = false;
    return;
  }
  if (!MODIFIER_KEYS.has(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  sendShortcut(event);
}

// Register after the page's initial scripts and DOMContentLoaded hooks. This
// lets page-owned window listeners prevent their shortcuts before the fallback
// reaches Lumine, while keeping the handler in the final bubble position.
function installShortcutForwarder() {
  setTimeout(() => window.addEventListener("keydown", forwardShortcut), 0);
  setTimeout(() => window.addEventListener("keyup", forwardModifierRelease), 0);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", installShortcutForwarder, { once: true });
} else {
  installShortcutForwarder();
}
