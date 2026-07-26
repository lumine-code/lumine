const path = require("path");
const C = require("../lib/converters");

describe("ide-client converters", () => {
  it("round trips file paths through encoded file URIs", () => {
    const filePath = path.resolve("a folder", "file #1.ts");
    expect(C.uriToPath(C.pathToUri(filePath))).toBe(filePath);
  });
  it("converts editor and protocol ranges", () => {
    const range = { start: { row: 1, column: 2 }, end: { row: 3, column: 4 } };
    expect(C.rangeFromLsp(C.rangeToLsp(range))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
  it("maps every LSP completion kind, unshifted", () => {
    // The kinds that used to be shifted by one: 20 read as "constant",
    // 21 as "struct", 22 as "event".
    expect(C.completionKind(20)).toBe("enum-member");
    expect(C.completionKind(21)).toBe("constant");
    expect(C.completionKind(22)).toBe("struct");
    expect(C.completionKind(23)).toBe("event");
    expect(C.completionKind(25)).toBe("type-parameter");
    // And the seven that were missing entirely.
    for (const kind of [1, 11, 16, 18, 19, 24]) {
      expect(C.completionKind(kind)).not.toBe("value");
    }
    // Every kind in the 3.17 table resolves to a distinct name.
    const names = [];
    for (let kind = 1; kind <= 25; kind++) names.push(C.completionKind(kind));
    expect(new Set(names).size).toBe(25);
  });
});
