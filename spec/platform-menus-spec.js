const fs = require("fs");
const path = require("path");

// `menus/{win32,linux,darwin}.json` are three spellings of one menu bar. They
// diverge only where a platform requires it, and every such divergence is named
// in ALLOWED_DIVERGENCES below with the reason. Anything else is drift: the swap
// of two Selection items on darwin, the Cut/Copy mnemonics that disagreed
// between win32 and linux, and the four update items that outlived the code
// that flipped them all shipped that way and none of them was deliberate.
const PLATFORMS = ["win32", "linux", "darwin"];

// Paths whose presence, label or position is platform-specific. A path listed
// here is excluded from the cross-platform comparison entirely.
const ALLOWED_DIVERGENCES = [
  // macOS puts the application's own items in an app menu named after it, and
  // takes About/License/Version and Settings out of Help and File to do it.
  "/Lumine",
  "/Help/View License",
  "/Help/VERSION",
  "/Help/About Lumine",
  "/File/Settings",
  "/File/Config",
  "/File/Init Script",
  "/File/Keymap",
  "/File/Snippets",
  "/File/Stylesheet",
  // macOS ships a Window menu with the standard role.
  "/Window",
  // The macOS open panel selects a file or a folder in one dialog.
  "/File/Open…",
  "/File/Open File…",
  "/File/Open Folder…",
  // Quit is spelled by platform convention and lives in the app menu on macOS.
  "/File/Exit",
  "/File/Quit",
  // There is no in-window menu bar to toggle on macOS.
  "/View/Toggle Menu Bar",
];

// Paths whose own attributes are platform-specific but whose children are not.
// Unlike ALLOWED_DIVERGENCES these match exactly, so the submenu is still
// compared item by item.
const ALLOWED_NODE_DIVERGENCES = [
  // macOS wires the Help menu to the system help search field through its role.
  "/Help",
];

// Menu commands this repository does not register itself. Everything else must
// resolve, which is what keeps a menu item from outliving its command — the way
// `application:install-update` did after its main-process handler went away.
const EXTERNALLY_PROVIDED = [/^settings-view:/, /^search-panel:/];

// Not every core command is registered in the renderer a spec runs in: the
// `window:*` family lives in WindowEventHandler, `application:*` is handled in
// the main process, and HistoryManager registers its own. Reading src/ catches
// what the registry cannot see, and is what fails when a command is deleted.
function sourceText() {
  const srcDir = path.join(__dirname, "..", "src");
  const read = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return read(entryPath);
      return entry.name.endsWith(".js") ? [fs.readFileSync(entryPath, "utf8")] : [];
    });
  return read(srcDir).join("\n");
}

// A trailing separator is an anchor for items appended later, and `merge` only
// ever appends. These two have a live stream of items after them; anywhere else
// a trailing separator renders as a rule with nothing under it.
const TRAILING_SEPARATOR_ANCHORS = ["/File/Reopen Project", "/Packages"];

const readMenu = (platform) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, "..", "menus", `${platform}.json`), "utf8"));

const strip = (label) => (label == null ? "" : label.replace(/&/g, ""));

// Flatten to `path -> what the item does`, dropping separators: their position
// is checked by the hygiene test, and identical sibling separators would
// collapse into one entry here anyway.
function flatten(items, prefix = "", out = new Map()) {
  for (const item of items) {
    if (item.type === "separator") continue;
    const itemPath = `${prefix}/${strip(item.label)}`;
    out.set(itemPath, item.command || item.role || (item.submenu ? "(submenu)" : "(inert)"));
    if (item.submenu) flatten(item.submenu, itemPath, out);
  }
  return out;
}

const isAllowed = (itemPath) =>
  ALLOWED_DIVERGENCES.some((allowed) => itemPath === allowed || itemPath.startsWith(`${allowed}/`));

const isAllowedNode = (itemPath) =>
  isAllowed(itemPath) || ALLOWED_NODE_DIVERGENCES.includes(itemPath);

function eachSubmenu(items, prefix, visit) {
  visit(items, prefix);
  for (const item of items) {
    if (item.submenu) eachSubmenu(item.submenu, `${prefix}/${strip(item.label)}`, visit);
  }
}

