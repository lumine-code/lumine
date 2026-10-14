const fs = require("node:fs");
const path = require("node:path");

function resolvedLocation(location) {
  const tail = [];
  let ancestor = path.resolve(location);
  while (!fs.existsSync(ancestor)) {
    tail.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.join(fs.realpathSync(ancestor), ...tail);
}

function assertNeutralDirectory(directory, privateRoots) {
  const target = resolvedLocation(directory);
  for (const root of privateRoots) {
    const relative = path.relative(resolvedLocation(root), target);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      throw new Error(
        "Capture output must be outside the source workspace and user profile; choose a neutral --out directory.",
      );
    }
  }
  return target;
}

const normalize = (value) => String(value).replace(/\\+/g, "/").toLowerCase();
function assertPublicText(text, privateRoots) {
  const normalized = normalize(text);
  for (const root of privateRoots) {
    if (root && normalized.includes(normalize(root).replace(/\/$/, ""))) {
      throw new Error(
        "Demo exposes a local workspace, user profile or tool installation path. Fix the scene before capturing.",
      );
    }
  }
}

module.exports = { assertNeutralDirectory, assertPublicText };
