// Verifies the menu conventions across every bundled package. See "Menus" in
// the workspace CLAUDE.md for the rules and why each exists; the short version
// is that the application menu normalizes nothing — `merge` only appends,
// `unmerge` never removes a separator, and the template goes straight to
// Electron — so a menu file's shape is exactly what the user sees.
//
//   node script/check-menus.js
//
// Scans menus/*.json{,c} of every bundled package. The three platform files in
// lumine/menus are checked by spec/platform-menus-spec.js instead: they are
// core's, and the rules for them differ (they carry mnemonics, and Packages
// ends with a separator on purpose).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSON = require("@lumine-code/season");
const _ = require("@lumine-code/underscore-plus");

// The nine menus the platform files declare. A package adds items to one; it
// never restructures one, and in particular never writes a separator into one,
// because unmerge cannot remove it and it would outlive the package.
const CORE_MENUS = new Set([
  "File",
  "Edit",
  "View",
  "Selection",
  "Search",
  "Packages",
  "Help",
  "Window",
  "Lumine",
]);

// Articles, conjunctions and prepositions stay lowercase inside a title —
// except as its first word, which is always capitalised.
const LOWERCASE_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "off",
  "on",
  "onto",
  "or",
  "out",
  "per",
  "the",
  "to",
  "up",
  "via",
  "with",
]);

const MAX_FLAT_ITEMS = 6;
const MAX_GROUP_ITEMS = 8;
const MAX_GROUPS = 5;

// A `Packages > <Name>` label is the package name with hyphens as spaces and
// each word capitalised, so it is derivable and a family stays adjacent in a
// menu sorted by label. `titleize` carries the words with a real casing of
// their own — the same vocabulary the command palette derives its labels from,
// so a menu and a palette can never disagree about how a package is spelled.
const expectedLabel = (packageName) => _.titleize(packageName);

function bundledPackages() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => ({ name, dir: resolveBundledPackageDir(ROOT, name) }))
    .filter(({ dir }) => dir && fs.existsSync(path.join(dir, "menus")));
}

function menuFiles(dir) {
  const menusDir = path.join(dir, "menus");
  return fs
    .readdirSync(menusDir)
    .filter((name) => name.endsWith(".json") || name.endsWith(".jsonc"))
    .map((name) => path.join(menusDir, name));
}

const isSeparator = (item) => item.type === "separator";

// Group an application-menu submenu the way the user reads it: runs of items
// between separators.
function groupsOf(items) {
  const groups = [[]];
  for (const item of items) {
    if (isSeparator(item)) groups.push([]);
    else groups[groups.length - 1].push(item);
  }
  return groups;
}

function checkSeparatorPlacement(items, where, report) {
  items.forEach((item, index) => {
    if (!isSeparator(item)) return;
    if (index === 0) report(`${where} opens with a separator`);
    if (index === items.length - 1) report(`${where} ends with a separator`);
    if (index > 0 && isSeparator(items[index - 1])) report(`${where} has two separators in a row`);
  });
}

function checkLabels(item, where, report) {
  const label = item.label;
  if (label == null) return;
  if (label.includes("&")) {
    report(`${where}: "${label}" contains an ampersand — write "and"`);
  }
  if (label.includes("...")) {
    report(`${where}: "${label}" uses three periods — write the ellipsis character`);
  }
  const words = label.split(/\s+/);
  for (const [index, word] of words.entries()) {
    // A filename or an identifier keeps its own case.
    if (word.includes(".") || word.includes("_") || word.length === 0) continue;
    // The first word is capitalised whatever it is.
    if (index > 0 && LOWERCASE_WORDS.has(word)) continue;
    if (/^[a-z]/.test(word)) {
      report(`${where}: "${label}" is not Title Case ("${word}")`);
    }
  }
}

function walkApplicationMenu(items, where, report, depth = 0) {
  checkSeparatorPlacement(items, where, report);
  for (const item of items) {
    if (isSeparator(item)) continue;
    checkLabels(item, where, report);
    if (Array.isArray(item.submenu)) {
      walkApplicationMenu(item.submenu, `${where} > ${item.label}`, report, depth + 1);
    }
  }
}

function checkPackagesSubmenu(packageName, submenu, report) {
  const wanted = expectedLabel(packageName);
  const entry = submenu.find((item) => !isSeparator(item));
  if (entry == null) return;
  if (entry.label !== wanted) {
    report(`Packages > "${entry.label}" should be "${wanted}" — derived from the package name`);
  }
  if (!Array.isArray(entry.submenu)) return;

  const items = entry.submenu.filter((item) => !isSeparator(item));
  const groups = groupsOf(entry.submenu).filter((group) => group.length > 0);

  if (items.length > MAX_FLAT_ITEMS && groups.length < 2) {
    report(
      `Packages > ${entry.label} has ${items.length} items and no separators — ` +
        `more than ${MAX_FLAT_ITEMS} wants grouping`,
    );
  }
  if (items.length <= MAX_FLAT_ITEMS && groups.length > 1) {
    report(
      `Packages > ${entry.label} has only ${items.length} items and ${groups.length} groups — ` +
        `${MAX_FLAT_ITEMS} or fewer reads better flat`,
    );
  }
  if (groups.length > MAX_GROUPS) {
    report(
      `Packages > ${entry.label} has ${groups.length} groups — ` +
        `past ${MAX_GROUPS} the answer is a nested submenu`,
    );
  }
  for (const group of groups) {
    if (group.length > MAX_GROUP_ITEMS) {
      report(
        `Packages > ${entry.label} has a group of ${group.length} items — ` +
          `past ${MAX_GROUP_ITEMS} the answer is a nested submenu`,
      );
    }
  }
}

function checkFile(packageName, file, report) {
  const source = fs.readFileSync(file, "utf8");
  // The loader tolerates trailing commas; the house style does not.
  if (/,\s*[}\]]/.test(source.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
    report("has a trailing comma");
  }

  const map = CSON.readFileSync(file) || {};

  for (const top of map.menu || []) {
    if (!CORE_MENUS.has(top.label)) {
      report(`contributes to "${top.label}", which is not one of core's menus`);
    }
    if (top.label === "Packages") {
      checkPackagesSubmenu(packageName, top.submenu || [], report);
    } else if (JSON.stringify(top.submenu || []).includes('"separator"')) {
      report(`writes a separator into the core ${top.label} menu`);
    }
    walkApplicationMenu(top.submenu || [], top.label, report);
  }

  for (const [selector, items] of Object.entries(map["context-menu"] || {})) {
    for (const item of items) {
      checkLabels(item, `context-menu[${selector}]`, report);
    }
    // A context menu normalizes its separators, so fencing a block at both ends
    // is what makes its grouping independent of the DOM level it arrives at.
    const meaningful = items.filter((item) => !isSeparator(item));
    if (meaningful.length > 0) {
      if (!isSeparator(items[0]) || !isSeparator(items[items.length - 1])) {
        report(`context-menu[${selector}] is not fenced with separators at both ends`);
      }
    }
  }
}

function main() {
  const errors = [];
  const packages = bundledPackages();
  let files = 0;

  for (const { name, dir } of packages) {
    for (const file of menuFiles(dir)) {
      files++;
      const relative = path.relative(ROOT, file);
      checkFile(name, file, (message) => errors.push(`${relative}: ${message}`));
    }
  }

  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `menu conventions: ${packages.length} bundled packages, ${files} menu files scanned, ` +
      `${errors.length} error(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
