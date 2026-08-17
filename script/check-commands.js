// Verifies a command's two pieces of prose — its label and its description.
// See "Command display names" and "Command descriptions" in the workspace
// CLAUDE.md for the rules.
//
//   node script/check-commands.js                     the bundled fleet
//   node script/check-commands.js --root ..           every repository here
//   node script/check-commands.js --root .. --uncovered
//
// A command's label is derived: `extractDescriptor` (src/command-registry.js)
// falls back to `_.humanizeEventName`, which spells the words with a casing of
// their own from the `ACRONYMS` map in underscore-plus. A `displayName` is the
// escape hatch for a label that vocabulary still cannot reach, so it may
// differ from the derived label only in letter case and internal spacing.
// Anything else is a rename wearing a label, and belongs in the command name.
//
// Four findings, each of which the derivation makes possible:
//
//   1. a displayName that rephrases — rename the command instead
//   2. a displayName the humanizer already produces — delete it
//   3. a displayName that adds a space — the name is squashed, add the dash
//   4. a displayName that only re-cases an ordinary word — palette labels keep
//      the humanizer's word case; lowercase prepositions are a menu-label rule
//
// What survives is a package spelling its own domain's jargon: SOFiSTiK's WPS
// and SOFiPLUS are spelled where those commands live, because the shared
// vocabulary is what every consumer carries and no one else needs those words.
//
// A description is checked the same way and reported six ways: one that only
// restates the label, one that does not end with a period, one that does not
// start with a capital, one written in the third person, one past 76
// characters, and one carrying markdown the palette renders as text. A command
// registered twice with two different descriptions is reported as well, since
// which of them shows depends on where focus is.
//
// Coverage is *reported and never fails*. A description belongs only where the
// derived label leaves something open, so a bare command is a judgement rather
// than a defect, and a check that demanded one everywhere would buy a fleet of
// lines restating their own titles.
//
// The inventory is static: command names come from menus/, keymaps/ and
// activationCommands, plus the `"<pkg>:<name>":` keys registered in lib/ and
// src/. A name built at runtime from a variable is invisible here, and so is a
// description a helper forwards rather than one written beside its command —
// which is why a table-driven registration keys by the full command name and
// puts the description next to it.
//
// One name shape defeats the pattern rather than merely hiding from it: a
// command with a quote character *in* its name, as super-select's
// `string-'-'` family has. The quote ends the literal the scan is reading, so
// the command is reported under a truncated name and never credited with the
// description written beside it. Spelling a delimiter into a command name is
// rare enough to leave alone; the alternative is a pattern that cannot tell a
// command name from the code around it.
//
// Scope defaults to the bundled fleet, as it does for check-menus and
// check-keymaps. That reads the *pinned* copies out of node_modules, so a
// description written in a working tree is invisible until a repin lands, and
// the community-tier repositories are never installed for it to see at all.
// `--root <dir>` scans a flat workspace instead, every repository from its own
// working tree, which is what the rule actually covers.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSON = require("@lumine-code/season");
const _ = require("@lumine-code/underscore-plus");

// A command name literal used as an object key or a string argument. The
// namespace is anchored to the package's own name, so `core:save` written by a
// package is not mistaken for one of its own.
//
// The half after the colon is matched case-insensitively because a few commands
// spell an acronym in the name itself — `bacadra-tools:open-CALC`. Lowercasing
// the class here hid those from the description scan entirely: they were counted
// from `activationCommands`, which does not go through this pattern, and then
// never visited in the source, so a description written beside one read as
// missing.
const commandPattern = (packageName) =>
  new RegExp(`["'\`]${_.escapeRegExp(packageName)}:([A-Za-z0-9-]+)["'\`]`, "g");

