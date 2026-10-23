const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function fileHash(file) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)))
      digest.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: null, median: null, p95: null, max: null };
  const percentile = (fraction) => {
    const position = (sorted.length - 1) * fraction;
    const index = Math.floor(position);
    return sorted[index] + (sorted[Math.ceil(position)] - sorted[index]) * (position - index);
  };
  return {
    count: sorted.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}

function intervalProbe(ticks, start, end) {
  if (!Array.isArray(ticks) || ticks.length < 2) return null;
  const pairs = [];
  for (let index = 1; index < ticks.length; index++) {
    const from = ticks[index - 1];
    const to = ticks[index];
    assert.ok(to >= from, "Probe timestamps must be monotonic");
    if (from >= end || to <= start) continue;
    pairs.push({
      start: from,
      end: to,
      gapMs: to - from,
      overlapMs: Math.min(end, to) - Math.max(start, from),
      boundary: from < start || to > end,
    });
  }
  if (!pairs.length) return null;
  return {
    pairs,
    boundaryPairCount: pairs.filter((pair) => pair.boundary).length,
    containedPairCount: pairs.filter((pair) => !pair.boundary).length,
    coversPhase: ticks[0] <= start && ticks.at(-1) >= end,
  };
}

function phaseIdentity(sample, contextPackage) {
  const parts = sample.id.split("/");
  const callerRoute = sample.callerRoute ?? sample.route ?? null;
  if (parts[0] === "control")
    return {
      package: "control",
      contextPackage,
      kind: "control",
      mode: parts.slice(1, -1).join("/"),
      query: null,
      callerRoute,
    };
  if (parts[1] === "query" || parts[1] === "query-cold")
    return {
      package: parts[0],
      kind: "query",
      mode: parts[1] === "query-cold" ? "cold" : null,
      query: parts.slice(3).join("/"),
      callerRoute,
    };
  assert.equal(parts[2], "open", `Unknown measurement phase ${sample.id}`);
  return { package: parts[0], kind: "open", mode: parts[1], query: null, callerRoute };
}

function collectPhase(sample, trace, result, run) {
  assert.equal(trace.id, sample.id, "Analysis/sample order differs");
  assert.ok(!trace.error, `${sample.id}: ${trace.error}`);
  const matchingInputs = Array.isArray(result.inputs)
    ? result.inputs.filter(
        (event) => event.timestamp >= sample.start && event.timestamp <= sample.end,
      )
    : [];
  const input = matchingInputs.length
    ? matchingInputs.map((event) => ({
        timestamp: event.timestamp,
        deliveredAt: event.at,
        delayMs: event.at - event.timestamp,
        deliveredAfterPhase: event.at > sample.end,
      }))
    : null;
  const longTasks =
    result.monitor?.clock?.longTasksSupported && Array.isArray(result.monitor.longTasks)
      ? result.monitor.longTasks
          .filter(([start, duration]) => start < sample.end && start + duration > sample.start)
          .map(([start, duration]) => ({ start, duration }))
      : null;
  return {
    label: run.label,
    variant: run.variant,
    traceMode: run.mode,
    count: run.size,
    id: sample.id,
    occurrence: trace.occurrence,
    start: sample.start,
    end: sample.end,
    ...phaseIdentity(sample, run.picker),
    durationMs: sample.duration,
    syncMs: sample.sync,
    maxTaskMs: trace.maxTaskMs ?? null,
    maxWholeTaskMs: trace.maxWholeTaskMs ?? null,
    taskUnionMs: trace.taskUnionMs ?? null,
    boundaryTaskCount: trace.boundaryTaskCount ?? null,
    gcUnionMs: trace.gcUnionMs ?? null,
    styleLayoutUnionMs: trace.styleLayoutUnionMs ?? null,
    gcOrStyleLayoutUnionMs: trace.gcOrStyleLayoutUnionMs ?? null,
    paintUnionMs: trace.paintUnionMs ?? null,
    legacyGapMs: sample.legacy?.gap ?? null,
    legacyTailMs: sample.legacy?.tail ?? null,
    legacyTickCount: Array.isArray(sample.legacy?.ticks) ? sample.legacy.ticks.length : null,
    inputProbeCount: input?.length ?? null,
    input,
    nodeTimer: intervalProbe(result.monitor?.nodeTicks, sample.start, sample.end),
    browserTimer: intervalProbe(result.monitor?.browserTicks, sample.start, sample.end),
    frame: intervalProbe(result.monitor?.frames, sample.start, sample.end),
    longTaskApiCount: longTasks?.length ?? null,
    longTasks,
    reusedWorker: sample.reusedWorker ?? null,
    workerEvents: sample.workerEvents || [],
  };
}

