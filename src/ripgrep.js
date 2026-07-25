// Resolves the bundled ripgrep binary lazily so that requiring this module
// stays snapshot-safe; in packaged builds the binary lives outside the asar
// archive, hence the app.asar.unpacked rewrite.
module.exports = {
  get rgPath() {
    return require("@vscode/ripgrep").rgPath.replace(/\bapp\.asar\b/, "app.asar.unpacked");
  },
};
