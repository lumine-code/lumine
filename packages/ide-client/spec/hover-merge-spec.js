const { mergeHoverValues, splitSections } = require("../lib/hover-merge");

describe("hover merging", () => {
  it("splits fenced blocks and prose into sections", () => {
    const sections = splitSections("intro\n\n```py\nfoo()\n\nbar()\n```\n\ntail");
    // A blank line inside a fence does not end the block.
    expect(sections).toEqual(["intro", "```py\nfoo()\n\nbar()\n```", "tail"]);
  });

  it("keeps everything when servers say different things", () => {
    expect(mergeHoverValues(["the type", "the lint rule"])).toBe(
      "the type\n\n---\n\nthe lint rule",
    );
  });

  it("drops a repeated section but keeps what only one server adds", () => {
    const checker = "```python\n(function) load(path: str) -> str\n```\n\nReads the file.";
    const linter = "```python\n(function) load(path: str) -> str\n```\n\nPLW1514: no encoding.";
    expect(mergeHoverValues([checker, linter])).toBe(
      "```python\n(function) load(path: str) -> str\n```\n\nReads the file.\n\n---\n\nPLW1514: no encoding.",
    );
  });

  it("matches sections across differences in fencing and whitespace", () => {
    // The same signature, once fenced and once as bare prose with padding.
    expect(mergeHoverValues(["```ts\nconst x: number\n```", "const   x:  number"])).toBe(
      "```ts\nconst x: number\n```",
    );
  });

  it("omits a server whose every section was already said", () => {
    expect(mergeHoverValues(["shared", "shared"])).toBe("shared");
  });

  it("treats horizontal rules as section boundaries rather than content", () => {
    expect(mergeHoverValues(["a\n\n---\n\nb", "b"])).toBe("a\n\nb");
  });

  it("ignores empty answers", () => {
    expect(mergeHoverValues([null, "", "only"])).toBe("only");
    expect(mergeHoverValues([])).toBe("");
  });
});