const PHASE_METRICS = [
  "durationMs",
  "syncMs",
  "maxTaskMs",
  "maxWholeTaskMs",
  "taskUnionMs",
  "boundaryTaskCount",
  "gcUnionMs",
  "styleLayoutUnionMs",
  "gcOrStyleLayoutUnionMs",
  "paintUnionMs",
  "legacyGapMs",
  "legacyTailMs",
  "inputProbeCount",
  "longTaskApiCount",
];

function aggregate(phases) {
  const metrics = Object.fromEntries(
    PHASE_METRICS.map((name) => [name, statistics(phases.map((phase) => phase[name]))]),
  );
  metrics.inputDelayMs = statistics(
    phases.flatMap((phase) => phase.input?.map((event) => event.delayMs) || []),
  );
  metrics.inputDelaySampleMaxMs = statistics(
    phases.map((phase) => statistics(phase.input?.map((event) => event.delayMs) || []).max),
  );
  for (const probe of ["nodeTimer", "browserTimer", "frame"])
    metrics[`${probe}GapMs`] = statistics(
      phases.flatMap((phase) => phase[probe]?.pairs.map((pair) => pair.gapMs) || []),
    );
  return {
    samples: phases.length,
    runCount: new Set(phases.map((phase) => phase.label)).size,
    legacyZeroTickSamples: phases.some((phase) => phase.legacyTickCount !== null)
      ? phases.filter((phase) => phase.legacyTickCount === 0).length
      : null,
    missingLegacySamples: phases.filter((phase) => phase.legacyTickCount === null).length,
    missingInputSamples: phases.filter((phase) => phase.input === null).length,
    inputDeliveredAfterPhase: phases.some((phase) => phase.input !== null)
      ? phases.reduce(
          (count, phase) =>
            count + (phase.input?.filter((event) => event.deliveredAfterPhase).length || 0),
          0,
        )
      : null,
    probes: Object.fromEntries(
      ["nodeTimer", "browserTimer", "frame"].map((name) => [
        name,
        {
          missingSamples: phases.filter((phase) => phase[name] === null).length,
          incompleteCoverageSamples: phases.filter(
            (phase) => phase[name] && !phase[name].coversPhase,
          ).length,
          boundaryPairCount: phases.some((phase) => phase[name] !== null)
            ? phases.reduce((count, phase) => count + (phase[name]?.boundaryPairCount || 0), 0)
            : null,
          containedPairCount: phases.some((phase) => phase[name] !== null)
            ? phases.reduce((count, phase) => count + (phase[name]?.containedPairCount || 0), 0)
            : null,
          rawPairs: phases.flatMap((phase) =>
            (phase[name]?.pairs || []).map((pair) => ({
              label: phase.label,
              id: phase.id,
              occurrence: phase.occurrence,
              ...pair,
            })),
          ),
        },
      ]),
    ),
    metrics,
  };
}

