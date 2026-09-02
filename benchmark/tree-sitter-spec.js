const CSON = require("@lumine-code/season");
const GrammarRegistry = require("../src/grammar-registry");
const TextBuffer = require("../src/text-buffer");
const { Point } = TextBuffer;
const TreeSitterGrammar = require("../src/tree-sitter-grammar");
const TreeSitterLanguageMode = require("../src/tree-sitter-language-mode");
const luminePackage = require("../package.json");

const jsGrammarPath = require.resolve("language-javascript/grammars/javascript.json");
const htmlGrammarPath = require.resolve("language-html/grammars/html.json");

const RUNS = Number(process.env.LUMINE_TREE_SITTER_BENCHMARK_RUNS || 5);
const WARMUPS = Number(process.env.LUMINE_TREE_SITTER_BENCHMARK_WARMUPS || 2);
const LINES = Number(process.env.LUMINE_TREE_SITTER_BENCHMARK_LINES || 4000);
const CANDIDATES = Number(process.env.LUMINE_TREE_SITTER_BENCHMARK_CANDIDATES || 20000);
const INJECTION_LAYERS = Number(process.env.LUMINE_TREE_SITTER_BENCHMARK_LAYERS || 500);

function sourceLines(count) {
  return Array.from({ length: count }, (_, index) => {
    return `const value${index} = source${index} + ${index};`;
  }).join("\n");
}

function htmlSource(count) {
  return `<main>\n<script>\n${sourceLines(count)}\n</script>\n</main>`;
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samplesMs: samples,
  };
}

async function measure(run) {
  for (let i = 0; i < WARMUPS; i++) await run(i);
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await run(i + WARMUPS);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

async function measureWithObservation(run) {
  for (let i = 0; i < WARMUPS; i++) await run(i);
  const totalSamples = [];
  const observedSamples = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    observedSamples.push(await run(i + WARMUPS));
    totalSamples.push(performance.now() - start);
  }
  return {
    total: summarize(totalSamples),
    observed: summarize(observedSamples),
  };
}

async function createMode(text, grammar, grammars) {
  const buffer = new TextBuffer(text);
  const languageMode = new TreeSitterLanguageMode({
    buffer,
    grammar,
    grammars,
    config: lumine.config,
  });
  buffer.setLanguageMode(languageMode);
  await languageMode.ready;
  return { buffer, languageMode };
}

function destroyMode({ buffer, languageMode }) {
  languageMode.destroy();
  buffer.destroy();
}

function drainHighlightIterator(languageMode) {
  const iterator = languageMode.buildHighlightIterator();
  let checksum = iterator.seek(Point.ZERO, languageMode.buffer.getLastRow()).length;
  while (!iterator.getPosition().isEqual(Point.INFINITY)) {
    checksum += iterator.getOpenScopeIds().length * 3;
    checksum += iterator.getCloseScopeIds().length * 5;
    checksum += iterator.getPosition().row + iterator.getPosition().column;
    iterator.moveToSuccessor();
  }
  return checksum;
}

