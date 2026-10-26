const MIB = 1024 * 1024;

function resourceContext(context) {
  const result = {};
  for (const key of ["session", "revision", "bufferLength", "scopeName", "operation"]) {
    const value = context?.[key];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
      result[key] = value;
  }
  return result;
}

// Linear-memory capacity is a high-water mark, not live allocations. These
// limits protect the shared runtime; they never claim to measure a document's
// retained bytes. Active parser time excludes scheduling and transport waits.
class SyntaxResourcePolicy {
  constructor({
    maximumMemoryBytes = 2048 * MIB,
    memoryPressureRatio = 0.85,
    parseTimeLimitMs = 30000,
    recycleMemoryBytes = 512 * MIB,
    recycleGrowthBytes = 64 * MIB,
    now = () => performance.now(),
  } = {}) {
    if (!Number.isSafeInteger(maximumMemoryBytes) || maximumMemoryBytes <= 0)
      throw new RangeError("Invalid syntax memory limit");
    if (!(memoryPressureRatio > 0 && memoryPressureRatio < 1))
      throw new RangeError("Invalid syntax memory pressure ratio");
    for (const value of [parseTimeLimitMs, recycleMemoryBytes, recycleGrowthBytes])
      if (!Number.isFinite(value) || value <= 0)
        throw new RangeError("Invalid syntax resource limit");
    this.maximumMemoryBytes = maximumMemoryBytes;
    this.memoryPressureBytes = Math.floor(maximumMemoryBytes * memoryPressureRatio);
    this.parseTimeLimitMs = parseTimeLimitMs;
    this.recycleMemoryBytes = recycleMemoryBytes;
    this.recycleGrowthBytes = recycleGrowthBytes;
    this.now = now;
    this.sessions = new Map();
    this.operations = new Map();
    this.allocatedMemoryBytes = 0;
    this.initialAllocatedMemoryBytes = null;
    this.peakAllocatedMemoryBytes = 0;
    this.recycleRequested = false;
  }

  sampleMemory(bytes) {
    if (Number.isSafeInteger(bytes) && bytes >= 0) {
      if (bytes > 0 && this.initialAllocatedMemoryBytes === null)
        this.initialAllocatedMemoryBytes = bytes;
      this.allocatedMemoryBytes = bytes;
      this.peakAllocatedMemoryBytes = Math.max(this.peakAllocatedMemoryBytes, bytes);
    }
    return this.allocatedMemoryBytes;
  }

  beginParse(context, memoryBytes) {
    this.sampleMemory(memoryBytes);
    context = resourceContext(context);
    let session;
    let revision;
    if (context?.session != null) {
      session = this.sessions.get(context.session);
      if (!session) {
        session = { allocatedGrowthBytes: 0, revision: null };
        this.sessions.set(context.session, session);
      }
      if (session.revision && session.revision.value === context.revision)
        revision = session.revision;
      else {
        revision = { value: context.revision, activeParseMs: 0 };
        // An obsolete parse may finish after a new revision has started. Its
        // measurements cannot reset or consume the current revision's budget.
        if (
          session.revision === null ||
          !Number.isFinite(context.revision) ||
          !Number.isFinite(session.revision.value) ||
          context.revision > session.revision.value
        )
          session.revision = revision;
      }
    }
    return {
      context,
      session,
      revision,
      started: this.now(),
      memoryAtStart: this.allocatedMemoryBytes,
      failure: null,
      ended: false,
    };
  }

  shouldStopParse(slice, memoryBytes) {
    if (slice.ended) return Boolean(slice.failure);
    this.sampleMemory(memoryBytes);
    if (slice.failure) return true;
    const activeParseMs = (slice.revision?.activeParseMs ?? 0) + this.elapsed(slice);
    let code;
    let message;
    if (this.underMemoryPressure()) {
      code = "memory-pressure";
      message = "Syntax analysis stopped before the shared WebAssembly memory limit.";
      this.recycleRequested = true;
    } else if (slice.revision && activeParseMs >= this.parseTimeLimitMs) {
      code = "parse-budget";
      message =
        "Syntax analysis exceeded the active parsing time budget for this document revision.";
    }
    if (!code) return false;
    slice.failure = Object.freeze({
      ...slice.context,
      code,
      fatal: false,
      recycle: code === "memory-pressure",
      message,
      memoryBytes: this.allocatedMemoryBytes,
      allocatedMemoryBytes: this.allocatedMemoryBytes,
      initialAllocatedMemoryBytes: this.initialAllocatedMemoryBytes,
      memoryMeasurement: "allocated-wasm-capacity",
      memoryLimitBytes: this.maximumMemoryBytes,
      memoryPressureBytes: this.memoryPressureBytes,
      activeParseMs,
      parseTimeLimitMs: this.parseTimeLimitMs,
    });
    return true;
  }