function summarize(resultFiles, { manifestFile = null, series = null } = {}) {
  const manifest = manifestFile ? read(manifestFile) : null;
  const expectedFiles = manifest?.fingerprint?.files;
  if (manifest) {
    assert.equal(manifest.schemaVersion, 1, "Unknown batch manifest schema");
    assert.ok(expectedFiles, "Batch manifest has no fingerprint");
    const ordered = Object.fromEntries(
      Object.entries(expectedFiles).sort(([a], [b]) => a.localeCompare(b)),
    );
    assert.equal(
      hash(JSON.stringify(ordered)),
      manifest.fingerprint.hash,
      "Batch fingerprint is inconsistent",
    );
  }
  const accepted = new Map((manifest?.runs || []).map((run) => [run.label, run]));
  const plan = new Map((manifest?.plan || []).map((entry) => [entry.slotId, entry]));
  const corpusCache = new Map();
  const snapshotCache = new Map();
  const validationByWorkload = new Map();
  const phases = [];
  const runs = [];
  let firstResult;
  let sourceChecks = 0;
  let artifactChecks = 0;
  let orderedResultSetsChecked = 0;
  const selected = resultFiles
    .map((file) => ({ file: path.resolve(file), result: read(file) }))
    .filter(
      ({ result }) =>
        result.config &&
        Array.isArray(result.samples) &&
        (!series || result.config.label.startsWith(series)),
    );
  for (const { file, result } of selected) {
    const { label, variant, corpus, snapshot } = result.config;
    assert.ok(["before", "after"].includes(variant), `${label}: invalid variant`);
    assert.equal(
      result.monitor?.clock?.visibility,
      "visible",
      `${label}: measurement window was not visible`,
    );
    assert.equal(
      result.monitor?.clock?.drain?.reason,
      "frames",
      `${label}: frame probe did not drain normally`,
    );
    assert.ok(result.monitor.clock.drain.frames >= 2, `${label}: incomplete frame drain`);
    const acceptedRun = accepted.get(label);
    if (manifest) {
      assert.ok(acceptedRun, `${label}: run is not accepted by the batch`);
      assert.equal(acceptedRun.status, "accepted");
      assert.equal(acceptedRun.exitCode, 0);
      assert.equal(
        acceptedRun.fingerprintHash,
        manifest.fingerprint.hash,
        `${label}: source changed before run`,
      );
      assert.equal(
        acceptedRun.fingerprintAfterHash,
        manifest.fingerprint.hash,
        `${label}: source changed during run`,
      );
      assert.equal(acceptedRun.variant, variant);
      assert.equal(acceptedRun.mode ?? "trace", manifest.mode ?? "trace");
      const planned = plan.get(acceptedRun.slotId);
      assert.ok(planned, `${label}: unknown planned slot`);
      for (const key of ["variant", "size", "picker", "slot"])
        assert.equal(acceptedRun[key], planned[key], `${label}: mismatched ${key}`);
      assert.equal(
        result.driverHash,
        expectedFiles["core/benchmark/fuzzy-responsiveness-spec.js"],
        `${label}: different driver`,
      );
      for (const [name, expected] of Object.entries(acceptedRun.artifactHashes || {})) {
        if (expected === null) {
          assert.equal(acceptedRun[name], null, `${label}: unexpected ${name} artifact`);
          continue;
        }
        const artifact = path.resolve(path.dirname(manifestFile), acceptedRun[name]);
        assert.equal(fileHash(artifact), expected, `${label}: ${name} artifact changed`);
        artifactChecks++;
      }
    }
    if (!firstResult) firstResult = result;
    else {
      assert.deepEqual(result.runtime, firstResult.runtime, `${label}: runtime changed`);
      assert.equal(result.driverHash, firstResult.driverHash, `${label}: driver changed`);
      assert.deepEqual(
        result.monitor?.timerTypes,
        firstResult.monitor?.timerTypes,
        `${label}: timer providers changed`,
      );
    }
    if (!corpusCache.has(corpus)) {
      const bytes = fs.readFileSync(corpus);
      const values = JSON.parse(bytes);
      assert.ok(Array.isArray(values), "Corpus must be an array");
      corpusCache.set(corpus, { count: values.length, hash: hash(bytes) });
    }
    const corpusIdentity = corpusCache.get(corpus);
    assert.equal(result.corpusHash, corpusIdentity.hash, `${label}: corpus bytes changed`);
    if (manifest) {
      assert.equal(
        result.corpusHash,
        expectedFiles[`corpus/${path.basename(corpus)}`],
        `${label}: corpus is outside batch fingerprint`,
      );
      assert.equal(corpusIdentity.count, acceptedRun.size);
    }
    const snapshotFile = path.join(snapshot, "manifest.json");
    if (!snapshotCache.has(snapshotFile)) {
      const bytes = fs.readFileSync(snapshotFile);
      snapshotCache.set(snapshotFile, { manifest: JSON.parse(bytes), hash: hash(bytes) });
    }
    const snapshotIdentity = snapshotCache.get(snapshotFile);
    assert.deepEqual(
      result.snapshot,
      snapshotIdentity.manifest,
      `${label}: snapshot declaration changed`,
    );
    if (manifest)
      assert.equal(snapshotIdentity.hash, expectedFiles[`snapshot/${variant}/manifest.json`]);
    for (const [name, actual] of Object.entries(result.sources || {})) {
      const expected = result.snapshot.hashes[name] ?? expectedFiles?.[`core/src/${name}.js`];
      assert.ok(expected, `${label}: unaccounted loaded module ${name}`);
      assert.equal(actual, expected, `${label}: loaded module differs: ${name}`);
      sourceChecks++;
    }
    for (const [name, actual] of Object.entries(result.workerLibraryHashes || {})) {
      assert.equal(
        actual,
        result.snapshot.hashes[`fuzzy-search/lib/${name}`],
        `${label}: worker library differs: ${name}`,
      );
      sourceChecks++;
    }
    if (manifest)
      for (const [name, expected] of Object.entries(result.snapshot.hashes))
        assert.equal(
          expected,
          expectedFiles[`snapshot/${variant}/${name}`],
          `${label}: frozen module outside fingerprint: ${name}`,
        );

    const plain = acceptedRun?.mode === "plain" || acceptedRun?.trace === null;
    const analysisFile = plain ? null : file.replace(/\.json$/, "-analysis.json");
    const occurrences = new Map();
    const analysis = plain
      ? {
          taskEvidence: { source: "unavailable" },
          phases: result.samples.map((sample) => {
            const occurrence = occurrences.get(sample.id) || 0;
            occurrences.set(sample.id, occurrence + 1);
            return { id: sample.id, occurrence };
          }),
        }
      : read(analysisFile);
    if (!plain)
      assert.equal(
        path.resolve(analysis.resultFile),
        file,
        `${label}: analysis belongs to another result`,
      );
    assert.equal(
      analysis.phases.length,
      result.samples.length,
      `${label}: incomplete trace analysis`,
    );
    const run = {
      label,
      variant,
      mode: plain ? "plain" : "trace",
      size: corpusIdentity.count,
      picker: acceptedRun?.picker ?? result.config.packages?.[0] ?? null,
      file,
      analysisFile,
      slotId: acceptedRun?.slotId ?? null,
      traceTaskSource: analysis.taskEvidence.source,
      driverHash: result.driverHash,
      corpusHash: result.corpusHash,
      snapshotRefs: result.snapshot.refs,
      fingerprintHash: acceptedRun?.fingerprintHash ?? null,
      finishedAt: acceptedRun?.finishedAt ?? null,
      initialVisibility: result.monitor.clock.visibility,
      frameDrain: result.monitor.clock.drain,
    };
    runs.push(run);
    result.samples.forEach((sample, index) =>
      phases.push(collectPhase(sample, analysis.phases[index], result, run)),
    );

    for (const name of new Set((result.validation || []).map((entry) => entry.name))) {
      const key = `${name}/${run.size}`;
      const values = result.validation
        .filter((entry) => entry.name === name)
        .map(({ sample, query, count, hash: digest }) => {
          assert.ok(
            Number.isInteger(count) && count >= 0 && /^[a-f0-9]{64}$/.test(digest),
            `${label}: invalid full ordered-ID proof`,
          );
          return { sample, query, count, hash: digest };
        });
      const previous = validationByWorkload.get(key);
      if (previous)
        assert.deepEqual(
          values,
          previous.values,
          `${key}: full ordered IDs differ before/after or between repetitions`,
        );
      else validationByWorkload.set(key, { values, variants: new Set(), labels: [] });
      validationByWorkload.get(key).variants.add(variant);
      validationByWorkload.get(key).labels.push(label);
      orderedResultSetsChecked += values.length;
    }
  }
  const groups = new Map();
  for (const phase of phases) {
    const identity = {
      package: phase.package,
      traceMode: phase.traceMode,
      count: phase.count,
      contextPackage: phase.contextPackage ?? null,
      kind: phase.kind,
      mode: phase.mode,
      query: phase.query,
      callerRoute: phase.callerRoute,
    };
    const key = JSON.stringify(identity);
    if (!groups.has(key)) groups.set(key, { ...identity, before: [], after: [] });
    groups.get(key)[phase.variant].push(phase);
  }
  const comparisons = [...groups.values()].map(({ before, after, ...identity }) => {
    const variants = Object.fromEntries(
      [
        ["before", before],
        ["after", after],
      ].map(([variant, samples]) => {
        const labels = [...new Set(samples.map((sample) => sample.label))];
        return [
          variant,
          {
            ...aggregate(samples),
            perRun: labels.map((label) => ({
              label,
              ...aggregate(samples.filter((sample) => sample.label === label)),
            })),
          },
        ];
      }),
    );
    const differences = Object.fromEntries(
      Object.keys(variants.before.metrics).map((metric) => {
        const oldValue = variants.before.metrics[metric].median;
        const newValue = variants.after.metrics[metric].median;
        return [
          metric,
          {
            unit: metric.endsWith("Ms") ? "ms" : "count",
            medianChange: oldValue === null || newValue === null ? null : newValue - oldValue,
            medianRatio:
              oldValue === null || newValue === null || oldValue === 0 ? null : newValue / oldValue,
          },
        ];
      }),
    );
    return { ...identity, paired: before.length > 0 && after.length > 0, ...variants, differences };
  });
  const coveredSlots = new Set(runs.map((run) => run.slotId).filter(Boolean));
  return {
    generatedAt: new Date().toISOString(),
    series: series ?? manifest?.series ?? null,
    complete: Boolean(
      manifest && manifest.status === "complete" && coveredSlots.size === plan.size,
    ),
    provenance: {
      manifestFile: manifestFile ? path.resolve(manifestFile) : null,
      batchStatus: manifest?.status ?? null,
      fingerprintHash: manifest?.fingerprint?.hash ?? null,
      acceptedRuns: runs.length,
      expectedSlots: manifest ? plan.size : null,
      runtime: firstResult?.runtime ?? null,
      runtimeVerifiedAcrossRuns: runs.length > 1,
      driverHash: firstResult?.driverHash ?? null,
      sourceChecks,
      artifactChecks,
      acceptedRunsFingerprintVerified: Boolean(manifest),
      visibleAndFrameDrainedRuns: runs.length,
      missingSlots: manifest ? [...plan.keys()].filter((slot) => !coveredSlots.has(slot)) : null,
    },
    orderedResults: {
      method:
        "Strict count and SHA-256 equality of the provided full ordered-ID result vectors. Validation granularity is preserved as recorded; repeated timing query occurrences remain separate observations.",
      resultSetsChecked: orderedResultSetsChecked,
      workloads: Object.fromEntries(
        [...validationByWorkload].map(([key, value]) => [
          key,
          {
            paired: value.variants.has("before") && value.variants.has("after"),
            labels: value.labels,
            values: value.values,
          },
        ]),
      ),
    },
    methodology: {
      statistics:
        "Pooled phase/event quantiles use linear interpolation; per-run summaries are also retained. Repeated identical queries remain separate observations.",
      tasks:
        "maxTaskMs clips RunTask intersections to phase windows; maxWholeTaskMs retains boundary-crossing tasks. taskUnionMs is interval union wall time, not CPU time.",
      input:
        "Input delays select recorded events by event.timestamp inside the inclusive phase window, including delivery after phase end. No recorded eligible event means null, not zero delay.",
      intervals:
        "Frame and continuous timer pairs are selected by overlap with the phase. Full gaps and clipped overlap are retained with boundary flags; these intervals are not CPU durations.",
      longTasks:
        "PerformanceObserver counts are supporting evidence; absence of entries alone does not establish absence of blocking. Explicit callerRoute labels are retained without guessing callback ownership.",
      missing:
        "Absent probes and empty metric samples produce null statistics. Supported long-task reporting with no entries and measured zero GC/layout remain real zero observations.",
    },
    comparisons,
    runs,
    phases,
  };
}

module.exports = { summarize };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    const files = [];
    let directory;
    let output;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--manifest") options.manifestFile = args[++index];
      else if (args[index] === "--series") options.series = args[++index];
      else if (args[index] === "--dir") directory = args[++index];
      else if (args[index] === "--output") output = args[++index];
      else files.push(args[index]);
    }
    if (options.manifestFile && !files.length && !directory) {
      const manifest = read(options.manifestFile);
      files.push(
        ...manifest.runs.map((run) => path.resolve(path.dirname(options.manifestFile), run.output)),
      );
    }
    if (directory)
      for (const name of fs.readdirSync(directory))
        if (name.endsWith(".json") && !/-(?:analysis|input|trace|batch|summary)\.json$/.test(name))
          files.push(path.join(directory, name));
    if (!files.length)
      throw new Error("Pass result files, --dir, or --manifest; optional --series and --output");
    const result = summarize([...new Set(files.map((file) => path.resolve(file)))], options);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (output) fs.writeFileSync(output, json);
    else process.stdout.write(json);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
