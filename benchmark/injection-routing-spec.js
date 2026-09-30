const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire, Module } = require("module");
const os = require("os");
const CSON = require("@lumine-code/season");

const CONFIG = JSON.parse(process.env.LUMINE_INJECTION_ROUTING_CONFIG || "{}");
const SOURCE = CONFIG.source || path.resolve(__dirname, "..");
const GRAMMAR_ROOT = CONFIG.grammarRoot || path.dirname(path.resolve(__dirname, ".."));
const sourceRequire = createRequire(path.join(SOURCE, "package.json"));
const GrammarRegistry = sourceRequire("./src/grammar-registry");
const TextBuffer = sourceRequire("./src/text-buffer");
const TreeSitterGrammar = sourceRequire("./src/tree-sitter-grammar");
const TreeSitterLanguageMode = sourceRequire("./src/tree-sitter-language-mode");
const Marker = sourceRequire("./src/marker");
const MarkerLayer = sourceRequire("./src/marker-layer");
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
  let oldLength = 1;
  let replacement = "y";
  if (kind === "inside") {
    index = buffer.getText().indexOf("v00000") + 5;
    replacement = "1";
  } else if (kind === "trailing") {
    index = buffer.getText().lastIndexOf("x");
  } else {
    index = buffer.getText().indexOf("x");
    if (kind === "leading-length-changing") replacement = "xx";
    if (kind === "leading-insert") {
      oldLength = 0;
      replacement = "x";
    }
    if (kind === "leading-delete") replacement = "";
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
  const synchronousPhases = {};
  const parseWallMs = { root: 0, child: 0 };
  const stack = [];
  const restorations = [];
  const wrap = (object, key, replacement) => {
    const original = object[key];
    if (typeof original !== "function") throw new Error(`Missing diagnostic method: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, {
      ...(descriptor || { configurable: true, writable: true }),
      value: replacement(original),
    });
    restorations.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
    });
  };
  const measure = (phase, callback) => {
    const sample = { start: now(), childrenMs: 0 };
    stack.push(sample);
    try {
      return callback();
    } finally {
      const elapsed = now() - sample.start;
      stack.pop();
      if (stack.length) stack.at(-1).childrenMs += elapsed;
      const total = (synchronousPhases[phase] ||= {
        calls: 0,
        inclusiveMs: 0,
        exclusiveMs: 0,
      });
      total.calls++;
      total.inclusiveMs += elapsed;
      total.exclusiveMs += elapsed - sample.childrenMs;
    }
  };
  const timed = (object, key, phase) =>
    wrap(
      object,
      key,
      (original) =>
        function (...args) {
          return measure(phase, () => original.apply(this, args));
        },
    );
  try {
    // N-API prototype methods may be non-configurable. Shadow only the actual
    // objects owned by this buffer; never import a second addon to patch it.
    timed(mode.buffer.buffer, "setTextInRange", "nativeTextMutation");
    timed(MarkerLayer.prototype, "splice", "markerLayerSplice");
    for (const layer of Object.values(mode.buffer.markerLayers)) {
      timed(layer.index, "splice", "nativeMarkerSplice");
      if (typeof layer.index.splicePacked === "function")
        timed(layer.index, "splicePacked", "nativeMarkerSplicePacked");
      if (typeof layer.index.getRanges === "function")
        timed(layer.index, "getRanges", "nativeMarkerGetRanges");
    }
    timed(Marker.prototype, "getRange", "markerGetRange");
    timed(MarkerLayer.prototype, "emitChangeEvents", "markerChangeEvents");
    timed(MarkerLayer.prototype, "emitUpdateEvent", "markerUpdateEvents");
    timed(mode, "bufferDidChange", "languageRouting");
    if (!mode.rootLanguageLayer) return { counts, cpuMs, synchronousPhases, parseWallMs, restore };
    const layerPrototype = Object.getPrototypeOf(mode.rootLanguageLayer);
    wrap(
      layerPrototype,
      "handleTextChange",
      (original) =>
        function (...args) {
          counts[
            this === mode.rootLanguageLayer ? "rootHandleTextChange" : "childHandleTextChange"
          ]++;
          return measure(
            this === mode.rootLanguageLayer ? "rootHandleTextChange" : "childHandleTextChange",
            () => original.apply(this, args),
          );
        },
    );
    const rootTree = mode.rootLanguageLayer.tree;
    wrap(
      Object.getPrototypeOf(rootTree),
      "edit",
      (original) =>
        function (...args) {
          counts[this === rootTree ? "rootTreeEdit" : "childTreeEdit"]++;
          return measure(this === rootTree ? "rootTreeEdit" : "childTreeEdit", () =>
            original.apply(this, args),
          );
        },
    );
    for (const key of ["parse", "parseAsync"]) {
      wrap(
        mode,
        key,
        (original) =>
          function (...args) {
            const kind = args[2] ? "child" : "root";
            counts[`${kind}Parse`]++;
            const start = now();
            const result = measure(`${kind}ParseEntrySync`, () => original.apply(this, args));
            if (result && typeof result.then === "function") {
              result.then(
                () => {
                  parseWallMs[kind] += now() - start;
                },
                () => {
                  parseWallMs[kind] += now() - start;
                },
              );
            } else parseWallMs[kind] += now() - start;
            return result;
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
              return measure(phase, () => original.apply(this, args));
            } finally {
              cpuMs[phase] += now() - start;
            }
          },
      );
    }
    return { counts, cpuMs, synchronousPhases, parseWallMs, restore };
  } catch (error) {
    restore();
    throw error;
  }
  function restore() {
    for (const restore of restorations.reverse()) restore();
    restorations.length = 0;
  }
}

async function runCase(grammar, grammars, layers, kind, scenario = {}) {
  const text = scenario.text || fixture(layers);
  const buffer = new TextBuffer(text);
  const mode = grammar
    ? new TreeSitterLanguageMode({ buffer, grammar, grammars, config: lumine.config })
    : buffer.getLanguageMode();
  if (grammar) buffer.setLanguageMode(mode);
  const setup = scenario.setup?.(buffer);
  const checksumFor = () =>
    scenario.checksum ? scenario.checksum(buffer, setup) : semanticChecksum(buffer, mode);
  const settleMode = () => (grammar ? settle(mode) : Promise.resolve());
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
    if (grammar) {
      await mode.ready;
      expect(mode.getAllInjectionLayers().length).toBe(scenario.expectedLayers ?? layers);
    }
    for (let index = -(CONFIG.warmups ?? 1); index < (CONFIG.samples || 3); index++) {
      const edit = (scenario.edit || editFor)(buffer, kind);
      if (setup) setup.events = 0;
      routingMs = 0;
      const start = now();
      const changedRange = buffer.setTextInRange(edit.range, edit.replacement);
      const synchronousEdit = now() - start;
      await settleMode();
      const settleTotal = now() - start;
      if (index >= 0) {
        samplesMs.routing.push(routingMs);
        samplesMs.synchronousEdit.push(synchronousEdit);
        samplesMs.settleTotal.push(settleTotal);
      }
      if (index === (CONFIG.samples || 3) - 1) checksum = checksumFor();
      buffer.setTextInRange(changedRange, edit.original);
      await settleMode();
    }
    const probe = diagnostics(mode);
    try {
      const edit = (scenario.edit || editFor)(buffer, kind);
      if (setup) setup.events = 0;
      buffer.setTextInRange(edit.range, edit.replacement);
      await settleMode();
      observed = {
        counts: probe.counts,
        cpuMs: probe.cpuMs,
        synchronousPhases: probe.synchronousPhases,
        parseWallMs: probe.parseWallMs,
      };
    } finally {
      probe.restore();
    }
    expect(checksumFor()).toEqual(checksum);
    if (grammar)
      expect(mode.getAllInjectionLayers().length).toBe(scenario.expectedLayers ?? layers);
    return {
      id: scenario.id ? `${scenario.id}/${kind}` : `${layers}/${kind}`,
      corpusSha256: sha256(text),
      checksum,
      samplesMs,
      diagnostics: observed,
      ...(setup ? { markerListeners: setup.listenerCount, events: setup.events } : {}),
    };
  } finally {
    mode.bufferDidChange = route;
    mode.destroy();
    buffer.destroy();
  }
}

function markerScenario(count, listeners) {
  return {
    id: `markers/${count}/${listeners}`,
    setup(buffer) {
      const result = { markers: [], events: 0, listenerCount: 0 };
      const text = buffer.getText();
      for (let index = 0; index < count; index++) {
        const start = text.indexOf(`v${String(index).padStart(5, "0")}`);
        const marker = buffer.markRange(
          [buffer.positionForCharacterIndex(start), buffer.positionForCharacterIndex(start + 6)],
          { invalidate: "never" },
        );
        result.markers.push(marker);
        if (listeners === "dense" || (listeners === "sparse" && index % 100 === 0)) {
          marker.onDidChange(() => result.events++);
          result.listenerCount++;
        }
      }
      return result;
    },
    checksum(buffer, setup) {
      return {
        sha256: sha256(
          JSON.stringify([
            buffer.getText(),
            setup.markers.map((marker) => [marker.getRange(), marker.isValid()]),
            setup.events,
          ]),
        ),
        markers: count,
        events: setup.events,
      };
    },
  };
}

function representativeFixture(name, count) {
  const blocks = Array.from({ length: count }, (_, index) =>
    name === "ipython"
      ? `# %% Cell ${index}\n%%html\n<section><script>const value${index} = 1;</script></section>\n`
      : name === "vue"
        ? `<section><div :title="value${index}">{{ value${index} }}</div></section>\n`
        : `<section><script>const value${index} = 1;</script></section>\n`,
  );
  if (name === "ipython") return `# head-x\n${blocks.join("")}# %% Tail\n# tail-x\n`;
  return `<!--head-x-->\n${name === "vue" ? "<template>\n" : ""}${blocks.join("")}${name === "vue" ? "</template>\n<script>const value = 1;</script>\n" : ""}<!--tail-x-->`;
}

async function runRepresentative(name, assets, providers) {
  const registry = new GrammarRegistry({ config: lumine.config });
  const loaded = [];
  const registrations = [];
  const activatedProviders = [];
  const load = async (packageName, descriptor) => {
    const file = path.join(GRAMMAR_ROOT, packageName, "grammars", `${descriptor}.json`);
    const grammar = new TreeSitterGrammar(registry, file, CSON.readFileSync(file));
    loaded.push(grammar);
    assets.push(grammar);
    registrations.push(registry.addGrammar(grammar));
    await grammar.getLanguage();
    expect(grammar.treeSitterRuntime).toBe("wasm");
    await Promise.all(
      ["highlightsQuery", "foldsQuery", "indentsQuery", "localsQuery", "tagsQuery"]
        .filter((key) => grammar.queryPaths[key])
        .map((key) => grammar.getQuery(key)),
    );
    return grammar;
  };
  try {
    await load("language-javascript", "javascript");
    const html = await load("language-html", "html");
    let root = html;
    if (name === "vue") {
      await load("language-typescript", "typescript");
      root = await load("language-vue", "vue");
    } else if (name === "ipython") root = await load("language-ipython", "ipython");
    for (const packageName of ["language-html", ...(name === "html" ? [] : [`language-${name}`])]) {
      const file = path.join(GRAMMAR_ROOT, packageName, "lib", "main.js");
      // Give each provider its own lifecycle state: the editor may already have
      // activated its cached module, which this isolated registry must not drain.
      const providerModule = new Module(file, module);
      providerModule.filename = file;
      providerModule.paths = Module._nodeModulePaths(path.dirname(file));
      providerModule._compile(fs.readFileSync(file, "utf8"), file);
      const provider = providerModule.exports;
      providers.push(fileHash(file));
      const descriptor = Object.getOwnPropertyDescriptor(lumine.grammars, "addInjectionPoint");
      Object.defineProperty(lumine.grammars, "addInjectionPoint", {
        ...(descriptor || { configurable: true, writable: true }),
        value: (...args) => registry.addInjectionPoint(...args),
      });
      activatedProviders.push(provider);
      try {
        provider.activate();
      } finally {
        if (descriptor) Object.defineProperty(lumine.grammars, "addInjectionPoint", descriptor);
        else delete lumine.grammars.addInjectionPoint;
      }
    }
    const count = CONFIG.representativeBlocks || 50;
    const text = representativeFixture(name, count);
    const results = [];
    for (const kind of CONFIG.representativeCases || [
      "leading",
      "leading-insert",
      "leading-delete",
      "inside",
    ])
      results.push(
        await runCase(root, registry, count, kind, {
          id: `representative/${name}/${count}`,
          text,
          expectedLayers: name === "html" ? count : name === "vue" ? 2 * count + 1 : 2 * count,
          edit(buffer, kind) {
            if (kind !== "inside") return editFor(buffer, kind);
            const index = buffer.getText().indexOf("value0") + 5;
            return {
              range: [
                buffer.positionForCharacterIndex(index),
                buffer.positionForCharacterIndex(index + 1),
              ],
              replacement: "1",
              original: "0",
            };
          },
        }),
      );
    return results;
  } finally {
    for (const provider of activatedProviders.reverse()) provider.deactivate();
    for (const registration of registrations.reverse()) registration.dispose();
    for (const grammar of loaded) grammar.deactivate();
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
    const assets = [grammar, htmlGrammar];
    const providers = [];
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
      const suites = CONFIG.suites || ["injections"];
      if (suites.includes("injections"))
        for (const layers of CONFIG.layers || [500, 5000]) {
          for (const kind of CONFIG.cases || [
            "leading",
            "trailing",
            "leading-length-changing",
            "inside",
          ])
            results.push(await runCase(grammar, grammars, layers, kind));
        }
      if (suites.includes("markers"))
        for (const count of CONFIG.markers || [1000, 10000])
          for (const listeners of CONFIG.listeners || ["none", "sparse", "dense"])
            for (const kind of CONFIG.markerCases || [
              "leading",
              "leading-insert",
              "leading-delete",
            ])
              results.push(
                await runCase(null, null, count, kind, markerScenario(count, listeners)),
              );
      if (suites.includes("representative"))
        for (const name of CONFIG.representatives || ["html", "vue", "ipython"])
          results.push(...(await runRepresentative(name, assets, providers)));
      const modules = Object.keys(require.cache)
        .filter(
          (file) =>
            file.endsWith(".node") ||
            (file.startsWith(`${SOURCE}${path.sep}src${path.sep}`) && file.endsWith(".js")) ||
            (file.startsWith(`${GRAMMAR_ROOT}${path.sep}language-`) && file.endsWith(".js")),
        )
        .sort()
        .map(fileHash);
      const grammarAssets = assets.map((candidate) => ({
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
          diagnosticTiming:
            "Synchronous inclusive/exclusive method spans include wrapper overhead; exclusive spans subtract nested instrumented calls. Parse wall spans include yields and are not CPU time; parallel child spans must not be summed as elapsed edit time. No per-marker wrappers are installed in latency samples.",
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
          injectionProviders: providers,
          injectionProviderModules: modules.filter(({ path: file }) =>
            file.startsWith(`${GRAMMAR_ROOT}${path.sep}language-`),
          ),
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
