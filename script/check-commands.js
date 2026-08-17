// Verifies the command display-name conventions across every bundled package.
// See "Command display names" in the workspace CLAUDE.md for the rule.
//
//   node script/check-commands.js
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
// The inventory is static: command names come from menus/, keymaps/ and
// activationCommands, plus the `"<pkg>:<name>":` keys registered in lib/ and
// src/. A name built at runtime from a variable is invisible here, which is
// the price of not booting an editor to run a check.
//
// Scope is the bundled fleet, as it is for check-menus and check-keymaps: CI
// resolves packages from node_modules, so a community-tier package is not
// present to scan. The rule applies to those too — nothing here enforces it.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSON = require("@lumine-code/season");
const _ = require("@lumine-code/underscore-plus");

// A command name literal used as an object key or a string argument. The
// namespace is anchored to the package's own name, so `core:save` written by a
// package is not mistaken for one of its own.
const commandPattern = (packageName) =>
  new RegExp(`["'\`]${_.escapeRegExp(packageName)}:([a-z0-9-]+)["'\`]`, "g");

// `displayName: "…"` sitting inside the object literal that follows a command
// key. Matched within the span up to the next command key so a label cannot be
// credited to the wrong command.
const DISPLAY_NAME = /displayName\s*:\s*["'`]([^"'`]*)["'`]/;

const comparable = (label) => label.replace(/\s+/g, "").toLowerCase();

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
    if (!commands.has(command)) commands.set(command, null);
  };

  for (const file of declaredFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(commandPattern(name))) note(match[0].slice(1, -1));
  }

  const manifest = path.join(dir, "package.json");
  if (fs.existsSync(manifest)) {
    const activation = CSON.readFileSync(manifest).activationCommands ?? {};
    for (const list of Object.values(activation)) {
      for (const command of list) if (command.startsWith(`${name}:`)) note(command);
    }
  }

  for (const file of sourceFiles(dir)) {
    const text = fs.readFileSync(file, "utf8");
    const matches = [...text.matchAll(commandPattern(name))];
    matches.forEach((match, index) => {
      const command = match[0].slice(1, -1);
      note(command);
      const until = matches[index + 1]?.index ?? text.length;
      const label = text.slice(match.index, until).match(DISPLAY_NAME);
      if (label) commands.set(command, label[1]);
    });
  }

  return commands;
}

function checkPackage(name, dir, report) {
  const commands = inventory(name, dir);

  for (const [command, displayName] of commands) {
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

  return commands.size;
}

function main() {
  const errors = [];
  const packages = bundledPackages();
  let total = 0;

  for (const { name, dir } of packages) {
    total += checkPackage(name, dir, (message) => errors.push(`${name}: ${message}`));
  }

  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `command display names: ${packages.length} bundled packages, ${total} commands scanned, ` +
      `${errors.length} error(s)`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();

module.exports = { comparable, inventory };
