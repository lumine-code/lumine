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
const PARSER_POOL_BURST = Number(process.env.LUMINE_TREE_SITTER_PARSER_POOL_BURST || 100);

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

async function measurePhases(run) {
  for (let i = 0; i < WARMUPS; i++) await run(i);
  const totalSamples = [];
  const samplesByPhase = new Map();
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const phases = await run(i + WARMUPS);
    totalSamples.push(performance.now() - start);
    for (const [phase, duration] of Object.entries(phases)) {
      let samples = samplesByPhase.get(phase);
      if (!samples) {
        samples = [];
        samplesByPhase.set(phase, samples);
      }
      samples.push(duration);
    }
  }
  return {
    total: summarize(totalSamples),
    phases: Object.fromEntries(
      Array.from(samplesByPhase, ([phase, samples]) => [phase, summarize(samples)]),
    ),
  };
}

function startMode(text, grammar, grammars, options = {}) {
  const buffer = new TextBuffer(text);
  const languageMode = new TreeSitterLanguageMode({
    buffer,
    grammar,
    grammars,
    config: lumine.config,
    ...options,
  });
  buffer.setLanguageMode(languageMode);
  return { buffer, languageMode };
}

async function createMode(text, grammar, grammars, options = {}) {
  const mode = startMode(text, grammar, grammars, options);
  await mode.languageMode.ready;
  return mode;
}

