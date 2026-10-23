const fs = require("node:fs");
const path = require("node:path");

// Retain one JSON event at a time while decoding large ReportEvents artifacts.
async function* readTraceEvents(filename) {
  let header = "";
  let started = false;
  let ended = false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let value = "";
  for await (let chunk of fs.createReadStream(filename, { encoding: "utf8" })) {
    if (!started) {
      header += chunk;
      const match = /"traceEvents"\s*:\s*\[/.exec(header);
      if (!match) continue;
      chunk = header.slice(match.index + match[0].length);
      header = "";
      started = true;
    }
    for (const character of chunk) {
      if (ended) break;
      if (!depth) {
        if (/\s|,/.test(character)) continue;
        if (character === "]") {
          ended = true;
          break;
        }
        if (character !== "{") throw new Error("Expected a trace event object");
        value = character;
        depth = 1;
        continue;
      }
      value += character;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        yield JSON.parse(value);
        value = "";
      }
    }
  }
  if (!started || !ended || depth) throw new Error("Incomplete traceEvents array");
}

function unionDuration(intervals) {
  const sorted = intervals.slice().sort((left, right) => left[0] - right[0]);
  let end = -Infinity;
  let total = 0;
  for (const [start, nextEnd] of sorted) {
    if (nextEnd > end) total += nextEnd - Math.max(start, end);
    end = Math.max(end, nextEnd);
  }
  return total;
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const index = Math.floor(position);
  return sorted[index] + (sorted[Math.ceil(position)] - sorted[index]) * (position - index);
}

function stats(values) {
  return { median: quantile(values, 0.5), p95: quantile(values, 0.95), max: quantile(values, 1) };
}