  endParse(slice, memoryBytes) {
    if (slice.ended) return slice.failure;
    this.shouldStopParse(slice, memoryBytes);
    const duration = this.elapsed(slice);
    if (slice.revision) slice.revision.activeParseMs += duration;
    if (slice.session)
      slice.session.allocatedGrowthBytes += Math.max(
        0,
        this.allocatedMemoryBytes - slice.memoryAtStart,
      );
    slice.ended = true;
    return slice.failure;
  }

  elapsed(slice) {
    return Math.max(0, this.now() - slice.started);
  }

  underMemoryPressure() {
    // A runtime may reserve its complete maximum at startup, especially in
    // fault-injection tests. Capacity then reveals nothing about free space.
    // Only observed growth beyond the initial reservation supports this guard;
    // fixed-memory runtimes keep the existing hard allocation-failure path.
    return (
      this.initialAllocatedMemoryBytes !== null &&
      this.allocatedMemoryBytes > this.initialAllocatedMemoryBytes &&
      this.allocatedMemoryBytes >= this.memoryPressureBytes
    );
  }

  recordOperation(operation, durationMs, memoryBytes) {
    this.sampleMemory(memoryBytes);
    // Operation names originate in the RPC protocol or packages. Bound their
    // cardinality so diagnostics cannot grow with arbitrary method names.
    let name = typeof operation === "string" ? operation.slice(0, 80) : "unknown";
    if (!this.operations.has(name) && this.operations.size >= 31) name = "other";
    let entry = this.operations.get(name);
    if (!entry) {
      entry = { calls: 0, synchronousMs: 0, longestSynchronousMs: 0 };
      this.operations.set(name, entry);
    }
    const elapsed = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    entry.calls++;
    entry.synchronousMs += elapsed;
    entry.longestSynchronousMs = Math.max(entry.longestSynchronousMs, elapsed);
  }

  releaseSession(id, memoryBytes) {
    this.sampleMemory(memoryBytes);
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (
      session?.allocatedGrowthBytes >= this.recycleGrowthBytes &&
      this.allocatedMemoryBytes >= this.recycleMemoryBytes
    )
      this.recycleRequested = true;
    return this.recycleRequested;
  }

  state(memoryBytes) {
    this.sampleMemory(memoryBytes);
    return {
      allocatedMemoryBytes: this.allocatedMemoryBytes,
      initialAllocatedMemoryBytes: this.initialAllocatedMemoryBytes,
      peakAllocatedMemoryBytes: this.peakAllocatedMemoryBytes,
      memoryMeasurement: "allocated-wasm-capacity",
      memoryLimitBytes: this.maximumMemoryBytes,
      memoryPressureBytes: this.memoryPressureBytes,
      underMemoryPressure: this.underMemoryPressure(),
      recycleRequested: this.recycleRequested,
      trackedSessions: this.sessions.size,
      sessions: [...this.sessions].map(([id, session]) => ({
        id,
        revision: session.revision?.value ?? null,
        activeParseMs: session.revision?.activeParseMs ?? 0,
        // Growth observed during this session's synchronous slices is a
        // recycling heuristic, never an estimate of its retained memory.
        observedCapacityGrowthBytes: session.allocatedGrowthBytes,
      })),
      operations: Object.fromEntries(
        [...this.operations].map(([name, entry]) => [name, { ...entry }]),
      ),
    };
  }
}

class SyntaxResourceLimitError extends Error {
  constructor(failure) {
    super(failure.message);
    this.name = "SyntaxResourceLimitError";
    this.code = failure.code;
    this.failure = failure;
  }
}

module.exports = { SyntaxResourcePolicy, SyntaxResourceLimitError };