async function createModeWithSchedulerTurnMetrics(text, grammar, grammars) {
  const mode = startMode(text, grammar, grammars);
  const { languageMode } = mode;
  const turnSamples = [];
  let turnStartedAt = null;

  const finishTurn = () => {
    if (turnStartedAt === null) return;
    turnSamples.push(performance.now() - turnStartedAt);
    turnStartedAt = null;
  };

  const yieldForInitialInjectionUpdates =
    languageMode._yieldForInitialInjectionUpdates.bind(languageMode);
  languageMode._yieldForInitialInjectionUpdates = () => {
    finishTurn();
    return yieldForInitialInjectionUpdates().then(() => {
      turnStartedAt = performance.now();
    });
  };

  const scheduleInitialInjectionUpdate =
    languageMode.scheduleInitialInjectionUpdate.bind(languageMode);
  languageMode.scheduleInitialInjectionUpdate = (callback) => {
    return scheduleInitialInjectionUpdate(() => {
      try {
        return callback();
      } finally {
        if (languageMode.pendingInitialInjectionUpdates.length === 0) finishTurn();
      }
    });
  };

  await languageMode.ready;
  finishTurn();
  delete languageMode._yieldForInitialInjectionUpdates;
  delete languageMode.scheduleInitialInjectionUpdate;
  return { ...mode, turnSamples };
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

    const denseInjectionLayerMeasurement = await measurePhases(async () => {
      const constructStart = performance.now();
      const mode = startMode(layerSource, layerGrammar, grammars);
      const constructMs = performance.now() - constructStart;
      const readyStart = performance.now();
      await mode.languageMode.ready;
      const readyWaitMs = performance.now() - readyStart;
      const getAllStart = performance.now();
      const injectionLayers = mode.languageMode.getAllInjectionLayers();
      const getAllMs = performance.now() - getAllStart;
      expect(injectionLayers.length).toBe(INJECTION_LAYERS);
      expect(injectionLayers.every((layer) => layer.tree !== null)).toBe(true);
      const destroyStart = performance.now();
      destroyMode(mode);
      const destroyMs = performance.now() - destroyStart;
      return {
        constructMs,
        readyWaitMs,
        readyTotalMs: constructMs + readyWaitMs,
        getAllMs,
        destroyMs,
      };
    });
    const denseInjectionLayers = denseInjectionLayerMeasurement.total;
    const denseInjectionLayerLifecycle = denseInjectionLayerMeasurement.phases;

    const denseLifecycleStartedAt = performance.now();
    const denseLifecycleProbe = startMode(layerSource, layerGrammar, grammars);
    const denseLifecycleConstructMs = performance.now() - denseLifecycleStartedAt;
    const denseLifecycleLanguageMode = denseLifecycleProbe.languageMode;
    let topologyCommittedMs = null;
    let injectionMarkerCreations = 0;
    let injectionMarkerCreationMs = 0;
    let parseStarts = 0;
    let parseStartSyncMs = 0;
    const parseStartsByScope = {};
    const denseLifecycleOperations = {};
    const restoreDenseLifecycleInstrumentation = [];
    const instrumentedNodeRangeSets = new WeakSet();

    const recordDenseLifecycleOperation = (name, duration) => {
      let operation = denseLifecycleOperations[name];
      if (!operation) {
        operation = { count: 0, totalMs: 0 };
        denseLifecycleOperations[name] = operation;
      }
      operation.count++;
      operation.totalMs += duration;
    };

    const instrumentMethod = (target, methodName, operationName, shouldMeasure = () => true) => {
      const hadOwnMethod = Object.hasOwn(target, methodName);
      const originalMethod = target[methodName];
      target[methodName] = function (...args) {
        if (!shouldMeasure(this, args)) return originalMethod.apply(this, args);
        const measuredOperationName =
          typeof operationName === "function" ? operationName(this, args) : operationName;
        if (!measuredOperationName) return originalMethod.apply(this, args);
        const start = performance.now();
        try {
          return originalMethod.apply(this, args);
        } finally {
          recordDenseLifecycleOperation(measuredOperationName, performance.now() - start);
        }
      };
      restoreDenseLifecycleInstrumentation.push(() => {
        if (hadOwnMethod) {
          target[methodName] = originalMethod;
        } else {
          delete target[methodName];
        }
      });
    };

    instrumentMethod(denseLifecycleLanguageMode, "emitRangeUpdate", "emitRangeUpdate");
    instrumentMethod(denseLifecycleLanguageMode, "emitFoldUpdate", "emitFoldUpdate");
    instrumentMethod(denseLifecycleLanguageMode, "prefillFoldCache", "prefillFoldCache");
    instrumentMethod(
      denseLifecycleLanguageMode.injectionsMarkerLayer,
      "findMarkers",
      "injectionMarkerFind",
    );

    const yieldForInitialInjectionUpdates =
      denseLifecycleLanguageMode._yieldForInitialInjectionUpdates.bind(denseLifecycleLanguageMode);
    let childLayerPrototypeInstrumented = false;
    denseLifecycleLanguageMode._yieldForInitialInjectionUpdates = () => {
      topologyCommittedMs ??= performance.now() - denseLifecycleStartedAt;
      if (!childLayerPrototypeInstrumented) {
        childLayerPrototypeInstrumented = true;
        const firstInjectionMarker = denseLifecycleLanguageMode.injectionsMarkerLayer.markersById
          .values()
          .next().value;
        const firstChildLayer = firstInjectionMarker.languageLayer;
        const childLayerPrototype = firstChildLayer.constructor.prototype;
        instrumentMethod(
          childLayerPrototype,
          "_performUpdate",
          "initialChildPerformUpdateSync",
          (_layer, args) => {
            const [nodeRangeSet, params] = args;
            if (params?.initialInjectionUpdateStarted && nodeRangeSet) {
              if (!instrumentedNodeRangeSets.has(nodeRangeSet)) {
                instrumentedNodeRangeSets.add(nodeRangeSet);
                instrumentMethod(nodeRangeSet, "getRanges", "nodeRangeSetGetRanges");
              }
              return true;
            }
            return false;
          },
        );
        instrumentMethod(
          childLayerPrototype,
          "setCurrentRanges",
          "setCurrentRanges",
          (layer) => layer.languageMode === denseLifecycleLanguageMode && layer.depth > 0,
        );
        instrumentMethod(
          childLayerPrototype,
          "_populateInjections",
          "populateChildInjectionsSync",
          (layer) => layer.languageMode === denseLifecycleLanguageMode && layer.depth > 0,
        );
        const foldResolverPrototype = firstChildLayer.foldResolver.constructor.prototype;
        const foldOperationName = (resolver, suffix) => {
          if (resolver.layer.languageMode !== denseLifecycleLanguageMode) return null;
          return resolver.layer.depth === 0 ? `rootFold${suffix}` : `childFold${suffix}`;
        };
        instrumentMethod(foldResolverPrototype, "prefillFoldCache", (resolver) =>
          foldOperationName(resolver, "Prefill"),
        );
        instrumentMethod(foldResolverPrototype, "getOrCreateBoundariesIterator", (resolver) =>
          foldOperationName(resolver, "Boundaries"),
        );
        instrumentMethod(firstChildLayer.queries.foldsQuery, "captures", "childFoldQueryCaptures");
        instrumentMethod(
          denseLifecycleLanguageMode.rootLanguageLayer.queries.foldsQuery,
          "captures",
          "rootFoldQueryCaptures",
        );
      }
      return yieldForInitialInjectionUpdates();
    };

    const markInjectionRange = denseLifecycleLanguageMode.injectionsMarkerLayer.markRange.bind(
      denseLifecycleLanguageMode.injectionsMarkerLayer,
    );
    denseLifecycleLanguageMode.injectionsMarkerLayer.markRange = (...args) => {
      const start = performance.now();
      try {
        injectionMarkerCreations++;
        return markInjectionRange(...args);
      } finally {
        injectionMarkerCreationMs += performance.now() - start;
      }
    };

    const parseAsync = denseLifecycleLanguageMode.parseAsync.bind(denseLifecycleLanguageMode);
    denseLifecycleLanguageMode.parseAsync = (...args) => {
      const start = performance.now();
      const scopeName = args[3]?.scopeName ?? "unknown";
      parseStarts++;
      parseStartsByScope[scopeName] = (parseStartsByScope[scopeName] ?? 0) + 1;
      try {
        return parseAsync(...args);
      } finally {
        parseStartSyncMs += performance.now() - start;
      }
    };

    await denseLifecycleLanguageMode.ready;
    const denseLifecycleReadyMs = performance.now() - denseLifecycleStartedAt;
    const denseLifecycleGetAllStart = performance.now();
    const denseLifecycleLayers = denseLifecycleLanguageMode.getAllInjectionLayers();
    const denseLifecycleGetAllMs = performance.now() - denseLifecycleGetAllStart;
    expect(denseLifecycleLayers.length).toBe(INJECTION_LAYERS);
    expect(injectionMarkerCreations).toBe(INJECTION_LAYERS);
    expect(parseStarts).toBe(INJECTION_LAYERS + 1);
    expect(denseLifecycleOperations.rootFoldQueryCaptures?.count ?? 0).toBe(0);
    expect(denseLifecycleOperations.childFoldQueryCaptures?.count).toBe(INJECTION_LAYERS);
    for (const restore of restoreDenseLifecycleInstrumentation.reverse()) restore();
    delete denseLifecycleLanguageMode._yieldForInitialInjectionUpdates;
    delete denseLifecycleLanguageMode.parseAsync;
    delete denseLifecycleLanguageMode.injectionsMarkerLayer.markRange;
    const denseLifecycleDestroyStart = performance.now();
    destroyMode(denseLifecycleProbe);
    const denseLifecycleDestroyMs = performance.now() - denseLifecycleDestroyStart;
    const denseInjectionLifecycleProbe = {
      injectionLayers: denseLifecycleLayers.length,
      constructMs: denseLifecycleConstructMs,
      topologyCommittedMs,
      postTopologyReadyMs: denseLifecycleReadyMs - topologyCommittedMs,
      readyTotalMs: denseLifecycleReadyMs,
      injectionMarkerCreations,
      injectionMarkerCreationMs,
      parseStarts,
      parseStartsByScope,
      parseStartSyncMs,
      operations: Object.fromEntries(
        Object.entries(denseLifecycleOperations).map(([name, operation]) => [
          name,
          {
            count: operation.count,
            totalMs: operation.totalMs,
            meanMs: operation.totalMs / operation.count,
          },
        ]),
      ),
      getAllMs: denseLifecycleGetAllMs,
      destroyMs: denseLifecycleDestroyMs,
    };

    const schedulerProbe = await createModeWithSchedulerTurnMetrics(
      layerSource,
      layerGrammar,
      grammars,
    );
    expect(schedulerProbe.languageMode.getAllInjectionLayers().length).toBe(INJECTION_LAYERS);
    expect(schedulerProbe.turnSamples.length).toBeGreaterThan(0);
    const initialInjectionSchedulerTurns = {
      count: schedulerProbe.turnSamples.length,
      budgetMs: schedulerProbe.languageMode.initialInjectionUpdateBudgetMs,
      diagnosticP95TargetMs: 16,
      diagnosticMaxTargetMs: 25,
      longTaskThresholdMs: 50,
      ...summarize(schedulerProbe.turnSamples),
    };
    expect(initialInjectionSchedulerTurns.maxMs).toBeLessThan(
      initialInjectionSchedulerTurns.longTaskThresholdMs,
    );
    destroyMode(schedulerProbe);

    const parserPoolProbe = await createMode("const pooled = 1;", jsGrammar, grammars);
    const parserPoolLanguage = jsGrammar.getLanguageSync();
    const burstParsers = Array.from({ length: PARSER_POOL_BURST }, () =>
      parserPoolProbe.languageMode.acquireParserForLanguage(parserPoolLanguage),
    );
    const parserPool = parserPoolProbe.languageMode.getParserPoolForLanguage(parserPoolLanguage);
    const peakActiveParsers = parserPool.active.size;
    const parserDeleteSpies = burstParsers.map((parser) =>
      spyOn(parser, "delete").and.callThrough(),
    );
    for (const parser of burstParsers) {
      parserPoolProbe.languageMode.releaseParserForLanguage(parserPoolLanguage, parser);
    }
    const idleParsersAfterBurst = parserPool.idle.length;
    const activeParsersAfterBurst = parserPool.active.size;
    const disposedParsersAfterBurst = parserDeleteSpies.reduce(
      (count, spy) => count + spy.calls.count(),
      0,
    );
    const expectedIdleParsers = Math.min(
      PARSER_POOL_BURST,
      parserPoolProbe.languageMode.maxIdleParsersPerLanguage,
    );
    expect(peakActiveParsers).toBe(PARSER_POOL_BURST);
    expect(activeParsersAfterBurst).toBe(0);
    expect(idleParsersAfterBurst).toBe(expectedIdleParsers);
    expect(disposedParsersAfterBurst).toBe(PARSER_POOL_BURST - expectedIdleParsers);
    const parserPoolBurst = {
      requested: PARSER_POOL_BURST,
      peakActive: peakActiveParsers,
      activeAfter: activeParsersAfterBurst,
      idleAfter: idleParsersAfterBurst,
      disposedAfter: disposedParsersAfterBurst,
      idleLimit: parserPoolProbe.languageMode.maxIdleParsersPerLanguage,
    };
    destroyMode(parserPoolProbe);

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
    const trailingHandleTextChangeCount = handleTextChangeSpies.reduce(
      (count, spy) => count + spy.calls.count(),
      0,
    );
    const trailingChildTreeEditCount = childTreeEditSpies.reduce(
      (count, spy) => count + spy.calls.count(),
      0,
    );
    expect(trailingHandleTextChangeCount).toBe(0);
    expect(trailingChildTreeEditCount).toBe(0);

    for (const spy of [...handleTextChangeSpies, ...childTreeEditSpies]) spy.calls.reset();
    routingProbe.buffer.setTextInRange(
      [
        [0, headEditColumn],
        [0, headEditColumn + 1],
      ],
      "y",
    );
    await routingProbe.languageMode.atTransactionEnd();
    const leadingHandleTextChangeCount = handleTextChangeSpies.reduce(
      (count, spy) => count + spy.calls.count(),
      0,
    );
    const leadingChildTreeEditCount = childTreeEditSpies.reduce(
      (count, spy) => count + spy.calls.count(),
      0,
    );
    expect(leadingHandleTextChangeCount).toBe(INJECTION_LAYERS);
    expect(leadingChildTreeEditCount).toBe(INJECTION_LAYERS);
    const siblingInjectionRoutingCounts = {
      trailing: {
        handleTextChange: trailingHandleTextChangeCount,
        treeEdit: trailingChildTreeEditCount,
      },
      leading: {
        handleTextChange: leadingHandleTextChangeCount,
        treeEdit: leadingChildTreeEditCount,
      },
    };
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
          parserPoolBurst: PARSER_POOL_BURST,
          runs: RUNS,
          warmups: WARMUPS,
        },
        checksums: { highlighting: highlightChecksum },
        diagnostics: {
          siblingInjectionRoutingCounts,
          parserPoolBurst,
          denseInjectionLifecycleProbe,
        },
        metrics: {
          initialParse,
          incrementalEdit,
          injectionEdit,
          denseInjectionPipeline,
          denseInjectionLayers,
          denseInjectionLayerLifecycle,
          initialInjectionSchedulerTurns,
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
