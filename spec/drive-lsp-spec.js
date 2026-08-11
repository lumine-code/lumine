const path = require("path");
const {
  assertExpectation,
  assertResult,
  normalizeManifest,
  rendererExpression,
  valuesAtPath,
} = require("../script/drive-lsp");

describe("drive LSP conformance support", () => {
  const manifestPath = path.join(__dirname, "fixtures", "lsp", "matrix.json");

  it("validates and resolves a conformance manifest", () => {
    const manifest = normalizeManifest(
      {
        adapter: "ide-example",
        project: "project",
        file: "project/example.txt",
        checks: [{ name: "hover", method: "textDocument/hover" }],
      },
      manifestPath,
    );
    expect(manifest.timeout).toBe(30000);
    expect(manifest.project).toBe(path.join(path.dirname(manifestPath), "project"));
    expect(manifest.file).toBe(path.join(path.dirname(manifestPath), "project", "example.txt"));
  });

  it("rejects incomplete and duplicate checks", () => {
    expect(() => normalizeManifest({ adapter: "ide-example", checks: [] }, manifestPath)).toThrow();
    expect(() =>
      normalizeManifest(
        {
          adapter: "ide-example",
          checks: [
            { name: "same", kind: "restart" },
            { name: "same", method: "textDocument/hover" },
          ],
        },
        manifestPath,
      ),
    ).toThrowError(/duplicate check name/);
  });

  it("reads ordinary and wildcard result paths", () => {
    const value = { items: [{ label: "one" }, { label: "two" }] };
    expect(valuesAtPath(value, "items.0.label")).toBe("one");
    expect(valuesAtPath(value, "items.*.label")).toEqual(["one", "two"]);
  });

  it("asserts result types, sizes, inclusion and patterns", () => {
    const value = { items: [{ label: "FROM" }, { label: "WHERE" }] };
    expect(() =>
      assertExpectation("completion", value, {
        path: "items.*.label",
        type: "array",
        minLength: 2,
        includes: "FROM",
        matches: "WHERE",
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectation("completion", value, { path: "items.*.label", includes: "SELECT" }),
    ).toThrowError(/does not include/);
  });

  it("builds a self-contained asynchronous renderer expression", () => {
    const manifest = {
      adapter: "ide-example",
      timeout: 1000,
      config: { "ide-example.features.hover": true },
      checks: [
        {
          name: "resolve",
          method: "completionItem/resolve",
          paramsFrom: {
            $: {
              check: "completion",
              path: "$",
              find: { path: "label", equals: "RUN" },
            },
          },
        },
      ],
    };
    const expression = rendererExpression(manifest);
    expect(expression).toContain("async function runInRenderer");
    expect(expression).toContain('"adapter":"ide-example"');
    expect(expression).toContain('"ide-example.features.hover":true');
    expect(expression).toContain('"find":{"path":"label","equals":"RUN"}');
  });

  it("matches every named renderer result against the manifest", () => {
    const manifest = {
      adapter: "ide-example",
      checks: [
        {
          name: "symbols",
          method: "textDocument/documentSymbol",
          expect: { type: "array", minLength: 1 },
        },
        {
          name: "restart",
          kind: "restart",
          expect: { path: "current", equals: "running" },
        },
      ],
    };
    expect(
      assertResult(manifest, {
        adapter: "ide-example",
        state: "running",
        results: [
          { name: "symbols", value: [{ name: "Example" }] },
          { name: "restart", value: { previous: "stopped", current: "running" } },
        ],
      }),
    ).toEqual(["symbols", "restart"]);
  });
});
