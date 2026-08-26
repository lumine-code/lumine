const path = require("path");
const CSON = require("@lumine-code/season");

// `keymaps/{base,win32,linux,darwin}.json` are one keymap split four ways.
// `base.json` holds everything shared, using `cmdorctrl` for a plain cmd/ctrl
// swap; the platform files hold only what a platform genuinely requires. That
// makes win32.json and linux.json identical, and makes every darwin difference
// something a reader can name — which is what this spec checks, because the
// drift it replaced was invisible: `alt-shift-left` was bound to a command it
// could never reach, `ctrl-home` worked outside an editor on one platform of
// three, and seven commands had a macOS accelerator and no other.
const PLATFORMS = ["win32", "linux", "darwin"];

const keymapDir = path.join(__dirname, "..", "keymaps");
const load = (name) => CSON.readFileSync(path.join(keymapDir, `${name}.json`));

// Every binding in the file, flattened, in declaration order.
function bindings(name) {
  const rows = [];
  for (const [selector, block] of Object.entries(load(name))) {
    for (const [keystrokes, command] of Object.entries(block)) {
      rows.push({ selector, keystrokes, command });
    }
  }
  return rows;
}

// What a platform actually gets: base plus its own file.
function effective(platform) {
  return bindings("base").concat(bindings(platform));
}

// Commands a platform is allowed to bind alone, with the reason. Anything not
// listed must be reachable on all three.
const PLATFORM_ONLY_COMMANDS = {
  darwin: [
    // Apple application plumbing with no equivalent elsewhere.
    "application:hide",
    "application:hide-other-applications",
    "application:minimize",
    "application:zoom",
    // macOS selects a file or a folder in one open panel.
    "application:open",
    // Cocoa line editing, system-wide on macOS and foreign everywhere else.
    "editor:cut-to-end-of-line",
    "editor:delete-to-beginning-of-line",
    "editor:delete-to-end-of-line",
    "editor:move-to-end-of-line",
  ],
  win32: ["application:open-file", "application:open-folder"],
  linux: ["application:open-file", "application:open-folder"],
};

// Keystrokes that deliberately mean different things per platform. `native!` is
// excluded from the comparison entirely: the `body .native-key-bindings` block
// hands keys back to Chromium and names both the cmd- and ctrl- spelling on
// every platform on purpose.
const ALLOWED_KEYSTROKE_DIVERGENCES = {
  // macOS navigates by word on alt and pushes subword onto ctrl-alt; win32 and
  // linux navigate by word on ctrl and put subword on alt.
  "alt-left": "word vs subword navigation",
  "alt-right": "word vs subword navigation",
  "alt-shift-left": "word vs subword navigation",
  "alt-shift-right": "word vs subword navigation",
  "alt-backspace": "word vs subword navigation",
  "alt-delete": "word vs subword navigation",
  // macOS reserves ctrl-up/down for Mission Control, so move-line lives on
  // ctrl-cmd-up/down there.
  "ctrl-up": "macOS reserves ctrl-up for Mission Control",
  "ctrl-down": "macOS reserves ctrl-down for App Exposé",
  // add-project-folder is cmd-shift-a on macOS, which frees ctrl-shift-a for
  // the Cocoa select-to-first-character binding.
  "ctrl-shift-a": "add-project-folder is on cmd-shift-a on macOS",
  // Shift-Delete as cut is a CUA convention with no macOS equivalent.
  "shift-delete": "CUA cut vs macOS forward delete",
  // restore-query is bound on every platform, scoped to an open select list or
  // input dialog; win32 and linux also give f11 to full screen at window scope.
  // The two never contend — nobody reaches for full screen while a modal is up.
  f11: "select-list restore-query shadows win32/linux full screen while a modal is open",
};

function commandsByPlatform() {
  const byPlatform = {};
  for (const platform of PLATFORMS) {
    byPlatform[platform] = new Set(
      effective(platform)
        .map(({ command }) => command)
        .filter((command) => !command.endsWith("!")),
    );
  }
  return byPlatform;
}

