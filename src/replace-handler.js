/* global emit */ // injected by Lumine's task runner
const fs = require("fs");
const getSubstitution = require("./text-substitution");

// Replace regex matches with replacement text across a fixed list of files, off
// the renderer in a Task. Open buffers receive the exact disk edits rather than
// running a second search against their unsaved contents.
module.exports = function (filePaths, regexSource, regexFlags, replacementText, openPaths) {
  const callback = this.async();
  const openPathSet = new Set(openPaths);
  // The caller always requests a global replace; guard in case it does not so a
  // single-match regex still replaces every occurrence.
  const flags = regexFlags.includes("g") ? regexFlags : `${regexFlags}g`;

  const replaceInFile = async (filePath) => {
    let contents;
    try {
      contents = await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      emit("replace:file-error", { code: error.code, path: filePath, message: error.message });
      return;
    }

    // A fresh regex per file keeps `lastIndex` from leaking between files.
    let replacements = 0;
    const changes = [];
    const updated = contents.replace(new RegExp(regexSource, flags), (match, ...args) => {
      const namedCaptures = typeof args.at(-1) === "object" ? args.pop() : undefined;
      args.pop(); // source text
      const start = args.pop();
      const newText = getSubstitution(match, contents, start, args, namedCaptures, replacementText);
      replacements++;
      if (openPathSet.has(filePath) && newText !== match) {
        changes.push({ start, end: start + match.length, newText });
      }
      return newText;
    });
    if (replacements === 0) return;

    try {
      await fs.promises.writeFile(filePath, updated);
    } catch (error) {
      emit("replace:file-error", { code: error.code, path: filePath, message: error.message });
      return;
    }
    const result = { filePath, replacements };
    if (openPathSet.has(filePath)) {
      result.fileChanges = { oldText: contents, newText: updated, changes };
    }
    emit("replace:path-replaced", result);
  };

  (async () => {
    for (const filePath of filePaths) {
      await replaceInFile(filePath);
    }
    callback();
  })();
};
