"use strict";

const { Disposable } = require("event-kit");

// Source normalization and the run lifecycle for one mounted view.
//
// Contract highlights (design doc §3.4 + amendment A4):
//   * `deliver`/`progress`/`fail`/`done` are silent no-ops once the run's
//     signal has aborted — that is what lets consumers delete their hand-rolled
//     "am I still visible?" guards after every await.
//   * A `Disposable` returned from `run` (or resolved from it) is disposed when
//     the run aborts, so streaming jobs have a teardown channel.
//   * Deliveries are coalesced onto a microtask rather than an animation frame
//     or a timer: rAF is throttled to roughly 1 Hz in headless Electron windows
//     and cannot be driven by the spec harness, and a timer would deadlock
//     `await session.refresh()` under the harness's fake clock.

const DEFAULT_DYNAMIC_DEBOUNCE = 150;

function normalizeSource(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return { dynamic: false, run: (req) => req.deliver(value, { done: true }) };
  }
  if (typeof value.then === "function") {
    return {
      dynamic: false,
      run: (req) => value.then((items) => req.deliver(items ?? [], { done: true })),
    };
  }
  if (typeof value === "function") {
    return { dynamic: false, run: value };
  }
  if (typeof value.run === "function") {
    return {
      dynamic: !!value.dynamic,
      debounce: value.debounce,
      rematch: !!value.rematch,
      run: value.run.bind(value),
    };
  }
  throw new TypeError("modals: `source` must be an array, promise, function, or {run}");
}

const sources = {
  array(items) {
    return { dynamic: false, run: (req) => req.deliver(items, { done: true }) };
  },

  promise(fn) {
    return {
      dynamic: false,
      run: async (req) => {
        const items = await fn(req);
        req.deliver(items ?? [], { done: true });
      },
    };
  },

  stream(fn) {
    return { dynamic: false, run: fn };
  },

  dynamic(fn, opts = {}) {
    return {
      dynamic: true,
      debounce: opts.debounce ?? DEFAULT_DYNAMIC_DEBOUNCE,
      rematch: !!opts.rematch,
      run: async (req) => {
        const items = await fn(req);
        req.deliver(items ?? [], { done: true });
      },
    };
  },

  // Interleaves several sources, preserving declaration order and emitting as
  // each part lands. Backs multi-provider aggregation (e.g. symbol providers).
  concat(...parts) {
    const normalized = parts.map(normalizeSource).filter(Boolean);
    return {
      dynamic: normalized.some((source) => source.dynamic),
      run: async (req) => {
        const buckets = normalized.map(() => []);
        let settled = 0;
        const flush = () => {
          req.deliver(buckets.flat(), { done: settled === normalized.length });
        };
        await Promise.all(
          normalized.map(async (source, index) => {
            const sub = {
              ...req,
              deliver(items, opts = {}) {
                if (opts.mode === "append") buckets[index].push(...items);
                else buckets[index] = items.slice();
                flush();
              },
              done() {},
            };
            try {
              const result = await source.run(sub);
              if (Array.isArray(result)) {
                buckets[index] = result.slice();
              }
            } finally {
              settled++;
              flush();
            }
          }),
        );
      },
    };
  },

  // Runs `fn` once and reuses the result until `invalidate` fires. This is how
  // a picker over a 100k-path crawl avoids re-indexing on every open.
  cached(fn, opts = {}) {
    let cache = null;
    let subscribed = false;
    const invalidate = () => {
      cache = null;
    };
    return {
      dynamic: false,
      invalidate,
      run: async (req) => {
        if (!subscribed && opts.invalidate) {
          subscribed = true;
          opts.invalidate(invalidate);
        }
        if (cache) {
          req.deliver(cache, { done: true });
          return;
        }
        const items = (await fn(req)) ?? [];
        cache = items;
        req.deliver(items, { done: true });
      },
    };
  },
};

