const { EventEmitter } = require("events");
const { Disposable } = require("@lumine-code/event-kit");
const { systemPreferences } = require("electron");

// The operating system's accent color, watched in the main process and
// broadcast to every window so themes can follow it (see `theme-manager`).
//
// Two things about this API are not what the documentation says, and both are
// load-bearing here:
//
//   * Electron documents `getAccentColor()` as "only available on macOS 10.14
//     Mojave or newer". It is not — it answers on Windows (verified returning
//     the real registry accent under Electron 43.4.0) and on Linux, whose
//     intermittent empty-string result was what Electron 43.4.0 fixed. So
//     availability is *discovered*, never declared: read it, and treat
//     anything unusable as "no system accent".
//   * Chromium's CSS `AccentColor` system color is not a way around this. It
//     parses and computes, but to a fixed value (rgb(0, 117, 255)) rather than
//     the user's accent, so it cannot stand in for the real thing.
//
// The renderer never sees a raw value: everything here normalizes to a CSS
// `#rrggbb` string or `null`.

let subscriptionId;
let changeListener;
const EMITTER = new EventEmitter();

function onDidChangeAccentColor(callback) {
  EMITTER.on("did-change-accent-color", callback);
  return new Disposable(() => {
    EMITTER.off("did-change-accent-color", callback);
  });
}

// The current accent color as `#rrggbb`, or `null` where the platform has none
// to give. Never throws: an unsupported platform is a normal answer here.
function getAccentColor() {
  try {
    return normalizeAccentColor(systemPreferences.getAccentColor());
  } catch {
    return null;
  }
}

// Electron hands back RGBA hex with no leading `#` and the alpha last
// ("aabbccdd"). Drop the alpha — an accent is a solid color, and compositing
// the OS alpha against an unknown theme background would only muddy it.
function normalizeAccentColor(value) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(digits)) return null;
  return `#${digits.slice(0, 6).toLowerCase()}`;
}

function initialize() {
  if (process.platform === "darwin") {
    // macOS reports the change as a distributed notification rather than
    // through `accent-color-changed`, and carries no color with it, so re-read.
    subscriptionId = systemPreferences.subscribeNotification(
      "AppleColorPreferencesChangedNotification",
      () => {
        EMITTER.emit("did-change-accent-color", getAccentColor());
      },
    );
    return;
  }

  // Windows and Linux. The event carries the new color, but it arrives in the
  // same shape `getAccentColor` returns, so it goes through the same gate.
  changeListener = (event, newColor) => {
    EMITTER.emit("did-change-accent-color", normalizeAccentColor(newColor));
  };
  systemPreferences.on("accent-color-changed", changeListener);
}

function destroy() {
  if (subscriptionId != null) {
    systemPreferences.unsubscribeNotification(subscriptionId);
    subscriptionId = undefined;
  }
  if (changeListener != null) {
    systemPreferences.off("accent-color-changed", changeListener);
    changeListener = undefined;
  }
}

initialize();

module.exports = {
  onDidChangeAccentColor,
  getAccentColor,
  normalizeAccentColor,
  destroy,
};
