const path = require("path");

// The editor's private internals (src/*) are not a module a package manifest
// can declare. Resolve them through the running editor's resourcePath: the
// source checkout in dev and spec runs, app.asar in the packaged build. An
// absolute-path require shares the require.cache entry with core's own
// relative requires, so both sides see the same module instance.
module.exports = (name) => require(path.join(atom.getLoadSettings().resourcePath, "src", name));
