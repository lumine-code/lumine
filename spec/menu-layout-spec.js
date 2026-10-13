const menuLayout = require("../src/menu-layout");
const { sortMenuItems } = require("../src/menu-sort-helpers");

describe("named menu groups", () => {
  const labels = (items) => items.map((item) => item.label ?? item.type);
  const file = {
    groupOrder: ["new", "open", "extensions", "close", "quit"],
  };
  const items = [
    { label: "Exit", command: "quit", group: "quit", order: 10 },
    { label: "Close Tab", command: "close", group: "close", order: 10 },
    { label: "Open File", command: "open", group: "open", order: 10 },
    { label: "New File", command: "new", group: "new", order: 10 },
  ];

  it("places ordered contributions before Close and Exit regardless of activation order", () => {
    const contributed = [
      { label: "New Terminal", group: "new", order: 60 },
      { label: "Browse Files", group: "open", order: 20 },
      { label: "Unknown Extension" },
    ];
    const expected = [
      "New File",
      "New Terminal",
      "separator",
      "Open File",
      "Browse Files",
      "separator",
      "Unknown Extension",
      "separator",
      "Close Tab",
      "separator",
      "Exit",
    ];
    expect(labels(menuLayout([...items, ...contributed], file))).toEqual(expected);
    expect(labels(menuLayout([...contributed.toReversed(), ...items.toReversed()], file))).toEqual(
      expected,
    );
  });

  it("omits empty and invisible groups without retaining separator edges", () => {
    const template = [
      { label: "One", group: "new" },
      { label: "Hidden", group: "open", visible: false },
      { label: "Empty", group: "close", submenu: [] },
      { type: "separator" },
    ];
    expect(labels(menuLayout(template, file))).toEqual(["One"]);
    expect(menuLayout([], file)).toEqual([]);
    expect(
      menuLayout([{ label: "Services", submenu: [], role: "services", group: "new" }], file),
    ).toEqual([{ label: "Services", submenu: [], role: "services" }]);
  });

  it("strips layout metadata recursively without modifying authored definitions", () => {
    const input = [
      {
        label: "Menu",
        groupOrder: ["a", "b"],
        submenu: [
          { label: "B", group: "b", order: 10 },
          { label: "A", group: "a", order: 10 },
        ],
      },
    ];
    const before = JSON.stringify(input);
    expect(menuLayout(input)).toEqual([
      { label: "Menu", submenu: [{ label: "A" }, { type: "separator" }, { label: "B" }] },
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps recent projects and package action sequences in authored order", () => {
    const recent = [
      { label: "Zulu", command: "reopen", commandDetail: { path: "z" } },
      { label: "Alpha", command: "reopen", commandDetail: { path: "a" } },
    ];
    expect(menuLayout(recent)).toEqual(recent);
    expect(labels(menuLayout([{ label: "Run" }, { label: "Configure" }]))).toEqual([
      "Run",
      "Configure",
    ]);
  });

  it("combines contextual named groups while preserving legacy fenced extension blocks", () => {
    const template = [
      { label: "Close", group: "close" },
      { type: "separator" },
      { label: "Second", after: ["first"] },
      { type: "separator" },
      { label: "First", command: "first" },
      { type: "separator" },
      { label: "Paste", group: "clipboard", order: 30 },
      { label: "Copy", group: "clipboard", order: 20 },
    ];
    expect(
      labels(
        menuLayout(template, {
          groupOrder: ["clipboard", "extensions", "close"],
          sortItems: sortMenuItems,
          preserveUngrouped: true,
        }),
      ),
    ).toEqual(["Copy", "Paste", "separator", "First", "Second", "separator", "Close"]);
  });
});
