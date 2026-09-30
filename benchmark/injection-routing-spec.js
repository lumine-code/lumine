const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const os = require("os");
const CSON = require("@lumine-code/season");

const CONFIG = JSON.parse(process.env.LUMINE_INJECTION_ROUTING_CONFIG || "{}");
const SOURCE = CONFIG.source || path.resolve(__dirname, "..");
const sourceRequire = createRequire(path.join(SOURCE, "package.json"));
const GrammarRegistry = sourceRequire("./src/grammar-registry");
const TextBuffer = sourceRequire("./src/text-buffer");
const TreeSitterGrammar = sourceRequire("./src/tree-sitter-grammar");
const TreeSitterLanguageMode = sourceRequire("./src/tree-sitter-language-mode");
const { Point } = TextBuffer;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileHash = (file) => ({ path: file, sha256: sha256(fs.readFileSync(file)) });
const now = () => Number(process.hrtime.bigint()) / 1e6;

function fixture(count) {
  const identifiers = Array.from(
    { length: count },
    (_, index) => `v${String(index).padStart(5, "0")};`,
  );
  const rows = [];
  for (let index = 0; index < identifiers.length; index += 50)
    rows.push(identifiers.slice(index, index + 50).join(""));
  return `/*head-x*/${rows.join("\n")}/*tail-x*/`;
}

function editFor(buffer, kind) {
  let index;
  const oldLength = 1;
  let replacement = "y";
  if (kind === "inside") {
    index = buffer.getText().indexOf("v00000") + 5;
    replacement = "1";
  } else if (kind === "trailing") {
    index = buffer.getText().lastIndexOf("x");
  } else {
    index = buffer.getText().indexOf("x");
    if (kind === "leading-length-changing") replacement = "xx";
  }
  return {
    range: [
      buffer.positionForCharacterIndex(index),
      buffer.positionForCharacterIndex(index + oldLength),
    ],
    replacement,
    original: buffer.getText().slice(index, index + oldLength),
  };
}

async function settle(mode) {
  const transaction = await mode.atTransactionEnd();
  if (transaction.parseError) throw transaction.parseError;
}