// `displayName: "…"` sitting inside the object literal that follows a command
// key. Matched within the span up to the next command key so a label cannot be
// credited to the wrong command.
const DISPLAY_NAME = /displayName\s*:\s*["'`]([^"'`]*)["'`]/;

// `description: "…"` as the *first* key of the descriptor a command name opens.
// The window is one literal rather than the span to the next command, because
// `description` is also the options key for a notification and for a
// configSchema entry, and both appear in the same files in quantity. Anchoring
// on the convention — description first, didDispatch last — is what makes the
// key findable without parsing, and enforces the ordering as a side effect.
// The separator is `:` in a command map and `,` in the three-argument form
// `add(target, name, listener)`, which core and several packages use; both open
// the same descriptor, so both are credited.
const descriptionPattern = (command) =>
  new RegExp(
    `["'\`]${_.escapeRegExp(command)}["'\`]\\s*[:,]\\s*\\{` +
      `(?:\\s*//[^\\n]*)*` +
      `\\s*description\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1`,
  );

// The same convention in JSX, where a component registers the command for its
// subtree: `<Command command="pkg:cmd" description="…" callback={…} />`. The
// description still comes first, directly after the name it belongs to.
const jsxDescriptionPattern = (command) =>
  new RegExp(
    `command=(["'\`])${_.escapeRegExp(command)}\\1` +
      `\\s*description=(["'\`])((?:\\\\.|(?!\\2).)*)\\2`,
  );

const comparable = (label) => label.replace(/\s+/g, "").toLowerCase();

// A description is one imperative sentence. Third person is the tell that it was
// written as documentation about the command rather than as the command itself.
const THIRD_PERSON =
  /^(Shows|Opens|Toggles|Displays|Runs|Adds|Removes|Closes|Copies|Moves|Sets|Creates|Deletes|Inserts|Selects|Switches|Turns|Makes|Returns|Prints|Reloads|Restarts|Saves|Sends|Starts|Stops|Updates|Clears|Focuses|Jumps|Marks|Reveals|Scrolls|Splits|Wraps|Cuts|Pastes|Folds|Indents|Hides|Lists|Loads|Picks|Applies|Enables|Disables)\b/;

const MARKDOWN = /`|\*\*|\[[^\]]*\]\([^)]*\)/;

const MAX_LENGTH = 76;

// The editor's own commands are not namespaced by its package name, so the
// derivation that works for every package needs the list spelled out here.
const EDITOR_NAMESPACES = [
  "core",
  "editor",
  "pane",
  "window",
  "application",
  "modal",
  "repositories",
  "git",
];

const namespacesFor = (packageName) =>
  packageName === "lumine" ? EDITOR_NAMESPACES : [packageName];

function bundledPackages() {
  const { scanBundledPackageNames, resolveBundledPackageDir } = require("../src/bundled-packages");
  return scanBundledPackageNames(ROOT)
    .map((name) => ({ name, dir: resolveBundledPackageDir(ROOT, name) }))
    .filter(({ dir }) => dir);
}

function sourceFiles(dir) {
  const files = [];
  for (const subdirectory of ["lib", "src"]) {
    const root = path.join(dir, subdirectory);
    if (!fs.existsSync(root)) continue;
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);
  }
  return files;
}

function declaredFiles(dir) {
  const files = [];
  for (const subdirectory of ["menus", "keymaps"]) {
    const root = path.join(dir, subdirectory);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (name.endsWith(".json") || name.endsWith(".jsonc")) files.push(path.join(root, name));
    }
  }
  return files;
}

// Every command the package names, mapped to the displayName it registers for
// it, if any. A command declared in a menu but registered in a file this scan
// cannot read still counts — the label is derived either way.
function inventory(name, dir) {
  const commands = new Map();
  const note = (command) => {
    if (!commands.has(command)) commands.set(command, { displayName: null, description: null });
    return commands.get(command);
  };
  const namespaces = namespacesFor(name);
  const patterns = namespaces.map((namespace) => commandPattern(namespace));

  for (const file of declaredFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) note(match[0].slice(1, -1));
    }
  }

  const manifest = path.join(dir, "package.json");
  if (fs.existsSync(manifest)) {
    const activation = CSON.readFileSync(manifest).activationCommands ?? {};
    for (const list of Object.values(activation)) {
      for (const command of list) {
        if (namespaces.some((namespace) => command.startsWith(`${namespace}:`))) note(command);
      }
    }
  }

  for (const file of sourceFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    const matches = patterns
      .flatMap((pattern) => [...text.matchAll(pattern)])
      .sort((a, b) => a.index - b.index);
    matches.forEach((match, index) => {
      const command = match[0].slice(1, -1);
      const entry = note(command);
      const until = matches[index + 1]?.index ?? text.length;
      const label = text.slice(match.index, until).match(DISPLAY_NAME);
      if (label) entry.displayName = label[1];

      // Anchored on the command itself rather than on the slice, so a
      // descriptor split across the window boundary is still credited. The JSX
      // form anchors on the `command=` attribute instead, which sits one token
      // before the name rather than on it.
      const rest = text.slice(match.index);
      const described = rest.match(descriptionPattern(command));
      const jsx = text.slice(Math.max(0, match.index - 16)).match(jsxDescriptionPattern(command));
      const found = described && described.index === 0 ? described[2] : jsx ? jsx[3] : null;
      if (found != null) {
        if (entry.description != null && entry.description !== found) {
          entry.conflict = found;
        }
        entry.description = found;
      }
    });
  }

  return commands;
}

// A description earns its row by saying something the label does not. These are
// the ways one fails to, each of them cheap to see and expensive to leave in:
// the palette joins the description to the fuzzy candidate, so a wasted line
// also costs the command score for a query aimed at its own name.
function checkDescription(command, description, report) {
  const label = _.humanizeEventName(command).replace(/^[^:]+:\s*/, "");

  if (comparable(description.replace(/[.!?]+$/, "")) === comparable(label)) {
    report(`${command}: description "${description}" only restates the label "${label}"`);
    return;
  }
  if (!/[.]$/.test(description)) {
    report(`${command}: description "${description}" does not end with a period`);
  }
  if (/^[a-z]/.test(description)) {
    report(`${command}: description "${description}" does not start with a capital`);
  }
  if (THIRD_PERSON.test(description)) {
    report(`${command}: description "${description}" is third person — write the imperative`);
  }
  if (description.length > MAX_LENGTH) {
    report(`${command}: description is ${description.length} characters, over ${MAX_LENGTH}`);
  }
  if (MARKDOWN.test(description)) {
    report(`${command}: description "${description}" carries markdown, which is rendered as text`);
  }
}

function checkPackage(name, dir, report) {
  const commands = inventory(name, dir);

  for (const [command, entry] of commands) {
    const { displayName, description } = entry;

    if (description != null) checkDescription(command, description, report);
    if (entry.conflict != null) {
      report(
        `${command}: registered with two descriptions — "${description}" and ` +
          `"${entry.conflict}". Which one shows depends on where focus is`,
      );
    }

    if (displayName == null) continue;
    const derived = _.humanizeEventName(command);

    if (displayName === derived) {
      report(`${command}: displayName "${displayName}" is what the humanizer already derives`);
      continue;
    }

    if (comparable(displayName) !== comparable(derived)) {
      report(
        `${command}: displayName "${displayName}" renames "${derived}" rather than re-casing ` +
          `it — rename the command instead`,
      );
      continue;
    }

    const written = displayName.split(/\s+/);
    const words = derived.split(/\s+/);
    if (written.length !== words.length) {
      report(
        `${command}: displayName "${displayName}" splits a word "${derived}" does not — the ` +
          `command name is missing a dash`,
      );
      continue;
    }

    // Same words, different case. A word carrying a capital past its first
    // letter — HTML, WinGRAF, SOFiPLUS, DBInfo — is a deliberate spelling, and
    // spelling one is the whole job of a displayName. Anything else is a
    // word-case preference the palette does not honour.
    const ordinary = written.filter(
      (word, index) => word !== words[index] && !/[A-Z]/.test(word.slice(1)),
    );
    if (ordinary.length > 0) {
      report(
        `${command}: displayName "${displayName}" re-cases ${ordinary.join(", ")} — palette ` +
          `labels keep the humanizer's word case`,
      );
    }
  }

  const described = [...commands.values()].filter((entry) => entry.description != null).length;
  return {
    total: commands.size,
    described,
    undescribed: [...commands]
      .filter(([, entry]) => entry.description == null)
      .map(([command]) => command),
  };
}

