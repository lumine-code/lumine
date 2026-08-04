// Every status dot the Settings view can show, in one place.
//
// A dot is recognised by its colour: people learn what yellow means and then
// read it at a glance, and they talk to each other about "the yellow dot". So
// each state has a colour of its own rather than sharing one severity with the
// others, and the colours are fixed rather than taken from the theme — the same
// state must look the same on every machine, in every theme, and in a
// screenshot.
//
// The colours themselves live next to the dot's other styling, as the
// `--package-dot-*` custom properties in `styles/package-card.css`; the class
// each type resolves to is `badge-dot-<type>`. Adding a dot means adding it
// here, giving it a colour there, and nowhere else.
//
// The editor's own states:
//
//   error       red     the package could not be read from its catalog
//   stale       orange  the newest fetch failed; this is the last good data
//   validating  grey    the manifest is being fetched and validated
//   shadowed    yellow  another copy of this package's name loads instead
//   origin      pink    where a package was installed from is in question
//   selector    brown   catalogs disagree about which version to track
//   source      blue    a bundled package running from the source checkout
//   symlink     cyan    installed as a link to a working copy elsewhere
//
// And the ones a package registry may ask for on a badge of its own, which are
// severities rather than states, and are therefore allowed to share a colour
// with a state that means something similar:
//
//   pulsar      purple  listed by the Pulsar package registry
//   warn        orange
//   success     green
//   info        blue
//
// Anything else falls back to grey.
const STATUS_DOT_TYPES = new Set([
  "error",
  "stale",
  "validating",
  "shadowed",
  "origin",
  "selector",
  "source",
  "symlink",
  "pulsar",
  "warn",
  "success",
  "info",
]);

module.exports = { STATUS_DOT_TYPES };
