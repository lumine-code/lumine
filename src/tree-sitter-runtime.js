const fs = require("node:fs/promises");
const { Emitter } = require("@lumine-code/event-kit");
const { Parser } = require("web-tree-sitter");

// One runtime belongs to one execution environment. After an abort or trap its
// memory is never reused: the renderer replaces the entire syntax worker.
class TreeSitterRuntime {
  constructor({ maximumPages = 32768 } = {}) {
    this.maximumPages = maximumPages;
    this.context = null;
    this.buffers = new WeakMap();
    this.emitter = new Emitter();
    this.messages = [];
    this.failure = null;
  }

  initialize() {
    this.assertHealthy();
    return (this.initializing ??= (async () => {
      this.memory = new WebAssembly.Memory({ initial: 512, maximum: this.maximumPages });
      const wasmBinary = await fs.readFile(require.resolve("web-tree-sitter/web-tree-sitter.wasm"));
      await Parser.init({
        wasmBinary,
        wasmMemory: this.memory,
        printErr: (message) => {
          this.messages.push(String(message).slice(0, 2000));
          if (this.messages.length > 8) this.messages.shift();
        },
        onAbort: (reason) =>
          this.fail(new Error(`WebAssembly aborted: ${reason || "unknown reason"}`), true),
      });
    })().catch((error) => {
      if (!this.failure) this.initializing = null;
      throw error;
    }));
  }

  registerBuffer(buffer, context) {
    this.buffers.set(buffer, context);
  }

  contextForBuffer(buffer, scopeName) {
    const context = this.buffers.get(buffer)?.();
    return context && { ...context, scopeName: scopeName ?? context.scopeName, operation: "parse" };
  }

  run(context, callback) {
    this.assertHealthy();
    // WASM calls are synchronous. Carry their owner explicitly across parser
    // slices, and capture it in asynchronous rejection handlers. Do not retain
    // a global owner across awaits or depend on Node async-context frames in
    // Chromium's renderer/worker isolates.
    const previous = this.context;
    const current = context ?? previous;
    this.context = current;
    try {
      const result = callback();
      if (result?.then)
        return result.catch((error) => {
          this.observe(error, current);
          throw error;
        });
      return result;
    } catch (error) {
      this.observe(error, current);
      throw error;
    } finally {
      this.context = previous;
    }
  }

  observe(error, context = this.context) {
    for (let cause = error, depth = 0; cause && depth < 16; cause = cause.cause, depth++) {
      if (cause instanceof WebAssembly.RuntimeError) {
        this.fail(cause, false, context);
        this.reportFailure(context);
        break;
      }
    }
  }

  fail(error, aborted = false, context = this.context) {
    if (this.failure) return;
    const memoryBytes = this.memory?.buffer.byteLength ?? null;
    this.failure = Object.freeze({
      ...context,
      code: aborted && memoryBytes >= this.maximumPages * 65536 ? "memory-limit" : "wasm-failure",
      fatal: true,
      message: error.message,
      stack: error.stack,
      memoryBytes,
      memoryLimitBytes: this.maximumPages * 65536,
      diagnostics: this.messages.join("\n"),
    });
    if (context?.session != null) this.reportFailure(context);
    else {
      // An abort after an await reaches its owning operation's rejection
      // handler before the next task. Unobserved faults still stop the worker,
      // with unknown attribution instead of blaming another pending document.
      this.reportTimer = setImmediate(() => this.reportFailure());
    }
  }

  reportFailure(context) {
    if (!this.failure || this.reported) return;
    if (this.failure.session == null && context)
      this.failure = Object.freeze({ ...this.failure, ...context });
    this.reported = true;
    clearImmediate(this.reportTimer);
    this.emitter.emit("failure", this.failure);
  }

  assertHealthy() {
    if (this.failure)
      throw Object.assign(new Error(this.failure.message), { name: "SyntaxUnavailableError" });
  }

  onDidFail(callback) {
    return this.emitter.on("failure", callback);
  }
}

module.exports = new TreeSitterRuntime();
module.exports.TreeSitterRuntime = TreeSitterRuntime;