// One in-flight execution of a source. Owns its abort signal, its coalescing
// timer, and the disposable a streaming source hands back.
class SourceRun {
  constructor({
    source,
    session,
    query,
    params,
    generation,
    onDeliver,
    onProgress,
    onFail,
    onDone,
  }) {
    this.source = source;
    this.session = session;
    this.query = query;
    this.params = params;
    this.generation = generation;
    this.onDeliver = onDeliver;
    this.onProgress = onProgress;
    this.onFail = onFail;
    this.onDone = onDone;

    this.controller = new AbortController();
    this.pending = null;
    this.pendingMode = "replace";
    this.pendingDone = false;
    this.flushScheduled = false;
    this.teardown = null;
    this.finished = false;
    this.settled = null;
  }

  get signal() {
    return this.controller.signal;
  }

  get aborted() {
    return this.controller.signal.aborted;
  }

  request() {
    const run = this;
    return {
      query: this.query,
      signal: this.controller.signal,
      session: this.session,
      params: this.params,
      deliver(items, opts = {}) {
        if (run.aborted) return;
        run.queue(items ?? [], opts);
      },
      progress(status) {
        if (run.aborted) return;
        run.onProgress(status);
      },
      chrome(patch) {
        if (run.aborted) return;
        run.onProgress(patch);
      },
      fail(error) {
        if (run.aborted) return;
        run.onFail(error);
      },
      done() {
        if (run.aborted) return;
        run.queue(null, { done: true });
      },
    };
  }

  queue(items, opts) {
    if (items) {
      if (opts.mode === "append" && this.pending) {
        this.pending = this.pending.concat(items);
      } else if (opts.mode === "append" && !this.pending) {
        this.pending = { append: items };
      } else {
        this.pending = items;
        this.pendingMode = "replace";
      }
      if (opts.mode === "append") this.pendingMode = "append";
    }
    if (opts.done) this.pendingDone = true;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // A microtask, not a timer: it still merges every `deliver()` a source
    // makes in one synchronous burst — the actual goal — while draining on its
    // own. A timer would make `await session.refresh()` deadlock under the
    // spec harness's fake clock, which only advances when the spec body runs.
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  flush() {
    if (this.aborted) return;
    const items = this.pending;
    const mode = this.pendingMode;
    const done = this.pendingDone;
    this.pending = null;
    this.pendingMode = "replace";
    this.pendingDone = false;
    if (items) {
      const list = Array.isArray(items) ? items : items.append;
      this.onDeliver(list, mode);
    }
    if (done) this.markDone();
  }

  // Forces any queued delivery out immediately, without waiting for the
  // microtask. Specs use this to assert coalescing deterministically.
  flushNow() {
    this.flushScheduled = false;
    this.flush();
  }

  markDone() {
    if (this.finished) return;
    this.finished = true;
    this.onDone();
    if (this.resolveSettled) this.resolveSettled();
  }

  // Resolves on the first of done / abort — never on stream completion, so a
  // never-ending source cannot hang `await session.refresh()`.
  whenSettled() {
    if (this.finished || this.aborted) return Promise.resolve();
    if (!this.settled) {
      this.settled = new Promise((resolve) => {
        this.resolveSettled = resolve;
      });
    }
    return this.settled;
  }

  async start() {
    const req = this.request();
    try {
      const result = await this.source.run(req);
      if (this.aborted) return;
      if (Array.isArray(result)) {
        this.queue(result, { done: true });
      } else if (result && typeof result.dispose === "function") {
        this.teardown = result;
        if (this.aborted) this.disposeTeardown();
      } else if (result === undefined && !this.finished && !this.source.dynamic) {
        // A run that neither delivered nor returned items has nothing more to
        // say; treat its return as completion so `busy` chrome clears.
        this.queue(null, { done: true });
      }
    } catch (error) {
      if (this.aborted) return;
      this.onFail(error);
      this.markDone();
    }
  }

  disposeTeardown() {
    if (!this.teardown) return;
    try {
      this.teardown.dispose();
    } catch (error) {
      console.error("modals: source teardown failed", error);
    }
    this.teardown = null;
  }

  abort() {
    if (this.aborted) return;
    this.controller.abort();
    this.flushScheduled = false;
    this.disposeTeardown();
    if (this.resolveSettled) this.resolveSettled();
  }
}

module.exports = { sources, normalizeSource, SourceRun, Disposable };
