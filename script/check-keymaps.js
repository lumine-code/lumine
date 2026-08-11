// Verifies the keybinding conventions across every bundled package. See
// "Keybindings" in the workspace CLAUDE.md for the rules and why each exists.
//
//   node script/check-keymaps.js
//
// Scans keymaps/*.json{,c} of every bundled package. The four core keymaps are
// checked by spec/platform-keymaps-spec.js instead: they are core's, they carry
// the platform splits, and the rules for them differ.
//
// The rule that pays for the rest is the chord-prefix check. When a keystroke
// is both a complete binding and the prefix of a longer one, `handleKeyboardEvent`
// refuses to dispatch the complete match and enters a pending state
// (src/keymap-manager.js:741-758); the timeout is armed precisely because an
// exact match exists (`:815-818`) and it is 1000 ms (`:95`). Nothing reports
// this — the key simply feels broken.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSON = require("@lumine-code/season");

// A bare `alt-<letter>` reveals a surface, and nothing else may claim one. The
// letter is the package's own initial where it is free. A domain with several
// packages takes its letter as a chord prefix instead and is listed here with
// a trailing space, because a prefix must never also be a complete binding.
const ALT_TIER = new Map([
  ["alt-t", "tree-view"],
  ["alt-l", "linter-panel"],
  ["alt-n", "navigation-panel"],
  ["alt-o", "outline-view"],
  ["alt-e", "fuzzy-explorer"],
  ["alt-p", "project-list"],
  ["alt-r", "recent-list"],
  ["alt-m", "scrollmap"],
  ["alt-k", "hierarchy-view"],
  ["alt-shift-m", "lumine-mcp"],
  ["alt-shift-p", "project-list"],
  ["alt-`", "terminal-spawn"],
]);

// Chord prefixes, and the packages allowed to bind under them.
const ALT_FAMILIES = new Map([
  [
    "alt-g",
    ["git-panel", "github-panel", "open-repository", "git-diff", "git-command", "git-center"],
  ],
  [
    "alt-j",
    [
      "jupyter-explorer",
      "jupyter-inspector",
      "jupyter-monitor",
      "jupyter-prompt",
      "jupyter-repl",
      "jupyter-variables",
      "jupyter-view",
      "jupyter-watches",
    ],
  ],
]);

// Keystrokes that predate the convention and outrank it because a user arrives
// already knowing them from another editor.
const CONVENTION_EXCEPTIONS = new Set([
  "ctrl-`", // terminal
  "cmdorctrl-p", // fuzzy-files
  "cmdorctrl-shift-p", // command-palette
  "cmdorctrl-f", // search-panel
  "cmdorctrl-shift-f", // search-panel, project
  "cmdorctrl-shift-r", // symbol
  "cmdorctrl-.", // keybinding-resolver
  "ctrl-g", // go-to-line
  "f1", // command-palette
]);

// The one spelling for "anywhere in the window". `.workspace` and `body` match
// the same element with specificity 10 and 1, so mixing them decides conflicts
// by accident rather than by intent.
const GLOBAL_SELECTOR = "lumine-workspace";
const GLOBALISH = new Set(["body", "lumine-workspace", ".workspace", "html", ":root"]);

// Commands that act on the file rather than on whatever editor has focus. A
// mini editor — the find field, go-to-line, a commit box — is an
// `lumine-text-editor`, so a bare selector puts these in all of them, and since
// the handlers fall back to `getActiveTextEditor()` they then act on the file
// behind the dialog.
const ACTS_ON_THE_FILE = [
  /^prettier:/,
  /^bookmarks:/,
  /^bracket-matcher:/,
  /^super-select:/,
  /^word-map:/,
  /^git-diff:/,
  /^markdown-preview:/,
  /^grammar-selector:/,
  /^encoding-selector:/,
  /^link:/,
  /^overtype-mode:/,
  /^cursor-leader:/,
  /^sort-lines:/,
  /^autoflow:/,
  /^latex-tools:/,
  /^typst-tools:/,
  /^sofistik-tools:/,
  /^tasklist-tools:/,
];

// Deliberate same-keystroke pairs. Each is a binding that yields with
// `event.abortKeyBinding()` so the one below it gets its turn.
const ALLOWED_SHADOWS = new Set([
  "tab", // snippets:expand yields to editor:indent
  "shift-tab", // snippets:previous-tab-stop yields to editor:outdent-selected-rows
  "escape", // editor:consolidate-selections yields to core:cancel
]);

function bundledPackages() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => ({ name, dir: resolveBundledPackageDir(ROOT, name) }))
    .filter(({ dir }) => dir && fs.existsSync(path.join(dir, "keymaps")));
}

