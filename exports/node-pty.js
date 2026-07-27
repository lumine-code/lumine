// Re-exports the pseudoterminal bindings that Lumine ships.
//
// `exports/` is on NODE_PATH (see src/initialize-application-window.js), so a
// package -- including a community package installed outside the app tree --
// can `require("node-pty")` and reach this file rather than needing its own
// copy. That matters because node-pty is a native module: without this, every
// package that wants a terminal has to compile it at install time, which is the
// single most common way installing such a package fails.
//
// Packages must not require `@lumine-code/node-pty` directly. Only this module
// is a supported entry point; the scoped name and its version are Lumine's to
// change.
module.exports = require("@lumine-code/node-pty");
