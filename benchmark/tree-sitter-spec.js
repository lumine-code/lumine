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

async function measure(run) {
  for (let i = 0; i < WARMUPS; i++) await run(i);
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await run(i + WARMUPS);
    samples.push(performance.now() - start);
  }
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samplesMs: samples,
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
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 120000;

    const grammars = new GrammarRegistry({ config: lumine.config });
    const jsConfig = { ...CSON.readFileSync(jsGrammarPath), injectionNames: ["javascript"] };
    const htmlConfig = CSON.readFileSync(htmlGrammarPath);
    const jsGrammar = new TreeSitterGrammar(grammars, jsGrammarPath, jsConfig);
    const candidateGrammar = new TreeSitterGrammar(grammars, jsGrammarPath, jsConfig);
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
    const registrations = [grammars.addGrammar(jsGrammar), grammars.addGrammar(htmlGrammar)];

    await Promise.all([
      jsGrammar.getLanguage(),
      candidateGrammar.getLanguage(),
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
          runs: RUNS,
          warmups: WARMUPS,
        },
        checksums: { highlighting: highlightChecksum },
        metrics: {
          initialParse,
          incrementalEdit,
          injectionEdit,
          denseInjectionPipeline,
          highlighting,
        },
      })}`,
    );

    destroyMode(incrementalMode);
    destroyMode(injectionMode);
    destroyMode(highlightMode);
    for (const registration of registrations) registration.dispose();
    jsGrammar.deactivate();
    candidateGrammar.deactivate();
    htmlGrammar.deactivate();
    grammars.clear();
  });
});
