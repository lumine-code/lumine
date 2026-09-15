const crypto = require("crypto");

function getProjectStateDigest(projectPaths) {
  if (!Array.isArray(projectPaths) || projectPaths.length === 0) return null;
  return crypto.createHash("sha1").update(projectPaths.slice().sort().join("\n")).digest("hex");
}

function getProjectStateKey(projectPaths) {
  const digest = getProjectStateDigest(projectPaths);
  return digest && `editor-${digest}`;
}

function getWindowProjectStateKey(windowStateId, projectPaths) {
  const digest = getProjectStateDigest(projectPaths);
  if (!digest) return null;
  if (typeof windowStateId !== "string" || windowStateId.length === 0) {
    throw new TypeError("A window state id is required for persistent project state");
  }
  return `editor-${windowStateId}-${digest}`;
}

module.exports = { getProjectStateKey, getWindowProjectStateKey };
