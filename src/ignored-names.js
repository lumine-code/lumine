const picomatch = require("picomatch");

const fs = require("@lumine-code/fs-plus");

// These directories are implementation details of a project checkout, not
// discoverable project files. They remain excluded from bulk discovery even
// when the user removes their names from `core.ignoredNames`.
const AlwaysIgnoredNames = Object.freeze([".git", ".hg", ".svn"]);

const caseInsensitive = fs.isCaseInsensitive();
const warnedPatterns = new Set();

function normalizePattern(pattern) {
  if (typeof pattern !== "string") return null;

  // Globs are portable configuration, so accept either spelling on every
  // platform and hand picomatch/ripgrep forward slashes consistently.
  let normalized = pattern.replace(/\\/g, "/");
  const anchored = normalized.startsWith("/") || normalized.startsWith("./");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/^\/+/, "");
  if (anchored && normalized) normalized = `/${normalized}`;
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || null;
}

function merge(...lists) {
  const patterns = [];
  const seen = new Set();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      const pattern = normalizePattern(value);
      if (!pattern) continue;
      const key = caseInsensitive ? pattern.toLowerCase() : pattern;
      if (seen.has(key)) continue;
      seen.add(key);
      patterns.push(pattern);
    }
  }

  return patterns;
}

function warnInvalidPattern(pattern, error) {
  if (warnedPatterns.has(pattern)) return;
  warnedPatterns.add(pattern);
  console.warn(`Ignoring invalid ignoredNames glob ${JSON.stringify(pattern)}: ${error.message}`);
}

/**
 * Compile the editor's ignored-name semantics into one immutable snapshot.
 *
 * A slashless pattern is matched against every path component. A pattern with
 * a slash is rooted at the project root. Testing every ancestor prefix makes a
 * matched directory exclude everything beneath it without widening the glob.
 *
 * @private
 */
function compile(patterns = []) {
  const entries = [];
  const validPatterns = [];

  for (const pattern of merge(patterns)) {
    const anchored = pattern.includes("/");
    const patternForMatcher = pattern.replace(/^\/+/, "");
    if (!patternForMatcher) continue;

    try {
      entries.push({
        anchored,
        match: picomatch(patternForMatcher, {
          dot: true,
          nocase: caseInsensitive,
          noext: true,
          nonegate: true,
          strictBrackets: true,
        }),
      });
      validPatterns.push(pattern);
    } catch (error) {
      warnInvalidPattern(pattern, error);
    }
  }

  const frozenPatterns = Object.freeze(validPatterns);
  return Object.freeze({
    patterns: frozenPatterns,
    matches(relativePath) {
      if (typeof relativePath !== "string" || relativePath.length === 0) return false;

      let normalizedPath = relativePath.replace(/\\/g, "/");
      while (normalizedPath.startsWith("./")) normalizedPath = normalizedPath.slice(2);
      normalizedPath = normalizedPath.replace(/^\/+|\/+$/g, "");
      if (!normalizedPath) return false;

      const parts = normalizedPath.split("/").filter(Boolean);
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        for (const entry of entries) {
          if (entry.match(entry.anchored ? prefix : part)) return true;
        }
      }
      return false;
    },
  });
}

// Validate and normalize the patterns before they cross the process boundary.
// A leading slash is deliberately retained: ripgrep interprets it as root
// anchoring, matching the in-process predicate above.
function toRipgrepGlobs(patterns = []) {
  return compile(patterns).patterns;
}

function toRipgrepGlobArgs(patterns = [], { exclude = false } = {}) {
  const flag = caseInsensitive ? "--iglob" : "--glob";
  return toRipgrepGlobs(patterns).flatMap((pattern) => [flag, exclude ? `!${pattern}` : pattern]);
}

module.exports = {
  AlwaysIgnoredNames,
  compile,
  merge,
  toRipgrepGlobArgs,
  toRipgrepGlobs,
};