// Hash names, geometry and text, never node IDs or scope-allocation IDs. All of
// this work runs after the edit/settle timers, including highlight query drain.
function semanticChecksum(buffer, mode) {
  const hash = crypto.createHash("sha256");
  const add = (value) => hash.update(`${JSON.stringify(value)}\n`);
  const layers = [mode.rootLanguageLayer, ...mode.getAllInjectionLayers()];
  layers.sort(
    (a, b) => a.depth - b.depth || a.getCurrentRanges()[0].compare(b.getCurrentRanges()[0]),
  );
  add(buffer.getText());
  for (const layer of layers) {
    const root = layer.tree?.rootNode;
    if (!root) throw new Error("Missing injection tree after settle");
    add([
      layer.grammar.scopeName,
      layer.depth,
      (layer.getCurrentRanges() || []).map(({ start, end }) => [
        [start.row, start.column],
        [end.row, end.column],
      ]),
      root.toString(),
    ]);
    const cursor = layer.tree.walk();
    try {
      let finished = false;
      while (!finished) {
        const node = cursor.currentNode;
        add([node.type, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
        if (cursor.gotoFirstChild()) continue;
        while (!cursor.gotoNextSibling()) {
          if (!cursor.gotoParent()) {
            finished = true;
            break;
          }
        }
      }
    } finally {
      cursor.delete?.();
    }
  }
  return finishHighlights();

  function finishHighlights() {
    const iterator = mode.buildHighlightIterator();
    add(iterator.seek(Point.ZERO, buffer.getLastRow()).map((id) => mode.scopeNameForScopeId(id)));
    let boundaries = 0;
    while (!iterator.getPosition().isEqual(Point.INFINITY)) {
      add([
        iterator.getPosition(),
        iterator.getOpenScopeIds().map((id) => mode.scopeNameForScopeId(id)),
        iterator.getCloseScopeIds().map((id) => mode.scopeNameForScopeId(id)),
      ]);
      boundaries++;
      iterator.moveToSuccessor();
    }
    if (boundaries === 0) throw new Error("The fixture must produce real highlight boundaries");
    return {
      sha256: hash.digest("hex"),
      layers: layers.length - 1,
      highlightBoundaries: boundaries,
    };
  }
}

function diagnostics(mode) {
  const counts = {
    rootHandleTextChange: 0,
    childHandleTextChange: 0,
    rootTreeEdit: 0,
    childTreeEdit: 0,
    rootParse: 0,
    childParse: 0,
  };
  const cpuMs = { discoverySync: 0, reconcileSync: 0, commitSync: 0 };
  const restorations = [];
  const wrap = (object, key, replacement) => {
    const original = object[key];
    const own = Object.hasOwn(object, key);
    object[key] = replacement(original);
    restorations.push(() => (own ? (object[key] = original) : delete object[key]));
  };
  const layerPrototype = Object.getPrototypeOf(mode.rootLanguageLayer);
  wrap(
    layerPrototype,
    "handleTextChange",
    (original) =>
      function (...args) {
        counts[
          this === mode.rootLanguageLayer ? "rootHandleTextChange" : "childHandleTextChange"
        ]++;
        return original.apply(this, args);
      },
  );
  const rootTree = mode.rootLanguageLayer.tree;
  wrap(
    Object.getPrototypeOf(rootTree),
    "edit",
    (original) =>
      function (...args) {
        counts[this === rootTree ? "rootTreeEdit" : "childTreeEdit"]++;
        return original.apply(this, args);
      },
  );
  for (const key of ["parse", "parseAsync"]) {
    wrap(
      mode,
      key,
      (original) =>
        function (...args) {
          counts[args[2] ? "childParse" : "rootParse"]++;
          return original.apply(this, args);
        },
    );
  }
  for (const [key, phase] of [
    ["_collectInjectionCandidateNodes", "discoverySync"],
    ["_advanceInjectionPlan", "reconcileSync"],
    ["_commitInjectionPlan", "commitSync"],
  ]) {
    wrap(
      layerPrototype,
      key,
      (original) =>
        function (...args) {
          const start = now();
          try {
            return original.apply(this, args);
          } finally {
            cpuMs[phase] += now() - start;
          }
        },
    );
  }
  return {
    counts,
    cpuMs,
    restore() {
      for (const restore of restorations.reverse()) restore();
    },
  };
}

async function runCase(grammar, grammars, layers, kind) {
  const text = fixture(layers);
  const buffer = new TextBuffer(text);
  const mode = new TreeSitterLanguageMode({ buffer, grammar, grammars, config: lumine.config });
  buffer.setLanguageMode(mode);
  const route = mode.bufferDidChange;
  let routingMs = 0;
  mode.bufferDidChange = function (...args) {
    const start = now();
    try {
      return route.apply(this, args);
    } finally {
      routingMs += now() - start;
    }
  };
  const samplesMs = { routing: [], synchronousEdit: [], settleTotal: [] };
  let checksum;
  let observed;
  try {
    await mode.ready;
    expect(mode.getAllInjectionLayers().length).toBe(layers);
    for (let index = -(CONFIG.warmups ?? 1); index < (CONFIG.samples || 3); index++) {
      const edit = editFor(buffer, kind);
      routingMs = 0;
      const start = now();
      const changedRange = buffer.setTextInRange(edit.range, edit.replacement);
      const synchronousEdit = now() - start;
      await settle(mode);
      const settleTotal = now() - start;
      if (index >= 0) {
        samplesMs.routing.push(routingMs);
        samplesMs.synchronousEdit.push(synchronousEdit);
        samplesMs.settleTotal.push(settleTotal);
      }
      if (index === (CONFIG.samples || 3) - 1) checksum = semanticChecksum(buffer, mode);
      buffer.setTextInRange(changedRange, edit.original);
      await settle(mode);
    }
    const probe = diagnostics(mode);
    try {
      const edit = editFor(buffer, kind);
      buffer.setTextInRange(edit.range, edit.replacement);
      await settle(mode);
      observed = { counts: probe.counts, cpuMs: probe.cpuMs };
    } finally {
      probe.restore();
    }
    expect(semanticChecksum(buffer, mode)).toEqual(checksum);
    expect(mode.getAllInjectionLayers().length).toBe(layers);
    return {
      id: `${layers}/${kind}`,
      corpusSha256: sha256(text),
      checksum,
      samplesMs,
      diagnostics: observed,
    };
  } finally {
    mode.bufferDidChange = route;
    mode.destroy();
    buffer.destroy();
  }
}

describe("Injection routing benchmark", () => {
  it("measures settled WASM injections separately from routing", async () => {
    jasmine.useRealClock();
    const grammars = new GrammarRegistry({ config: lumine.config });
    const jsPath = sourceRequire.resolve("language-javascript/grammars/javascript.json");
    const htmlPath = sourceRequire.resolve("language-html/grammars/html.json");
    const jsConfig = { ...CSON.readFileSync(jsPath), injectionNames: ["javascript"] };
    const htmlConfig = CSON.readFileSync(htmlPath);
    const grammar = new TreeSitterGrammar(grammars, jsPath, jsConfig);
    const htmlGrammar = new TreeSitterGrammar(grammars, htmlPath, htmlConfig);
    grammar.addInjectionPoint({
      type: "identifier",
      language: () => "html",
      content: (node) => node,
      includeChildren: true,
      languageScope: null,
    });
    const registrations = [grammars.addGrammar(grammar), grammars.addGrammar(htmlGrammar)];
    const results = [];
    try {
      await Promise.all([grammar.getLanguage(), htmlGrammar.getLanguage()]);
      for (const candidate of [grammar, htmlGrammar]) {
        expect(candidate.treeSitterRuntime).toBe("wasm");
        await Promise.all(
          ["highlightsQuery", "foldsQuery", "indentsQuery", "localsQuery", "tagsQuery"]
            .filter((key) => candidate.queryPaths[key])
            .map((key) => candidate.getQuery(key)),
        );
      }
      for (const layers of CONFIG.layers || [500, 5000]) {
        for (const kind of CONFIG.cases || [
          "leading",
          "trailing",
          "leading-length-changing",
          "inside",
        ])
          results.push(await runCase(grammar, grammars, layers, kind));
      }
      const modules = Object.keys(require.cache)
        .filter(
          (file) =>
            file.endsWith(".node") ||
            (file.startsWith(`${SOURCE}${path.sep}src${path.sep}`) && file.endsWith(".js")),
        )
        .sort()
        .map(fileHash);
      const grammarAssets = [grammar, htmlGrammar].map((candidate) => ({
        scopeName: candidate.scopeName,
        descriptor: fileHash(candidate.grammarFilePath),
        wasm: fileHash(candidate.treeSitterGrammarPath),
        queries: Object.keys(candidate.queryPaths)
          .filter((key) => key.endsWith("Query"))
          .flatMap((key) => {
            const paths = Array.isArray(candidate.queryPaths[key])
              ? candidate.queryPaths[key]
              : [candidate.queryPaths[key]];
            return paths
              .filter((relative) => typeof relative === "string")
              .map((relative) =>
                fileHash(path.resolve(path.dirname(candidate.grammarFilePath), relative)),
              );
          }),
      }));
      const report = {
        schemaVersion: 1,
        config: CONFIG,
        runtime: {
          timer: "process.hrtime.bigint; milliseconds",
          counters: "one separate untimed diagnostic edit per case",
          versions: process.versions,
          executable: process.execPath,
          platform: process.platform,
          arch: process.arch,
          cpus: os.cpus().map(({ model }) => model),
          memoryBytes: os.totalmem(),
          runtimeWasm: fileHash(sourceRequire.resolve("web-tree-sitter/web-tree-sitter.wasm")),
          modules,
          sourceSha256: sha256(
            modules
              .filter(({ path: file }) => file.startsWith(`${SOURCE}${path.sep}src${path.sep}`))
              .map(({ path: file, sha256: hash }) => `${path.relative(SOURCE, file)}:${hash}`)
              .join("\n"),
          ),
          dependencies: sourceRequire("./package.json").dependencies,
          grammarAssets,
        },
        results,
      };
      fs.writeFileSync(
        process.env.LUMINE_INJECTION_ROUTING_OUTPUT,
        JSON.stringify(report, null, 2),
      );
      console.log(
        `INJECTION_ROUTING_BENCHMARK=${JSON.stringify({ cases: results.length, output: process.env.LUMINE_INJECTION_ROUTING_OUTPUT })}`,
      );
    } finally {
      for (const registration of registrations) registration.dispose();
      grammar.deactivate();
      htmlGrammar.deactivate();
    }
  }, 3600000);
});
