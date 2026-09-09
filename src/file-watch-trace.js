// Opt-in diagnostics for correlating native delivery, worker reconciliation,
// IPC queueing and renderer acknowledgements. No tracing runs by default.
function createFileWatchTrace(component) {
  if (process.env.LUMINE_FILE_WATCH_TRACE !== "1") return null;
  let filter;
  if (process.env.LUMINE_FILE_WATCH_TRACE_FILTER) {
    try {
      filter = new RegExp(process.env.LUMINE_FILE_WATCH_TRACE_FILTER);
    } catch {
      // An invalid optional filter must not change filesystem observation.
    }
  }
  let sequence = 0;
  return (event, details = {}) => {
    const record = {
      component,
      event,
      pid: process.pid,
      traceSequence: ++sequence,
      time: new Date().toISOString(),
      monotonic: process.hrtime.bigint().toString(),
      ...details,
    };
    let json = JSON.stringify(record, (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (Array.isArray(value) && value.length > 32) {
        return { count: value.length, first: value.slice(0, 32) };
      }
      return value;
    });
    if (json.length > 16000) {
      json = JSON.stringify({
        component,
        event,
        pid: process.pid,
        traceSequence: sequence,
        time: record.time,
        monotonic: record.monotonic,
        id: details.id,
        path: details.path?.slice(0, 1024),
        truncated: true,
        originalLength: json.length,
        preview: json.slice(0, 6000),
      });
    }
    if (!filter || filter.test(json)) console.error(`FILE_WATCH_TRACE ${json}`);
  };
}

function summarizeFileWatchPayload(payload) {
  return Array.isArray(payload)
    ? { eventCount: payload.length, events: payload.slice(0, 24) }
    : payload;
}

module.exports = { createFileWatchTrace, summarizeFileWatchPayload };