function seriesKey(id) {
  return id.replace(/\/query\/\d+\//, "/query/").replace(/\/\d+$/, "");
}

async function analyze(resultFile, traceFile) {
  const result = JSON.parse(await fs.promises.readFile(resultFile, "utf8"));
  const samples = result.samples || result.monitor?.measurements || [];
  const sampleIds = new Set(samples.map((sample) => sample.id));
  const threadNames = new Map();
  const markers = [];
  const spans = [];
  const boundaries = new Map();
  const eventNames = new Map();
  let count = 0;
  for await (const event of readTraceEvents(traceFile)) {
    count++;
    const thread = `${event.pid}:${event.tid}`;
    if (event.name === "thread_name") threadNames.set(thread, event.args.name);
    if (event.name === "TimeStamp") {
      const message = event.args?.data?.message ?? event.args?.data?.name;
      const marker = /^(.*):(start|end)$/.exec(message || "");
      if (marker && sampleIds.has(marker[1]))
        markers.push({ id: marker[1], edge: marker[2], ts: event.ts, thread });
    }
    if (event.ph === "X" && event.dur >= 0) {
      spans.push({
        thread,
        name: event.name,
        category: event.cat || "",
        start: event.ts,
        end: event.ts + event.dur,
      });
    } else if (event.ph === "B" || event.ph === "E") {
      if (!boundaries.has(thread)) boundaries.set(thread, []);
      boundaries.get(thread).push({
        phase: event.ph,
        name: event.name,
        category: event.cat || "",
        ts: event.ts,
      });
    }
    const key = `${event.ph}:${event.name || "(unnamed)"}`;
    eventNames.set(key, (eventNames.get(key) || 0) + 1);
  }

  const markedThreads = new Set(markers.map((marker) => marker.thread));
  const rendererThreads = [...markedThreads].filter(
    (thread) => threadNames.get(thread) === "CrRendererMain",
  );
  if (rendererThreads.length !== 1)
    throw new Error(`Expected one phase-marked CrRendererMain, found ${rendererThreads.length}`);
  const thread = rendererThreads[0];
  const stack = [];
  let unmatchedEnds = 0;
  for (const boundary of (boundaries.get(thread) || []).sort((a, b) => a.ts - b.ts)) {
    if (boundary.phase === "B") stack.push(boundary);
    else if (!stack.length) unmatchedEnds++;
    else {
      const begin = stack.pop();
      if (boundary.name && boundary.name !== begin.name)
        throw new Error(`Mismatched trace boundary: ${begin.name} / ${boundary.name}`);
      if (boundary.ts >= begin.ts)
        spans.push({
          thread,
          name: begin.name,
          category: begin.category,
          start: begin.ts,
          end: boundary.ts,
        });
    }
  }
  const renderer = spans.filter((span) => span.thread === thread);
  let tasks = renderer.filter((span) => span.name === "RunTask");
  let taskSource = "RunTask";
  if (!tasks.length) {
    tasks = renderer.filter((span) => span.category.split(",").includes("toplevel"));
    taskSource = tasks.length ? "toplevel category" : "unavailable";
  }
  const outerTasks = [];
  for (const task of tasks.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = outerTasks.at(-1);
    if (previous && task.start >= previous.start && task.end <= previous.end) continue;
    outerTasks.push(task);
  }

  const phaseMarkers = new Map();
  for (const marker of markers
    .filter((item) => item.thread === thread)
    .sort((a, b) => a.ts - b.ts)) {
    const occurrences = phaseMarkers.get(marker.id) || [];
    let phase = occurrences.at(-1);
    if (marker.edge === "start") {
      if (phase && phase.end == null) throw new Error(`Overlapping phase marker ${marker.id}`);
      phase = { start: marker.ts };
      occurrences.push(phase);
    } else {
      if (!phase || phase.end != null) throw new Error(`Unpaired phase end ${marker.id}`);
      phase.end = marker.ts;
    }
    phaseMarkers.set(marker.id, occurrences);
  }
  const occurrenceById = new Map();
  const pairedSamples = samples.map((sample) => {
    const occurrence = occurrenceById.get(sample.id) || 0;
    occurrenceById.set(sample.id, occurrence + 1);
    return { sample, occurrence, marker: phaseMarkers.get(sample.id)?.[occurrence] };
  });
  const offsetSamples = pairedSamples.flatMap(({ sample, marker }) => {
    return marker?.start == null ? [] : [marker.start - sample.start * 1000];
  });
  const offsetUs = quantile(offsetSamples, 0.5);
  const isGc = (span) => /^(?:V8\.GC|MinorGC$|MajorGC$)/.test(span.name);
  const isLayout = (span) =>
    ["Layout", "UpdateLayoutTree", "RecalculateStyles"].includes(span.name);
  const isPaint = (span) =>
    ["Paint", "PrePaint", "Layerize", "CompositeLayers"].includes(span.name);
  const phases = pairedSamples.map(({ sample, occurrence, marker }) => {
    if (marker?.start == null || marker.end == null || marker.end < marker.start)
      return { id: sample.id, error: "Missing or reversed phase markers" };
    const clip = (span) => [Math.max(marker.start, span.start), Math.min(marker.end, span.end)];
    const overlapping = (list) =>
      list.filter((span) => span.start < marker.end && span.end > marker.start);
    const active = overlapping(renderer);
    const phaseTasks = overlapping(outerTasks);
    const taskIntervals = phaseTasks.map(clip);
    const gc = active.filter(isGc).map(clip);
    const layout = active.filter(isLayout).map(clip);
    const paint = active.filter(isPaint).map(clip);
    const longestTask = taskIntervals.reduce(
      (maximum, [start, end]) => Math.max(maximum, end - start),
      0,
    );
    return {
      id: sample.id,
      occurrence,
      durationMs: sample.duration,
      syncMs: sample.sync,
      legacyGapMs: sample.legacy?.gap ?? null,
      legacyTailMs: sample.legacy?.tail ?? null,
      traceStartUs: marker.start,
      traceEndUs: marker.end,
      traceDurationMs: (marker.end - marker.start) / 1000,
      markerDurationDifferenceMs: (marker.end - marker.start) / 1000 - sample.duration,
      startClockResidualUs: marker.start - sample.start * 1000 - offsetUs,
      endClockResidualUs: marker.end - sample.end * 1000 - offsetUs,
      taskCount: taskSource === "unavailable" ? null : taskIntervals.length,
      maxTaskMs: taskSource === "unavailable" ? null : longestTask / 1000,
      maxWholeTaskMs:
        taskSource === "unavailable"
          ? null
          : phaseTasks.reduce((maximum, task) => Math.max(maximum, task.end - task.start), 0) /
            1000,
      boundaryTaskCount:
        taskSource === "unavailable"
          ? null
          : phaseTasks.filter((task) => task.start < marker.start || task.end > marker.end).length,
      taskUnionMs: taskSource === "unavailable" ? null : unionDuration(taskIntervals) / 1000,
      gcUnionMs: unionDuration(gc) / 1000,
      styleLayoutUnionMs: unionDuration(layout) / 1000,
      paintUnionMs: unionDuration(paint) / 1000,
      gcOrStyleLayoutUnionMs: unionDuration(gc.concat(layout)) / 1000,
      workerEvents: sample.workerEvents || [],
    };
  });
  const grouped = new Map();
  for (const phase of phases) {
    const key = seriesKey(phase.id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(phase);
  }
  const metrics = [
    "durationMs",
    "syncMs",
    "legacyGapMs",
    "maxTaskMs",
    "maxWholeTaskMs",
    "boundaryTaskCount",
    "taskUnionMs",
    "gcUnionMs",
    "styleLayoutUnionMs",
    "paintUnionMs",
  ];
  return {
    resultFile: path.resolve(resultFile),
    traceFile: path.resolve(traceFile),
    eventCount: count,
    renderer: { thread, name: threadNames.get(thread) },
    taskEvidence: {
      source: taskSource,
      names: [...new Set(outerTasks.map((task) => task.name))],
      completeTasks: outerTasks.length,
      unmatchedBeginEvents: stack.length,
      unmatchedEndEvents: unmatchedEnds,
    },
    clockAlignment: { traceMinusPerformanceUs: offsetUs, startOffsets: stats(offsetSamples) },
    methodology: {
      tasks:
        "Complete X and paired B/E spans; maxTaskMs and taskUnionMs clip outer task intersections to TimeStamp phase boundaries. maxWholeTaskMs retains entire intersecting tasks, including boundary carry-in/out. Durations are wall time, not CPU time. Missing task boundaries produce null, not zero.",
      categories:
        "GC, style/layout and paint are interval unions on the measured CrRendererMain. Nested GC events are not added together. Categories may overlap; use gcOrStyleLayoutUnionMs for their combined occupancy.",
      clock:
        "Median start-marker timestamp minus performance.now()*1000. End markers follow timer cleanup, so residuals include marker overhead. No wall-clock timeOrigin conversion is assumed.",
      quantiles: "Linearly interpolated sample quantiles.",
    },
    groups: Object.fromEntries(
      [...grouped].map(([key, values]) => [
        key,
        {
          samples: values.length,
          errors: values.filter((value) => value.error).length,
          ...Object.fromEntries(
            metrics.map((metric) => [
              metric,
              stats(values.map((value) => value[metric]).filter(Number.isFinite)),
            ]),
          ),
        },
      ]),
    ),
    phases,
  };
}

module.exports = { analyze, readTraceEvents };

if (require.main === module) {
  const [resultFile, traceFile, outputFile] = process.argv.slice(2);
  if (!resultFile || !traceFile) {
    console.error(
      "Usage: node fuzzy-responsiveness-analyze.js result.json trace.json [output.json]",
    );
    process.exitCode = 1;
  } else {
    analyze(resultFile, traceFile)
      .then((result) => {
        const json = JSON.stringify(result, null, 2);
        if (outputFile) fs.writeFileSync(outputFile, `${json}\n`);
        else console.log(json);
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  }
}