describe("platform menus", function () {
  const menus = {};

  beforeEach(function () {
    for (const platform of PLATFORMS) menus[platform] = readMenu(platform);
  });

  it("declares the same items on every platform outside the allow-list", function () {
    const flattened = {};
    for (const platform of PLATFORMS) flattened[platform] = flatten(menus[platform].menu);

    for (const platform of PLATFORMS) {
      for (const other of PLATFORMS) {
        if (platform === other) continue;
        const missing = [];
        for (const [itemPath, action] of flattened[platform]) {
          if (isAllowedNode(itemPath)) continue;
          if (flattened[other].get(itemPath) !== action) {
            missing.push(`${itemPath} -> ${action}`);
          }
        }
        expect({ platform, other, missing }).toEqual({ platform, other, missing: [] });
      }
    }
  });

  it("orders every shared submenu identically", function () {
    const sequences = {};
    for (const platform of PLATFORMS) {
      sequences[platform] = new Map();
      eachSubmenu(menus[platform].menu, "", (items, prefix) => {
        sequences[platform].set(
          prefix,
          items
            .filter((item) => item.type !== "separator")
            .map((item) => `${prefix}/${strip(item.label)}`)
            .filter((itemPath) => !isAllowed(itemPath)),
        );
      });
    }

    for (const prefix of sequences.win32.keys()) {
      if (isAllowed(prefix)) continue;
      for (const platform of PLATFORMS) {
        if (!sequences[platform].has(prefix)) continue;
        expect({ prefix, platform, order: sequences[platform].get(prefix) }).toEqual({
          prefix,
          platform,
          order: sequences.win32.get(prefix),
        });
      }
    }
  });

  it("keeps separators off the edges of every submenu", function () {
    for (const platform of PLATFORMS) {
      const problems = [];
      eachSubmenu(menus[platform].menu, "", (items, prefix) => {
        items.forEach((item, index) => {
          if (item.type !== "separator") return;
          if (index === 0) problems.push(`leading separator in ${prefix}`);
          if (index > 0 && items[index - 1].type === "separator") {
            problems.push(`doubled separator in ${prefix}`);
          }
          if (index === items.length - 1 && !TRAILING_SEPARATOR_ANCHORS.includes(prefix)) {
            problems.push(`trailing separator in ${prefix}`);
          }
        });
      });
      expect({ platform, problems }).toEqual({ platform, problems: [] });
    }
  });

  it("writes mnemonics on win32 and linux only", function () {
    expect(JSON.stringify(menus.darwin.menu)).not.toContain("&");

    for (const platform of ["win32", "linux"]) {
      const problems = [];
      eachSubmenu(menus[platform].menu, "", (items, prefix) => {
        const claimed = new Map();
        for (const item of items) {
          if (item.label == null) continue;
          const matches = item.label.match(/&(.)/g) || [];
          if (matches.length > 1) problems.push(`${prefix}/${strip(item.label)} has two mnemonics`);
          if (matches.length === 0) continue;
          const letter = matches[0][1].toUpperCase();
          if (claimed.has(letter)) {
            problems.push(
              `${prefix}: ${claimed.get(letter)} and ${item.label} both claim ${letter}`,
            );
          }
          claimed.set(letter, item.label);
        }
      });
      expect({ platform, problems }).toEqual({ platform, problems: [] });
    }
  });

  it("uses the same mnemonic letter on win32 and linux", function () {
    const letters = {};
    for (const platform of ["win32", "linux"]) {
      letters[platform] = new Map();
      eachSubmenu(menus[platform].menu, "", (items, prefix) => {
        for (const item of items) {
          if (item.label == null) continue;
          const match = item.label.match(/&(.)/);
          letters[platform].set(`${prefix}/${strip(item.label)}`, match ? match[1] : null);
        }
      });
    }

    const problems = [];
    for (const [itemPath, letter] of letters.win32) {
      if (!letters.linux.has(itemPath)) continue;
      if (letters.linux.get(itemPath) !== letter) {
        problems.push(`${itemPath}: win32 ${letter} vs linux ${letters.linux.get(itemPath)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("declares the same context menu on every platform", function () {
    const serialized = PLATFORMS.map((platform) => JSON.stringify(menus[platform]["context-menu"]));
    expect(serialized[1]).toBe(serialized[0]);
    expect(serialized[2]).toBe(serialized[0]);
  });

  it("uses only valid context-menu selectors", function () {
    for (const selector of Object.keys(menus.win32["context-menu"])) {
      expect(() => document.querySelector(selector)).not.toThrow();
    }
  });

  it("names a registered command in every menu item", function () {
    const registered = new Set([
      ...Object.keys(lumine.commands.selectorBasedListenersByCommandName),
      ...Object.keys(lumine.commands.inlineListenersByCommandName),
    ]);
    const source = sourceText();

    const commands = new Set();
    const collect = (items) => {
      for (const item of items) {
        if (item.command) commands.add(item.command);
        if (item.submenu) collect(item.submenu);
      }
    };
    // Only the running platform's file: the darwin-only commands are registered
    // behind a `process.platform` check and would read as missing elsewhere.
    collect(menus[process.platform].menu);
    for (const items of Object.values(menus[process.platform]["context-menu"])) collect(items);

    const unregistered = [...commands].filter(
      (command) =>
        !registered.has(command) &&
        !source.includes(`"${command}"`) &&
        !EXTERNALLY_PROVIDED.some((pattern) => pattern.test(command)),
    );
    expect(unregistered).toEqual([]);
  });
});
