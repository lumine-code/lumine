const crypto = require("crypto");
const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");

// Manual diagnostic: identical parsers, highlighting and source are compared
// with warm languages/queries. Timings include complete injection settlement;
// semantic checks run outside the timers and no latency threshold is asserted.
// Optional JSON: LUMINE_STATIC_INJECTION_BENCHMARK_CONFIG={"sizes":[100,1000],"samples":5,"warmups":2}
const CONFIG = JSON.parse(process.env.LUMINE_STATIC_INJECTION_BENCHMARK_CONFIG || "{}");
const SIZES = CONFIG.sizes ?? [100, 1000];
const SAMPLES = CONFIG.samples ?? 5;
const WARMUPS = CONFIG.warmups ?? 2;
const now = () => Number(process.hrtime.bigint()) / 1e6;

const CASES = [
  {
    name: "html-script",
    host: ["language-html", "html.json"],
    child: ["language-javascript", "javascript.json"],
    alias: "benchmark-javascript",
    source(size) {
      return `<!--head-x-->\n${Array.from({ length: size }, (_, index) => `<section><script>const value${index} = 1;</script></section>`).join("\n")}`;
    },
    point: {
      type: "script_element",
      language: () => "benchmark-javascript",
      content: (node) => node.namedChildren.find((child) => child.type === "raw_text"),
      includeChildren: true,
    },
    query: `((script_element (raw_text) @injection.content) @injection.owner
      (#set! injection.language "benchmark-javascript")
      (#set! injection.include-children "true"))`,
    editToken: "= 1",
    editOffset: 2,
    replacement: "2",
  },
  {
    name: "javascript-selective-template",
    host: ["language-javascript", "javascript.json"],
    child: ["language-html", "html.json"],
    alias: "benchmark-html",
    source(size) {
      return `/*head-x*/\n${Array.from({ length: size }, (_, index) =>
        [
          `const html${index} = html\`<section title="value${index}">\${value${index}}</section>\`;`,
          ...Array.from({ length: 4 }, (_, call) => `other${call}("value${index}");`),
        ].join("\n"),
      ).join("\n")}`;
    },
    point: {
      type: "call_expression",
      language(node) {
        return node.childForFieldName("function")?.text === "html" &&
          node.childForFieldName("arguments")?.type === "template_string"
          ? "benchmark-html"
          : null;
      },
      content: (node) =>
        node
          .childForFieldName("arguments")
          .namedChildren.filter((child) => child.type === "string_fragment"),
      includeChildren: true,
    },
    query: `((call_expression
      function: (identifier) @_tag
      arguments: (template_string (string_fragment) @injection.content)) @injection.owner
      (#eq? @_tag "html")
      (#set! injection.language "benchmark-html")
      (#set! injection.include-children "true"))`,
    editToken: "value0",
    editOffset: 5,
    replacement: "1",
  },
];

function summary(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    samplesMs: values,
  };
}

function checksum(buffer, mode) {
  const hash = crypto.createHash("sha256");
  const add = (value) => hash.update(`${JSON.stringify(value)}\n`);
  add(buffer.getText());
  const layers = mode
    .getAllInjectionLayers()
    .slice()
    .sort((a, b) => a.marker.getRange().compare(b.marker.getRange()));
  add(layers.length);
  add(mode.rootLanguageLayer.tree.rootNode.toString());
  for (const layer of layers) {
    add({
      owner: layer.marker.getRange().serialize(),
      language: layer.grammar.scopeName,
      ranges: layer.getCurrentRanges().map((range) => range.serialize()),
      contents: layer.getCurrentRanges().map((range) => buffer.getTextInRange(range)),
      tree: layer.tree.rootNode.toString(),
    });
  }
  const iterator = mode.buildHighlightIterator();
  add(
    iterator
      .seek(TextBuffer.Point.ZERO, buffer.getLastRow())
      .map((id) => mode.scopeNameForScopeId(id)),
  );
  let boundaries = 0;
  while (!iterator.getPosition().isEqual(TextBuffer.Point.INFINITY)) {
    add([
      iterator.getPosition(),
      iterator.getOpenScopeIds().map((id) => mode.scopeNameForScopeId(id)),
      iterator.getCloseScopeIds().map((id) => mode.scopeNameForScopeId(id)),
    ]);
    boundaries++;
    iterator.moveToSuccessor();
  }
  expect(boundaries).toBeGreaterThan(0);
  return hash.digest("hex");
}

async function variant(scenario, implementation) {
  const registry = new GrammarRegistry({ config: lumine.config });
  const owned = [];
  const registrations = [];
  const load = ([repository, filename], injectionNames) => {
    const file = require.resolve(`${repository}/grammars/${filename}`);
    const original = CSON.readFileSync(file);
    const treeSitter = { ...original.treeSitter };
    delete treeSitter.injectionsQuery;
    const grammar = new TreeSitterGrammar(registry, file, {
      ...original,
      treeSitter,
      injectionNames,
    });
    owned.push(grammar);
    registrations.push(registry.addGrammar(grammar));
    return grammar;
  };
  const host = load(scenario.host, []);
  load(scenario.child, [scenario.alias]);
  try {
    await Promise.all(owned.map((grammar) => grammar.getLanguage()));
    await Promise.all(
      owned
        .filter((grammar) => grammar.queryPaths.highlightsQuery)
        .map((grammar) => grammar.getQuery("highlightsQuery")),
    );
    if (implementation === "scm") await host.setQueryForTest("injectionsQuery", scenario.query);
    else host.addInjectionPoint(scenario.point);
    return {
      host,
      registry,
      dispose() {
        for (const registration of registrations.reverse()) registration.dispose();
        for (const grammar of owned.reverse()) grammar.deactivate();
      },
    };
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose();
    for (const grammar of owned.reverse()) grammar.deactivate();
    throw error;
  }
}

async function runSample(environment, scenario, size) {
  const buffer = new TextBuffer({ text: scenario.source(size) });
  let mode;
  try {
    const started = now();
    mode = new TreeSitterLanguageMode({
      buffer,
      grammar: environment.host,
      grammars: environment.registry,
      config: lumine.config,
    });
    buffer.setLanguageMode(mode);
    await mode.ready;
    await mode.atGrammarSettlement();
    const initialMs = now() - started;
    expect(mode.rootLanguageLayer.tree.rootNode.hasError).toBe(false);
    expect(mode.getAllInjectionLayers().length).toBe(size);
    const semantics = { initial: checksum(buffer, mode) };
    const timings = { initial: initialMs };
    for (const kind of ["inside", "prefix-shift"]) {
      const index =
        kind === "inside"
          ? buffer.getText().indexOf(scenario.editToken) + scenario.editOffset
          : buffer.getText().indexOf("head-x") + 5;
      expect(index).toBeGreaterThanOrEqual(0);
      const range = [
        buffer.positionForCharacterIndex(index),
        buffer.positionForCharacterIndex(index + 1),
      ];
      const original = buffer.getTextInRange(range);
      const replacement = kind === "inside" ? scenario.replacement : "xx";
      const start = now();
      const changed = buffer.setTextInRange(range, replacement);
      const settled = await mode.atTransactionEnd();
      if (settled.parseError) throw settled.parseError;
      timings[kind] = now() - start;
      expect(mode.getAllInjectionLayers().length).toBe(size);
      semantics[kind] = checksum(buffer, mode);
      buffer.setTextInRange(changed, original);
      const restored = await mode.atTransactionEnd();
      if (restored.parseError) throw restored.parseError;
    }
    return { timings, semantics };
  } finally {
    mode?.destroy();
    buffer.destroy();
  }
}

describe("Static versus JavaScript Tree-sitter injection benchmark", () => {
  it("reports settled latency for equivalent owner and fragment semantics", async () => {
    jasmine.useRealClock();
    expect(SIZES.every((size) => Number.isSafeInteger(size) && size > 0)).toBe(true);
    expect(Number.isSafeInteger(SAMPLES) && SAMPLES > 0).toBe(true);
    expect(Number.isSafeInteger(WARMUPS) && WARMUPS >= 0).toBe(true);
    const results = [];
    for (const scenario of CASES) {
      const environments = {
        js: await variant(scenario, "js"),
        scm: await variant(scenario, "scm"),
      };
      try {
        for (const size of SIZES) {
          const samples = { js: [], scm: [] };
          let expected;
          for (let iteration = -WARMUPS; iteration < SAMPLES; iteration++) {
            // Alternate order to reduce a consistent first/second bias.
            for (const implementation of iteration % 2 === 0 ? ["js", "scm"] : ["scm", "js"]) {
              const sample = await runSample(environments[implementation], scenario, size);
              expected ??= sample.semantics;
              expect(sample.semantics)
                .withContext(`${scenario.name}/${size}/${implementation}`)
                .toEqual(expected);
              if (iteration >= 0) samples[implementation].push(sample.timings);
            }
          }
          results.push({
            case: scenario.name,
            owners: size,
            semantics: expected,
            metrics: Object.fromEntries(
              ["js", "scm"].map((implementation) => [
                implementation,
                Object.fromEntries(
                  ["initial", "inside", "prefix-shift"].map((phase) => [
                    phase,
                    summary(samples[implementation].map((sample) => sample[phase])),
                  ]),
                ),
              ]),
            ),
          });
        }
      } finally {
        environments.js.dispose();
        environments.scm.dispose();
      }
    }
    console.log(
      `TREE_SITTER_STATIC_INJECTIONS_BENCHMARK=${JSON.stringify({ runtime: process.versions, config: { sizes: SIZES, samples: SAMPLES, warmups: WARMUPS }, timer: "process.hrtime.bigint; milliseconds; warm languages and queries; full parse settlement; checks outside timers", results })}`,
    );
  }, 3600000);
});
