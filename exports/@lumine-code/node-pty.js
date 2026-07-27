// Re-exports the pseudoterminal bindings that Lumine ships.
//
// `exports/` is on NODE_PATH (see src/initialize-application-window.js), and
// Node treats a NODE_PATH entry as a `node_modules` root, so the scoped path of
// this file is what makes `require("@lumine-code/node-pty")` resolve from a
// package installed outside the app tree. Without it a community package would
// have to depend on node-pty itself, and node-pty is a native module: having
// every package that wants a terminal compile one at install time is the single
// most common way those installs fail.
//
// The specifier below resolves to the real package through the ordinary
// node_modules walk (`<resourcePath>/node_modules/@lumine-code/node-pty`), which
// Node checks before NODE_PATH -- so this does not resolve back to itself.
module.exports = require("@lumine-code/node-pty");
