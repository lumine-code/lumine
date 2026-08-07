const KeymapManager = require("../src/keymap-manager");
const { KeyBinding } = require("../src/key-binding");
const {
  appendContent,
  buildKeydownEvent,
  installHooks,
  mockProcessPlatform,
} = require("./keymap-spec-helpers/helpers");

// `appendContent` takes a node, so build one from markup first.
function build(html) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  return wrapper.firstChild;
}

// The keybinding convention in the workspace CLAUDE.md rests on five facts about
// how a keystroke resolves. None is obvious from reading a keymap file, each one
// decided a real fix in the sweep that wrote the convention, and nothing else
// pins them — so a change to keymap-manager or key-binding that quietly
// invalidates one would leave the convention describing an editor that no longer
// behaves that way.
describe("keymap scope resolution", () => {
  installHooks();

  let keymaps;

  beforeEach(() => {
    mockProcessPlatform("win32");
    keymaps = new KeymapManager();
  });

  afterEach(() => keymaps.destroy());

  function dispatch(element, key, options = {}) {
    const commands = [];
    keymaps.onDidMatchBinding(({ binding }) => commands.push(binding.command));
    keymaps.handleKeyboardEvent(buildKeydownEvent({ key, target: element, ...options }));
    return commands;
  }

  const ctrl = { ctrlKey: true };
  const alt = { altKey: true };

  describe("DOM proximity", () => {
    // findExactMatches does not walk ancestors (keymap-manager.js); the caller
    // walks one element at a time and stops at the first that dispatches. This
    // is why a `body` binding is a fallback rather than a low-priority one, and
    // why a package binding on a panel always wins inside that panel.
    it("beats specificity outright", () => {
      const workspace = appendContent(
        build(`
        <div class="workspace">
          <div class="panel"></div>
        </div>
      `),
      );
      const panel = workspace.querySelector(".panel");

      keymaps.add("shallow-but-specific", {
        ".workspace.workspace": { "ctrl-y": "ancestor:wins-on-specificity" },
      });
      keymaps.add("deep-but-plain", { div: { "ctrl-y": "descendant:wins-on-proximity" } });

      expect(dispatch(panel, "y", ctrl)).toEqual(["descendant:wins-on-proximity"]);
    });

    it("falls back to the ancestor when the element itself has no binding", () => {
      const workspace = appendContent(
        build(`
        <div class="workspace">
          <span class="leaf"></span>
        </div>
      `),
      );

      keymaps.add("ancestor", { ".workspace": { "ctrl-y": "ancestor:only" } });

      expect(dispatch(workspace.querySelector(".leaf"), "y", ctrl)).toEqual(["ancestor:only"]);
    });
  });

  describe("a keystroke that is both a complete binding and a chord prefix", () => {
    // This is the one that costs a visible second, and the reason
    // script/check-keymaps.js exists. The complete match is deliberately not
    // dispatched while a partial match with a keydown remainder is alive.
    it("does not dispatch the complete binding immediately", () => {
      const element = appendContent(build('<div class="surface"></div>'));
      keymaps.add("prefix-and-complete", {
        ".surface": { "alt-g": "panel:toggle-focus", "alt-g o": "elsewhere:open" },
      });

      expect(dispatch(element, "g", alt)).toEqual([]);
      expect(keymaps.pendingPartialMatches).not.toBeNull();
    });

    it("arms a 1000 ms timeout precisely because an exact match exists", () => {
      const element = appendContent(build('<div class="surface"></div>'));
      keymaps.add("prefix-and-complete", {
        ".surface": { "alt-g": "panel:toggle-focus", "alt-g o": "elsewhere:open" },
      });
      dispatch(element, "g", alt);

      expect(keymaps.partialMatchTimeout).toBe(1000);
      expect(keymaps.pendingStateTimeoutHandle).not.toBeNull();
    });

    it("dispatches at once when the remainder is a keyup, which is why ctrl-tab is free of this", () => {
      const element = appendContent(build('<div class="surface"></div>'));
      keymaps.add("keyup-remainder", {
        ".surface": {
          "ctrl-y": "pane:show-next-recently-used-item",
          "ctrl-y ^ctrl": "pane:move-active-item-to-top-of-stack",
        },
      });

      expect(dispatch(element, "y", ctrl)).toEqual(["pane:show-next-recently-used-item"]);
    });
  });

  describe("specificity", () => {
    const specificityOf = (selector) =>
      new KeyBinding("source", "some:command", "ctrl-y", selector).specificity;

    // A .platform-* prefix is a class, and body carries the class, so both match
    // the same element and proximity cannot separate them. The prefixed form
    // wins by an order of magnitude — which is why a package must express a
    // platform difference with a keymaps/<platform>.json file instead.
    it("puts a .platform-* prefix an order of magnitude above core's body", () => {
      expect(specificityOf("body")).toBe(1);
      expect(specificityOf(".platform-win32")).toBe(10);
      expect(specificityOf("atom-text-editor")).toBe(1);
      expect(specificityOf(".platform-win32 atom-text-editor")).toBe(11);
    });

    // key-binding.js strips !important from the selector it matches with but
    // scores the unstripped string, where the token falls through as a phantom
    // element. It is worth +1 and nothing else, and loses to any :not([mini]).
    it("scores !important as one extra element and nothing more", () => {
      expect(specificityOf("atom-text-editor !important")).toBe(
        specificityOf("atom-text-editor") + 1,
      );
      expect(specificityOf("atom-text-editor !important")).toBeLessThan(
        specificityOf("atom-text-editor:not([mini])"),
      );
    });

    it("matches an !important selector as though the token were absent", () => {
      expect(new KeyBinding("source", "c", "ctrl-y", "atom-text-editor !important").selector).toBe(
        "atom-text-editor ",
      );
    });

    // calculateSpecificity truncates at the first comma, so every branch of a
    // comma list is scored as the first one. A list whose branches differ in
    // depth therefore mis-scores all but one of them.
    it("scores a comma list on its first branch only", () => {
      expect(specificityOf("body, .command-palette atom-text-editor")).toBe(specificityOf("body"));
      expect(specificityOf(".command-palette atom-text-editor, body")).toBe(
        specificityOf(".command-palette atom-text-editor"),
      );
    });
  });

  describe("abortKeyBinding", () => {
    // The escape hatch base.json relies on: consolidate-selections yields when
    // there is nothing to consolidate, and the walk carries on to core:cancel.
    it("lets the walk continue to the next binding up", () => {
      const workspace = appendContent(
        build(`
        <div class="workspace">
          <div class="surface"></div>
        </div>
      `),
      );
      const surface = workspace.querySelector(".surface");
      const dispatched = [];

      surface.addEventListener("first:handler", (event) => {
        dispatched.push("first:handler");
        event.abortKeyBinding();
      });
      workspace.addEventListener("second:handler", () => dispatched.push("second:handler"));

      keymaps.add("inner", { ".surface": { escape: "first:handler" } });
      keymaps.add("outer", { ".workspace": { escape: "second:handler" } });
      keymaps.handleKeyboardEvent(buildKeydownEvent({ key: "Escape", target: surface }));

      expect(dispatched).toEqual(["first:handler", "second:handler"]);
    });
  });
});
