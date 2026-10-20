// Diagnostic only. Measures synchronous call spans separately from promise
// latency; never records document contents, paths, nodes or provider payloads.
module.exports = function installProbe({ core, packagePaths }) {
  const path = require("node:path");
  const requireCore = require("node:module").createRequire(path.join(core, "package.json"));
  const { Parser, Tree } = requireCore("web-tree-sitter");
  const restores = [],
    signals = new WeakMap(),
    records = [];
  let phase = "opening";
  const totals = {};
  function record(name, at, duration, extra) {
    const key = `${phase}:${name}`;
    const stat = (totals[key] ??= { count: 0, totalMs: 0, maxMs: 0 });
    stat.count++;
    stat.totalMs += duration;
    stat.maxMs = Math.max(stat.maxMs, duration);
    if (duration >= 8 && records.length < 2000)
      records.push({ phase, name, at, ms: duration, ...extra });
  }
  function wrap(object, key, name, before) {
    const original = object?.[key];
    if (typeof original !== "function") return;
    object[key] = function (...args) {
      before?.call(this, args);
      const at = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        record(name, at, performance.now() - at);
      }
    };
    restores.push(() => {
      object[key] = original;
    });
  }
  const Mode = requireCore("./src/tree-sitter-language-mode");
  const DocumentParser = requireCore("./src/tree-sitter-parser");
  const Presentation = requireCore("./src/tree-sitter-presentation");
  for (const key of ["copy", "delete", "getChangedRanges"])
    wrap(Tree.prototype, key, `tree.${key}`);
  wrap(Parser.prototype, "parse", "wasm.parse");
  wrap(DocumentParser.prototype, "begin", "parser.begin");
  wrap(DocumentParser.prototype, "resetPending", "parser.reset");
  for (const key of ["parse", "parseAsync"])
    wrap(Mode.prototype, key, `mode.${key}`, (args) => {
      const signal = args[3]?.signal;
      if (signal) signals.set(signal, "syntax");
    });
  for (const key of ["publishCurrentLayers", "finishTransactionUpdate"])
    wrap(Mode.prototype, key, `syntax.${key}`);
  wrap(Presentation.prototype, "flush", "presentation.flush");
  const packageRequire = (name, file) => {
    if (!packagePaths[name]) return null;
    return require(path.join(packagePaths[name], file));
  };
  const Registry = packageRequire("symbol", "lib/registry");
  for (const key of ["cacheFileBundle", "buildFileSymbolTree", "runFileFetch"])
    wrap(Registry?.prototype, key, `symbol.${key}`);
  wrap(packageRequire("breadcrumbs", "lib/symbol-path"), "prepare", "breadcrumbs.prepare");
  const Completion = packageRequire("ide", "lib/completion-provider");
  wrap(Completion?.prototype, "suggestionsForRequest", "lsp.completion", (args) => {
    if (args[1]) signals.set(args[1], "lsp-completion");
  });
  const originalAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function (...args) {
    const already = this.signal.aborted;
    const category = signals.get(this.signal) ?? "other";
    const at = performance.now();
    try {
      return originalAbort.apply(this, args);
    } finally {
      record(`abort.${category}.${already ? "repeated" : "active"}`, at, performance.now() - at);
    }
  };
  restores.push(() => {
    AbortController.prototype.abort = originalAbort;
  });
  wrap(JSON, "parse", "json.parse");
  return {
    phase(value) {
      phase = value;
    },
    snapshot() {
      return { totals: structuredClone(totals), slowCalls: records.slice() };
    },
    dispose() {
      for (const restore of restores.reverse()) restore();
    },
  };
};