// keystrokes -> the set of commands it reaches on a platform, ignoring `native!`
// and the scope it is bound at.
function meaningsByPlatform(platform) {
  const meanings = new Map();
  for (const { keystrokes, command } of effective(platform)) {
    if (command === "native!") continue;
    if (!meanings.has(keystrokes)) meanings.set(keystrokes, new Set());
    meanings.get(keystrokes).add(command);
  }
  return meanings;
}

describe("the core platform keymaps", () => {
  it("keeps win32 and linux identical", () => {
    expect(bindings("win32")).toEqual(bindings("linux"));
  });

  it("binds every command on every platform unless the difference is named", () => {
    const byPlatform = commandsByPlatform();
    const every = new Set(PLATFORMS.flatMap((platform) => [...byPlatform[platform]]));

    for (const command of every) {
      const missing = PLATFORMS.filter((platform) => !byPlatform[platform].has(command));
      if (missing.length === 0) continue;
      const bound = PLATFORMS.filter((platform) => byPlatform[platform].has(command));
      const declared = bound.every((platform) =>
        (PLATFORM_ONLY_COMMANDS[platform] || []).includes(command),
      );
      expect(`${command} is bound only on ${bound.join(", ")}`).toBe(
        declared ? `${command} is bound only on ${bound.join(", ")}` : "bound on every platform",
      );
    }
  });

  it("never gives one keystroke unrelated meanings on different platforms", () => {
    const perPlatform = Object.fromEntries(
      PLATFORMS.map((platform) => [platform, meaningsByPlatform(platform)]),
    );
    const keystrokes = new Set(PLATFORMS.flatMap((platform) => [...perPlatform[platform].keys()]));

    for (const stroke of keystrokes) {
      if (stroke in ALLOWED_KEYSTROKE_DIVERGENCES) continue;
      const meanings = PLATFORMS.map((platform) =>
        [...(perPlatform[platform].get(stroke) || [])].sort().join(", "),
      ).filter(Boolean);
      expect(
        `${stroke}: ${new Set(meanings).size} meaning(s) — ${[...new Set(meanings)].join(" / ")}`,
      ).toBe(`${stroke}: 1 meaning(s) — ${meanings[0]}`);
    }
  });

  it("uses cmdorctrl rather than a raw cmd- binding outside darwin.json", () => {
    for (const name of ["base", "win32", "linux"]) {
      for (const { selector, keystrokes, command } of bindings(name)) {
        // The native-key-bindings block names both spellings deliberately: a
        // stray cmd-left on Linux should reach Chromium too.
        if (selector.includes("native-key-bindings")) continue;
        expect(`${name}.json ${keystrokes} -> ${command}`).not.toMatch(/(^|\s|-)(cmd|meta)-/);
      }
    }
  });

  it("writes every keystroke in lowercase and spells shift explicitly", () => {
    for (const name of ["base", ...PLATFORMS]) {
      for (const { keystrokes, command } of bindings(name)) {
        expect(`${name}.json ${keystrokes} -> ${command}`).toBe(
          keystrokes === keystrokes.toLowerCase()
            ? `${name}.json ${keystrokes} -> ${command}`
            : `${name}.json write every key in lowercase and spell shift explicitly`,
        );
      }
    }
  });

  it("uses no !important, which buys +1 specificity and nothing else", () => {
    // `key-binding.js` strips !important from the selector but scores the
    // unstripped string, so the token counts as a phantom element. A binding
    // that needs to win should say so with a real selector.
    for (const name of ["base", ...PLATFORMS]) {
      for (const { selector } of bindings(name)) {
        expect(selector).not.toContain("!important");
      }
    }
  });

  it("declares no selector twice in one file", () => {
    // A repeated key is not an error in JSON — the last one silently wins and
    // the earlier block disappears.
    for (const name of ["base", ...PLATFORMS]) {
      const source = require("fs").readFileSync(path.join(keymapDir, `${name}.json`), "utf8");
      const declared = [...source.matchAll(/^ {2}"([^"]+)":\s*\{/gm)].map((match) => match[1]);
      expect(declared.length).toBe(new Set(declared).size);
    }
  });
});
