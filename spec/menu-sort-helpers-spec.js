const { sortMenuItems } = require("../src/menu-sort-helpers");

describe("contextMenu", () => {
  describe("preserves submenus", () => {
    it("preserves existing submenus", () => {
      const items = [{ submenu: [] }];
      expect(sortMenuItems(items)).toEqual(items);
    });
  });

  describe("dedupes separators", () => {
    it("trims leading separators", () => {
      const items = [{ type: "separator" }, { command: "core:one" }];
      const expected = [{ command: "core:one" }];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("preserves separators at the beginning of set two", () => {
      const items = [{ command: "core:one" }, { type: "separator" }, { command: "core:two" }];
      const expected = [{ command: "core:one" }, { type: "separator" }, { command: "core:two" }];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("trims trailing separators", () => {
      const items = [{ command: "core:one" }, { type: "separator" }];
      const expected = [{ command: "core:one" }];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("removes duplicate separators across sets", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { type: "separator" },
        { command: "core:two" },
      ];
      const expected = [{ command: "core:one" }, { type: "separator" }, { command: "core:two" }];
      expect(sortMenuItems(items)).toEqual(expected);
    });
  });

  describe("can move an item to a different group by merging groups", () => {
    it("can move a group of one item", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two" },
        { type: "separator" },
        { command: "core:three", after: ["core:one"] },
        { type: "separator" },
      ];
      const expected = [
        { command: "core:one" },
        { command: "core:three", after: ["core:one"] },
        { type: "separator" },
        { command: "core:two" },
      ];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("moves all items in the moving item's group", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two" },
        { type: "separator" },
        { command: "core:three", after: ["core:one"] },
        { command: "core:four" },
        { type: "separator" },
      ];
      const expected = [
        { command: "core:one" },
        { command: "core:three", after: ["core:one"] },
        { command: "core:four" },
        { type: "separator" },
        { command: "core:two" },
      ];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("ignores positions relative to commands that don't exist", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two" },
        { type: "separator" },
        { command: "core:three", after: ["core:does-not-exist"] },
        { command: "core:four", after: ["core:one"] },
        { type: "separator" },
      ];
      const expected = [
        { command: "core:one" },
        { command: "core:three", after: ["core:does-not-exist"] },
        { command: "core:four", after: ["core:one"] },
        { type: "separator" },
        { command: "core:two" },
      ];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("can handle recursive group merging", () => {
      const items = [
        { command: "core:one", after: ["core:three"] },
        { command: "core:two", before: ["core:one"] },
        { command: "core:three" },
      ];
      const expected = [
        { command: "core:three" },
        { command: "core:two", before: ["core:one"] },
        { command: "core:one", after: ["core:three"] },
      ];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("can merge multiple groups when given a list of before/after commands", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two" },
        { type: "separator" },
        { command: "core:three", after: ["core:one", "core:two"] },
      ];
      const expected = [
        { command: "core:two" },
        { command: "core:one" },
        { command: "core:three", after: ["core:one", "core:two"] },
      ];
      expect(sortMenuItems(items)).toEqual(expected);
    });

    it("can merge multiple groups based on both before/after commands", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two" },
        { type: "separator" },
        { command: "core:three", after: ["core:one"], before: ["core:two"] },
      ];
      const expected = [
        { command: "core:one" },
        { command: "core:three", after: ["core:one"], before: ["core:two"] },
        { command: "core:two" },
      ];
      expect(sortMenuItems(items)).toEqual(expected);
    });
  });

  describe("sorts items within their ultimate group", () => {
    it("does a simple sort", () => {
      const items = [{ command: "core:two", after: ["core:one"] }, { command: "core:one" }];
      expect(sortMenuItems(items)).toEqual([
        { command: "core:one" },
        { command: "core:two", after: ["core:one"] },
      ]);
    });

    it("resolves cycles by ignoring things that conflict", () => {
      const items = [
        { command: "core:two", after: ["core:one"] },
        { command: "core:one", after: ["core:two"] },
      ];
      expect(sortMenuItems(items)).toEqual([
        { command: "core:one", after: ["core:two"] },
        { command: "core:two", after: ["core:one"] },
      ]);
    });
  });

  describe("sorts groups", () => {
    it("does a simple sort", () => {
      const items = [
        { command: "core:two", afterGroupContaining: ["core:one"] },
        { type: "separator" },
        { command: "core:one" },
      ];
      expect(sortMenuItems(items)).toEqual([
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two", afterGroupContaining: ["core:one"] },
      ]);
    });

    it("resolves cycles by ignoring things that conflict", () => {
      const items = [
        { command: "core:two", afterGroupContaining: ["core:one"] },
        { type: "separator" },
        { command: "core:one", afterGroupContaining: ["core:two"] },
      ];
      expect(sortMenuItems(items)).toEqual([
        { command: "core:one", afterGroupContaining: ["core:two"] },
        { type: "separator" },
        { command: "core:two", afterGroupContaining: ["core:one"] },
      ]);
    });

    it("ignores references to commands that do not exist", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        {
          command: "core:two",
          afterGroupContaining: ["core:does-not-exist"],
        },
      ];
      expect(sortMenuItems(items)).toEqual([
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two", afterGroupContaining: ["core:does-not-exist"] },
      ]);
    });

    it("only respects the first matching [before|after]GroupContaining rule in a given group", () => {
      const items = [
        { command: "core:one" },
        { type: "separator" },
        { command: "core:three", beforeGroupContaining: ["core:one"] },
        { command: "core:four", afterGroupContaining: ["core:two"] },
        { type: "separator" },
        { command: "core:two" },
      ];
      expect(sortMenuItems(items)).toEqual([
        { command: "core:three", beforeGroupContaining: ["core:one"] },
        { command: "core:four", afterGroupContaining: ["core:two"] },
        { type: "separator" },
        { command: "core:one" },
        { type: "separator" },
        { command: "core:two" },
      ]);
    });
  });

  describe("positions items by explicit id", () => {
    it("merges a group before a commandless submenu", () => {
      const terminal = { id: "tree:terminal", label: "Terminal", submenu: [] };
      const search = { command: "tree:search", before: [{ id: "tree:terminal" }] };
      const items = [terminal, { type: "separator" }, search];

      expect(sortMenuItems(items)).toEqual([search, terminal]);
    });

    it("orders commandless submenus within their group", () => {
      const publish = { id: "tree:publish", submenu: [], after: [{ id: "tree:terminal" }] };
      const terminal = { id: "tree:terminal", submenu: [] };

      expect(sortMenuItems([publish, terminal])).toEqual([terminal, publish]);
    });

    it("orders separate groups around commandless submenus", () => {
      const paths = { command: "tree:paths", afterGroupContaining: [{ id: "tree:publish" }] };
      const publish = {
        id: "tree:publish",
        submenu: [],
        afterGroupContaining: [{ id: "tree:terminal" }],
      };
      const search = {
        command: "tree:search",
        beforeGroupContaining: [{ id: "tree:terminal" }],
      };
      const terminal = { id: "tree:terminal", submenu: [] };
      const separator = { type: "separator" };

      expect(
        sortMenuItems([paths, separator, publish, separator, terminal, separator, search]),
      ).toEqual([search, separator, terminal, separator, publish, separator, paths]);
    });

    it("uses the first existing id or command in a group fallback list", () => {
      const terminal = { id: "tree:terminal", submenu: [] };
      const files = { command: "tree:files" };
      const publish = {
        id: "tree:publish",
        submenu: [],
        afterGroupContaining: [
          { id: "tree:missing" },
          "tree:missing-command",
          { id: "tree:terminal" },
          "tree:files",
        ],
      };
      const separator = { type: "separator" };

      expect(sortMenuItems([publish, separator, files, separator, terminal])).toEqual([
        terminal,
        separator,
        publish,
        separator,
        files,
      ]);
    });

    it("falls back to a command when the referenced id is missing", () => {
      const terminal = {
        id: "tree:terminal",
        submenu: [],
        afterGroupContaining: [{ id: "tree:missing" }, "tree:files"],
      };
      const files = { command: "tree:files" };
      const separator = { type: "separator" };

      expect(sortMenuItems([terminal, separator, files])).toEqual([files, separator, terminal]);
    });

    it("ignores missing ids instead of matching another commandless item", () => {
      const files = { command: "tree:files", after: [{ id: "tree:missing" }] };
      const terminal = { submenu: [] };
      const separator = { type: "separator" };
      const items = [files, separator, terminal];

      expect(sortMenuItems(items)).toEqual(items);
    });

    it("keeps string references command-only even when an id matches", () => {
      const files = { command: "tree:files", after: ["Terminal", "tree:terminal"] };
      const terminal = { id: "tree:terminal", label: "Terminal", submenu: [] };
      const separator = { type: "separator" };
      const items = [files, separator, terminal];

      expect(sortMenuItems(items)).toEqual(items);
    });

    it("distinguishes a command string from an id with the same spelling", () => {
      const files = { command: "tree:files", after: ["tree:terminal"] };
      const command = { command: "tree:terminal" };
      const submenu = { id: "tree:terminal", submenu: [] };
      const separator = { type: "separator" };

      expect(sortMenuItems([files, separator, command, separator, submenu])).toEqual([
        command,
        files,
        separator,
        submenu,
      ]);
    });

    it("never resolves an id reference against a command with the same spelling", () => {
      const files = { command: "tree:files", afterGroupContaining: [{ id: "tree:terminal" }] };
      const terminalCommand = { command: "tree:terminal" };
      const separator = { type: "separator" };
      const items = [files, separator, terminalCommand];

      expect(sortMenuItems(items)).toEqual(items);
    });

    it("breaks id-reference cycles in the same way as command-reference cycles", () => {
      const first = { id: "tree:first", submenu: [], after: [{ id: "tree:second" }] };
      const second = { id: "tree:second", submenu: [], after: [{ id: "tree:first" }] };

      expect(sortMenuItems([first, second])).toEqual([second, first]);
    });
  });
});
