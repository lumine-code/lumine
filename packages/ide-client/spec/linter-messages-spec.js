const path = require("path");
const C = require("../lib/converters");
const { toLinterMessages } = require("../lib/linter-messages");

describe("LSP diagnostics linter mapping", () => {
  it("maps diagnostics to linter.registry messages", () => {
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

  describe("severity", () => {
    const mapped = (diagnostic) => {
      const filePath = path.resolve("project", "main.ts");
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      const { messages } = toLinterMessages(C.pathToUri(filePath), [
        { range, message: "m", ...diagnostic },
      ]);
      return messages[0];
    };

    it("maps every LSP severity onto its linter tier", () => {
      expect([1, 2, 3, 4].map((severity) => mapped({ severity }).severity)).toEqual([
        "error",
        "warning",
        "info",
        "hint",
      ]);
    });

    // LSP leaves an omitted severity to the client, and a server that says
    // nothing is not saying "minor".
    it("treats a diagnostic with no severity as an error", () => {
      expect(mapped({}).severity).toBe("error");
    });

    // Guards a future protocol addition from silently arriving as a hint.
    it("treats an unknown severity as an error", () => {
      expect(mapped({ severity: 5 }).severity).toBe("error");
    });
  });

  describe("tags", () => {
    const tagsOf = (tags) => {
      const filePath = path.resolve("project", "main.ts");
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
      const { messages } = toLinterMessages(C.pathToUri(filePath), [
        { range, message: "m", severity: 4, tags },
      ]);
      return messages[0].tags;
    };

    it("maps LSP DiagnosticTag onto the contract names", () => {
      expect(tagsOf([1])).toEqual(["unnecessary"]);
      expect(tagsOf([2])).toEqual(["deprecated"]);
      expect(tagsOf([1, 2])).toEqual(["unnecessary", "deprecated"]);
    });

    it("omits the field when there is nothing to say", () => {
      expect(tagsOf(undefined)).toBeUndefined();
      expect(tagsOf([])).toBeUndefined();
      expect(tagsOf([99])).toBeUndefined();
    });

    it("keeps the known tags when an unknown one rides along", () => {
      expect(tagsOf([2, 99])).toEqual(["deprecated"]);
    });
  });

  it("returns an empty batch to clear stale messages", () => {
    const filePath = path.resolve("project", "main.py");
    expect(toLinterMessages(C.pathToUri(filePath), [])).toEqual({
      filePath,
      messages: [],
    });
  });
});
