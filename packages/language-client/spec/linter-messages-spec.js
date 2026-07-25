const path = require("path");
const C = require("../lib/converters");
const { toLinterMessages } = require("../lib/linter-messages");

describe("LSP diagnostics linter mapping", () => {
  it("maps diagnostics to linter-indie messages", () => {
    const filePath = path.resolve("project", "main.ts");
    const result = toLinterMessages(C.pathToUri(filePath), [
      {
        range: { start: { line: 2, character: 3 }, end: { line: 2, character: 7 } },
        severity: 1,
        message: "Unknown name",
        source: "typescript",
        code: 2304,
        codeDescription: { href: "https://example.test/2304" },
      },
    ]);
    expect(result.filePath).toBe(filePath);
    expect(result.messages[0]).toEqual(
      jasmine.objectContaining({
        severity: "error",
        excerpt: "Unknown name",
        description: "typescript: 2304",
        url: "https://example.test/2304",
        location: {
          file: filePath,
          position: [
            [2, 3],
            [2, 7],
          ],
        },
      }),
    );
  });

  it("returns an empty batch to clear stale messages", () => {
    const filePath = path.resolve("project", "main.py");
    expect(toLinterMessages(C.pathToUri(filePath), [])).toEqual({
      filePath,
      messages: [],
    });
  });
});
