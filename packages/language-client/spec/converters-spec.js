const path = require("path");
const C = require("../lib/converters");

describe("language-client converters", () => {
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
});