describe("Tree-sitter benchmark", () => {
  it("measures parse, incremental update, injection reuse, and highlighting", async () => {
    jasmine.useRealClock();

    const grammars = new GrammarRegistry({ config: lumine.config });
    const jsConfig = { ...CSON.readFileSync(jsGrammarPath), injectionNames: ["javascript"] };
    const htmlConfig = CSON.readFileSync(htmlGrammarPath);
    const jsGrammar = new TreeSitterGrammar(grammars, jsGrammarPath, jsConfig);
    const candidateGrammar = new TreeSitterGrammar(grammars, jsGrammarPath, jsConfig);
    const layerGrammar = new TreeSitterGrammar(grammars, jsGrammarPath, jsConfig);
    const htmlGrammar = new TreeSitterGrammar(grammars, htmlGrammarPath, htmlConfig);
    htmlGrammar.addInjectionPoint({
      type: "script_element",
      language: () => "javascript",
      content: (node) => node.child(1),
    });
    let candidateVisits = 0;
    candidateGrammar.addInjectionPoint({
      type: "identifier",
      language() {
        candidateVisits++;
      },
      content: (node) => node,
    });
    layerGrammar.addInjectionPoint({
      type: "identifier",
      language: () => "html",
      content: (node) => node,
      includeChildren: true,
      languageScope: null,
    });
    const registrations = [grammars.addGrammar(jsGrammar), grammars.addGrammar(htmlGrammar)];

    await Promise.all([
      jsGrammar.getLanguage(),
      candidateGrammar.getLanguage(),
      layerGrammar.getLanguage(),
      htmlGrammar.getLanguage(),
    ]);
    await Promise.all(
      [jsGrammar, htmlGrammar].flatMap((grammar) =>
        ["highlightsQuery", "foldsQuery", "indentsQuery", "localsQuery", "tagsQuery"]
          .filter((queryType) => grammar[queryType])
          .map((queryType) => grammar.getQuery(queryType)),
      ),
    );

    const jsSource = sourceLines(LINES);
    const candidateSource = Array.from({ length: CANDIDATES }, (_, index) => `v${index};`).join("");
    const layerSource = Array.from({ length: INJECTION_LAYERS }, (_, index) => `v${index};`).join(
      "",
    );
    const layerRoutingPrefix = "/*head-x*/";
    const layerRoutingSuffix = "/*tail-x*/";
    const layerRoutingSource = `${layerRoutingPrefix}${layerSource}${layerRoutingSuffix}`;
    const headEditColumn = layerRoutingPrefix.indexOf("x");
    const tailEditColumn =
      layerRoutingPrefix.length + layerSource.length + layerRoutingSuffix.indexOf("x");
    const initialParse = await measure(async () => {
      const mode = await createMode(jsSource, jsGrammar, grammars);
      expect(mode.languageMode.tree.rootNode.hasError).toBe(false);
      destroyMode(mode);
    });

    const incrementalMode = await createMode(jsSource, jsGrammar, grammars);
    let incrementalToggle = false;
    const incrementalEdit = await measure(async () => {
      incrementalToggle = !incrementalToggle;
      incrementalMode.buffer.setTextInRange(
        [
          [Math.floor(LINES / 2), 6],
          [Math.floor(LINES / 2), 7],
        ],
        incrementalToggle ? "w" : "v",
      );
      const transaction = await incrementalMode.languageMode.atTransactionEnd();
      expect(transaction.parseError).toBeNull();
    });

    const injectedLines = Math.max(1, Math.floor(LINES / 2));
    const injectionMode = await createMode(htmlSource(injectedLines), htmlGrammar, grammars);
    const originalInjectionLayer = injectionMode.languageMode.getAllInjectionLayers()[0];
    expect(originalInjectionLayer).toBeDefined();
    let injectionToggle = false;
    const injectionEdit = await measure(async () => {
      injectionToggle = !injectionToggle;
      injectionMode.buffer.setTextInRange(
        [
          [2 + Math.floor(injectedLines / 2), 6],
          [2 + Math.floor(injectedLines / 2), 7],
        ],
        injectionToggle ? "w" : "v",
      );
      await injectionMode.languageMode.atTransactionEnd();
      expect(injectionMode.languageMode.getAllInjectionLayers()[0]).toBe(originalInjectionLayer);
    });

    const highlightMode = await createMode(jsSource, jsGrammar, grammars);
    let highlightChecksum = 0;
    const highlighting = await measure(async () => {
      const checksum = drainHighlightIterator(highlightMode.languageMode);
      expect(checksum).toBeGreaterThan(0);
      highlightChecksum = checksum;
    });

    const denseInjectionPipeline = await measure(async () => {
      candidateVisits = 0;
      const mode = await createMode(candidateSource, candidateGrammar, grammars);
      expect(candidateVisits).toBe(CANDIDATES);
      destroyMode(mode);
    });

    const denseInjectionLayers = await measure(async () => {
      const mode = await createMode(layerSource, layerGrammar, grammars);
      const injectionLayers = mode.languageMode.getAllInjectionLayers();
      expect(injectionLayers.length).toBe(INJECTION_LAYERS);
      expect(injectionLayers.every((layer) => layer.tree !== null)).toBe(true);
      destroyMode(mode);
    });

    const routingProbe = await createMode(layerRoutingSource, layerGrammar, grammars);
    const routingProbeLayers = routingProbe.languageMode.getAllInjectionLayers();
    const handleTextChangeSpies = routingProbeLayers.map((layer) =>
      spyOn(layer, "handleTextChange").and.callThrough(),
    );
    const childTreeEditSpies = routingProbeLayers.map((layer) =>
      spyOn(layer.tree, "edit").and.callThrough(),
    );

    routingProbe.buffer.setTextInRange(
      [
        [0, tailEditColumn],
        [0, tailEditColumn + 1],
      ],
      "y",
    );
    await routingProbe.languageMode.atTransactionEnd();
    expect(handleTextChangeSpies.reduce((count, spy) => count + spy.calls.count(), 0)).toBe(0);
    expect(childTreeEditSpies.reduce((count, spy) => count + spy.calls.count(), 0)).toBe(0);

    for (const spy of [...handleTextChangeSpies, ...childTreeEditSpies]) spy.calls.reset();
    routingProbe.buffer.setTextInRange(
      [
        [0, headEditColumn],
        [0, headEditColumn + 1],
      ],
      "y",
    );
    await routingProbe.languageMode.atTransactionEnd();
    expect(handleTextChangeSpies.reduce((count, spy) => count + spy.calls.count(), 0)).toBe(
      INJECTION_LAYERS,
    );
    expect(childTreeEditSpies.reduce((count, spy) => count + spy.calls.count(), 0)).toBe(
      INJECTION_LAYERS,
    );
    destroyMode(routingProbe);

    const layerRoutingMode = await createMode(layerRoutingSource, layerGrammar, grammars);
    let lastRoutingDuration = 0;
    const routeBufferChange = layerRoutingMode.languageMode.bufferDidChange.bind(
      layerRoutingMode.languageMode,
    );
    layerRoutingMode.languageMode.bufferDidChange = (change) => {
      const start = performance.now();
      try {
        return routeBufferChange(change);
      } finally {
        lastRoutingDuration = performance.now() - start;
      }
    };
    let trailingRoutingToggle = false;
    const trailingSiblingInjectionMeasurement = await measureWithObservation(async () => {
      trailingRoutingToggle = !trailingRoutingToggle;
      layerRoutingMode.buffer.setTextInRange(
        [
          [0, tailEditColumn],
          [0, tailEditColumn + 1],
        ],
        trailingRoutingToggle ? "y" : "x",
      );
      await layerRoutingMode.languageMode.atTransactionEnd();
      expect(layerRoutingMode.languageMode.getAllInjectionLayers().length).toBe(INJECTION_LAYERS);
      return lastRoutingDuration;
    });

    let leadingRoutingToggle = false;
    const leadingSiblingInjectionMeasurement = await measureWithObservation(async () => {
      leadingRoutingToggle = !leadingRoutingToggle;
      layerRoutingMode.buffer.setTextInRange(
        [
          [0, headEditColumn],
          [0, headEditColumn + 1],
        ],
        leadingRoutingToggle ? "y" : "x",
      );
      await layerRoutingMode.languageMode.atTransactionEnd();
      expect(layerRoutingMode.languageMode.getAllInjectionLayers().length).toBe(INJECTION_LAYERS);
      return lastRoutingDuration;
    });
    const trailingSiblingInjectionEdit = trailingSiblingInjectionMeasurement.total;
    const trailingSiblingInjectionRouting = trailingSiblingInjectionMeasurement.observed;
    const leadingSiblingInjectionEdit = leadingSiblingInjectionMeasurement.total;
    const leadingSiblingInjectionRouting = leadingSiblingInjectionMeasurement.observed;

    console.log(
      `TREE_SITTER_BENCHMARK=${JSON.stringify({
        runtime: {
          electron: process.versions.electron,
          node: process.versions.node,
          webTreeSitter: luminePackage.dependencies["web-tree-sitter"],
        },
        input: {
          lines: LINES,
          bytes: Buffer.byteLength(jsSource),
          candidates: CANDIDATES,
          candidateBytes: Buffer.byteLength(candidateSource),
          injectionLayers: INJECTION_LAYERS,
          injectionLayerBytes: Buffer.byteLength(layerSource),
          injectionRoutingBytes: Buffer.byteLength(layerRoutingSource),
          runs: RUNS,
          warmups: WARMUPS,
        },
        checksums: { highlighting: highlightChecksum },
        metrics: {
          initialParse,
          incrementalEdit,
          injectionEdit,
          denseInjectionPipeline,
          denseInjectionLayers,
          trailingSiblingInjectionEdit,
          trailingSiblingInjectionRouting,
          leadingSiblingInjectionEdit,
          leadingSiblingInjectionRouting,
          highlighting,
        },
      })}`,
    );

    destroyMode(incrementalMode);
    destroyMode(injectionMode);
    destroyMode(highlightMode);
    destroyMode(layerRoutingMode);
    for (const registration of registrations) registration.dispose();
    jsGrammar.deactivate();
    candidateGrammar.deactivate();
    layerGrammar.deactivate();
    htmlGrammar.deactivate();
    grammars.clear();
  }, 120000);
});
