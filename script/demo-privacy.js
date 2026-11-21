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

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveCaptureDirectory(workspace, directory, sourceRoots) {
  const scratch = path.join(fs.realpathSync(workspace), ".dev");
  const target = resolvedLocation(directory);
  if (!path.relative(scratch, target) || !isInside(scratch, target)) {
    throw new Error("Capture output must be a new directory under the workspace's .dev directory.");
  }
  if (sourceRoots.some((root) => isInside(resolvedLocation(root), target))) {
    throw new Error("Capture output must be outside the source checkouts.");
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

module.exports = { resolveCaptureDirectory, assertPublicText };
