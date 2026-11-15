// Worker-only diagnostic analysis module. Never retain an analysis context:
// its request signal expires as soon as analyzeSyntax() returns.
const { randomUUID } = require("node:crypto");
const { inspect } = require("../syntax-system-spec");
let active = null;

const post = (session, method, params = {}) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
  });

function finish(state) {
  if (!state.session && !state.finishing) return Promise.resolve(null);
  if (state.finishing) return state.finishing;
  clearTimeout(state.timer);
  state.finishing = (async () => {
    try {
      return (await post(state.session, "Profiler.stop")).profile;
    } finally {
      state.session.disconnect();
      state.session = null;
    }
  })();
  // A watchdog may finish before a later stop request retrieves the profile.
  state.finishing.catch(() => {});
  return state.finishing;
}

function operationDelta(before, after) {
  const result = {};
  const earlier = before?.resources?.operations ?? {};
  for (const [name, entry] of Object.entries(after?.resources?.operations ?? {})) {
    const prior = earlier[name] ?? {};
    result[name] = {};
    for (const field of ["calls", "synchronousMs"])
      if (Number.isFinite(entry[field])) result[name][field] = entry[field] - (prior[field] ?? 0);
  }
  return result;
}

exports.start = async (context, params = {}) => {
  if (active) throw new Error("A syntax CPU profile is already active");
  context.signal?.throwIfAborted();
  const intervalMicros = params.intervalMicros ?? 1000;
  const maxDurationMs = params.maxDurationMs ?? 120000;
  if (!Number.isSafeInteger(intervalMicros) || intervalMicros < 100 || intervalMicros > 100000)
    throw new RangeError("Invalid CPU sampling interval");
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 300000)
    throw new RangeError("Invalid CPU profile duration");
  const state = {
    token: randomUUID(),
    label: String(params.label ?? "syntax-input"),
    intervalMicros,
    before: inspect(context),
    expired: false,
  };
  try {
    const { Session } = require("node:inspector");
    state.session = new Session();
    state.session.connect();
    await post(state.session, "Profiler.enable");
    await post(state.session, "Profiler.setSamplingInterval", { interval: intervalMicros });
    await post(state.session, "Profiler.start");
    context.signal?.throwIfAborted();
    active = state;
    state.timer = setTimeout(() => {
      state.expired = true;
      finish(state);
    }, maxDurationMs);
    return {
      supported: true,
      token: state.token,
      label: state.label,
      mechanism: "inspector",
      intervalMicros,
      before: state.before,
    };
  } catch (error) {
    state.session?.disconnect();
    state.session = null;
    if (error.name === "AbortError") throw error;
    state.mechanism = "resource-counters";
    state.samplingUnsupported = String(error);
    active = state;
    return {
      supported: true,
      token: state.token,
      label: state.label,
      mechanism: state.mechanism,
      samplingUnsupported: state.samplingUnsupported,
      before: state.before,
    };
  }
};

exports.stop = async (context, { token } = {}) => {
  const state = active;
  if (!state || state.token !== token) throw new Error("Syntax CPU profile token is unavailable");
  try {
    const cpuProfile = await finish(state);
    const after = inspect(context);
    return {
      supported: true,
      token: state.token,
      label: state.label,
      intervalMicros: state.intervalMicros,
      mechanism: state.mechanism ?? "inspector",
      samplingUnsupported: state.samplingUnsupported,
      expired: state.expired,
      cpuProfile,
      before: state.before,
      after,
      operationsDelta: operationDelta(state.before, after),
    };
  } finally {
    if (active === state) active = null;
  }
};