function keymapFiles(dir) {
  const keymapDir = path.join(dir, "keymaps");
  return fs
    .readdirSync(keymapDir)
    .filter((name) => name.endsWith(".json") || name.endsWith(".jsonc"))
    .map((name) => path.join(keymapDir, name));
}

// Flatten a keymap file to one row per binding, expanding the nested form a
// multi-keystroke binding takes when a package writes it as an object.
function flatten(map) {
  const rows = [];
  for (const [selector, block] of Object.entries(map || {})) {
    for (const [keystrokes, command] of Object.entries(block || {})) {
      if (typeof command === "string") {
        rows.push({ selector, keystrokes, command });
        continue;
      }
      for (const [rest, nested] of Object.entries(command || {})) {
        rows.push({ selector, keystrokes: `${keystrokes} ${rest}`, command: nested });
      }
    }
  }
  return rows;
}

// `normalizeKeystroke` sorts modifiers, so two spellings of one chord are the
// same binding. Compare on the sorted form rather than the written one.
function normalize(keystrokes) {
  return keystrokes
    .split(" ")
    .map((stroke) => {
      const parts = stroke.split("-");
      const primary = parts.pop();
      return parts.sort().concat(primary.toLowerCase()).join("-");
    })
    .join(" ");
}

// Two selectors can put their bindings on the same element when one is global
// (it matches an ancestor of everything) or when one is a refinement of the
// other. Anything else — two different panels — is disjoint, and a shared
// keystroke there is not a conflict.
function mayOverlap(a, b) {
  if (a === b) return true;
  const [x, y] = [a.trim(), b.trim()];
  if (GLOBALISH.has(x) || GLOBALISH.has(y)) return true;
  return x.startsWith(y) || y.startsWith(x);
}

// A shadow only matters when neither binding can be reached: two globals, or
// the same selector twice. A surface deliberately reusing a global keystroke
// while it holds focus is the mechanism working — that is how the tree view
// gets `alt-t` back from fuzzy-files' picker.
function shadows(a, b) {
  const [x, y] = [a.trim(), b.trim()];
  if (x === y) return true;
  return GLOBALISH.has(x) && GLOBALISH.has(y);
}

function checkFile(packageName, file, report) {
  const source = fs.readFileSync(file, "utf8");
  if (/,\s*[}\]]/.test(source.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
    report("has a trailing comma");
  }

  const rows = flatten(CSON.readFileSync(file));

  for (const { selector, keystrokes, command } of rows) {
    const first = normalize(keystrokes).split(" ")[0];
    const isGlobal = GLOBALISH.has(selector.trim());

    if (selector.includes("!important")) {
      report(`${keystrokes}: !important buys +1 specificity and nothing else`);
    }
    // A package's keymap files are loaded one by one through `keymapManager.add`
    // and are never filtered by name, so `keymaps/darwin.json` in a package
    // would apply on every platform. `.platform-*` is the only mechanism a
    // package has — but it must qualify a real target. On its own it binds at
    // `body` with class specificity, which silently outranks all of core.
    if (selector.split(",").some((branch) => /^\s*\.platform-\w+\s*$/.test(branch))) {
      report(
        `${keystrokes}: a bare .platform-* selector scores 10 against core's ` +
          `body bindings at 1 — prefix it onto the element you mean`,
      );
    }
    if (isGlobal && selector.trim() !== GLOBAL_SELECTOR) {
      report(`${keystrokes}: global scope is spelled "${GLOBAL_SELECTOR}", not "${selector}"`);
    }
    for (const stroke of keystrokes.split(" ")) {
      const primary = stroke.split("-").pop();
      if (primary.length === 1 && primary !== primary.toLowerCase()) {
        report(`${keystrokes}: write shift- rather than an uppercase "${primary}"`);
      }
    }
    if (selector.includes(",")) {
      // calculateSpecificity truncates at the first comma, so every branch is
      // scored as the first one.
      const branches = selector.split(",").map((branch) => branch.trim());
      const depth = (branch) => branch.split(/\s+/).length;
      if (new Set(branches.map(depth)).size > 1) {
        report(
          `${keystrokes}: comma list is scored on its first branch only — ` +
            `split "${selector}" into one entry per specificity`,
        );
      }
    }

    // Tier 1 discipline.
    if (/^alt-[a-z`]$/.test(first) || /^alt-shift-[a-z]$/.test(first)) {
      const family = ALT_FAMILIES.get(first);
      if (family) {
        if (normalize(keystrokes) === first) {
          report(
            `${keystrokes}: "${first}" is a chord prefix, so binding it alone ` +
              `stalls every press for a second`,
          );
        } else if (!family.includes(packageName)) {
          report(`${keystrokes}: "${first} …" belongs to the ${family[0]} family`);
        }
      } else if (isGlobal) {
        const owner = ALT_TIER.get(first);
        if (owner == null) {
          report(`${keystrokes}: bare "${first}" is reserved for revealing a surface`);
        } else if (owner !== packageName) {
          report(`${keystrokes}: bare "${first}" belongs to ${owner}`);
        }
      } else if (ALT_TIER.has(first) && ALT_TIER.get(first) !== packageName) {
        // A picker's own mini editor may reuse the letter while it is open —
        // that is how the tree view gets alt-t back from fuzzy-files. Anything
        // else sits on a deeper element than the workspace binding and takes
        // the key for as long as that surface has focus.
        if (!/\[mini\]\s*$/.test(selector)) {
          report(
            `${keystrokes}: "${first}" is ${ALT_TIER.get(first)}'s reveal key, and ` +
              `this selector is deeper, so it takes it whenever "${selector}" has focus`,
          );
        }
      }
    }

    // Mini editors.
    if (
      /(^|\s)lumine-text-editor(?![-\w])/.test(selector) &&
      !/\[mini\]|:not\(\[mini\]\)/.test(selector) &&
      ACTS_ON_THE_FILE.some((pattern) => pattern.test(command))
    ) {
      report(`${keystrokes} -> ${command}: acts on the file, so the selector wants :not([mini])`);
    }
  }

  return rows;
}