// Every repository in a flat workspace that declares itself a package, plus the
// editor. `--root` exists because the default scan reads the *pinned* copies out
// of node_modules, so a description written in a working tree is invisible to it
// until a repin lands, and the community-tier repositories are never installed
// for it to see at all.
function packagesUnderRoot(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .map(({ name, dir }) => {
      const manifest = path.join(dir, "package.json");
      if (!fs.existsSync(manifest)) return null;
      let parsed;
      try {
        parsed = CSON.readFileSync(manifest);
      } catch {
        return null;
      }
      const isPackage = parsed?.engines?.lumine != null;
      const isEditor = fs.existsSync(path.join(dir, "src", "register-default-commands.js"));
      if (!isPackage && !isEditor) return null;
      return { name: parsed?.name ?? name, dir };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag === -1 ? null : path.resolve(process.argv[rootFlag + 1] ?? ".");
  const verbose = process.argv.includes("--uncovered");

  const errors = [];
  const packages = root ? packagesUnderRoot(root) : bundledPackages();
  let total = 0;
  let described = 0;
  const uncovered = [];

  for (const { name, dir } of packages) {
    const result = checkPackage(name, dir, (message) => errors.push(`${name}: ${message}`));
    total += result.total;
    described += result.described;
    if (result.undescribed.length > 0) {
      uncovered.push({ name, count: result.undescribed.length, commands: result.undescribed });
    }
  }

  for (const error of errors) console.error(`error: ${error}`);

  const scope = root
    ? `${packages.length} packages under ${root}`
    : `${packages.length} bundled packages`;
  console.log(`command metadata: ${scope}, ${total} commands scanned, ${errors.length} error(s)`);

  // Coverage reports and never fails: a description belongs only where the
  // derived label leaves something open, so a gap is a judgement, not a defect.
  const percent = total === 0 ? 100 : Math.round((described / total) * 100);
  console.log(
    `coverage: ${described}/${total} described (${percent}%) — ` +
      `${uncovered.length} package(s) with a gap`,
  );
  uncovered.sort((a, b) => b.count - a.count);
  for (const entry of uncovered.slice(0, verbose ? uncovered.length : 10)) {
    console.log(
      `  ${entry.name}: ${entry.count}${verbose ? ` — ${entry.commands.join(", ")}` : ""}`,
    );
  }

  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();

module.exports = { comparable, inventory };