function checkFleet(all, report) {
  const complete = new Map();
  for (const row of all) {
    const key = normalize(row.keystrokes);
    if (!complete.has(key)) complete.set(key, []);
    complete.get(key).push(row);
  }

  const seen = new Set();
  for (const row of all) {
    const key = normalize(row.keystrokes);
    if (!key.includes(" ")) continue;
    const prefix = key.split(" ")[0];
    for (const other of complete.get(prefix) || []) {
      // A keyup remainder dispatches immediately; only a keydown remainder
      // stalls (keymap-manager.js:741-758).
      if (key.split(" ")[1].startsWith("^")) continue;
      if (!mayOverlap(other.selector, row.selector)) continue;
      const id = `${prefix}|${other.package}|${row.package}`;
      if (seen.has(id)) continue;
      seen.add(id);
      report(
        `${other.package}: "${prefix}" -> ${other.command} is a complete binding and ` +
          `${row.package} uses it as a chord prefix — every press stalls 1000 ms`,
      );
    }
  }

  // A `.platform-*` split that is only a cmd/ctrl swap is what `cmdorctrl-`
  // exists for: one binding instead of two, and it cannot drift.
  const byCommand = new Map();
  for (const row of all) {
    const platform = /\.platform-(win32|linux|darwin)\b/.exec(row.selector);
    if (!platform) continue;
    const target = row.selector
      .replace(/\.platform-\w+\s*/g, "")
      .split(",")[0]
      .trim();
    const key = `${row.command}|${target}|${normalize(row.keystrokes).replace(/\b(cmd|ctrl)-/g, "")}`;
    if (!byCommand.has(key)) byCommand.set(key, new Set());
    byCommand.get(key).add(normalize(row.keystrokes).startsWith("cmd-") ? "cmd" : "ctrl");
    if (byCommand.get(key).size > 1) {
      report(
        `${row.package}: "${row.command}" is split across .platform-* selectors ` +
          `only to swap cmd for ctrl — that is what cmdorctrl- is for`,
      );
      byCommand.get(key).clear();
    }
  }

  const shadowSeen = new Set();
  for (const [key, rows] of complete) {
    if (ALLOWED_SHADOWS.has(key)) continue;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const [a, b] = [rows[i], rows[j]];
        if (a.command === b.command) continue;
        if (a.package === b.package) continue;
        if (!shadows(a.selector, b.selector)) continue;
        const id = [key, a.package, b.package].sort().join("|");
        if (shadowSeen.has(id)) continue;
        shadowSeen.add(id);
        report(
          `"${key}" is bound by ${a.package} (${a.selector} -> ${a.command}) and ` +
            `${b.package} (${b.selector} -> ${b.command}); the deeper or more ` +
            `specific one wins and the other is unreachable`,
        );
      }
    }
  }
}

function main() {
  const errors = [];
  const packages = bundledPackages();
  const all = [];
  let files = 0;

  for (const { name, dir } of packages) {
    for (const file of keymapFiles(dir)) {
      files++;
      const relative = path.relative(ROOT, file);
      const rows = checkFile(name, file, (message) => errors.push(`${relative}: ${message}`));
      for (const row of rows) all.push({ ...row, package: name });
    }
  }

  checkFleet(all, (message) => errors.push(message));

  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `keybinding conventions: ${packages.length} bundled packages, ${files} keymap files ` +
      `scanned, ${all.length} bindings, ${errors.length} error(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();

module.exports = { normalize, mayOverlap, shadows, flatten, CONVENTION_EXCEPTIONS };
