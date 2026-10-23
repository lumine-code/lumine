const NullLanguageMode = require("./null-language-mode");
const HighlightCache = require("./tree-sitter-highlight-cache");
const ScopeDescriptor = require("./scope-descriptor");
const Point = require("./point");
const Range = require("./range");
const RangeList = require("./tree-sitter-range-list");
const { PAINT_TILE_ROWS: TILE_ROWS } = require("./syntax-worker-protocol");
const {
  setTimeout: scheduleInitialPaint,
  clearTimeout: cancelInitialPaint,
} = require("node:timers");
const STREAMED_BUILTINS = new Set([
  "getFoldableRanges",
  "getFoldableRangesAtIndentLevel",
  "syntaxSelections",
  "comments",
  "suggestedIndentForBufferRows",
  "suggestedIndentForBufferRowsAtRows",
  "suggestedIndentForPastedRanges",
]);
const rangeFromData = (range) => range && Range.fromObject(range);

class TreeSitterWorkerLanguageMode extends NullLanguageMode {
  constructor({ buffer, grammar, service }) {
    super({ buffer, grammar });
    this.service = service;
    this.asynchronousSyntax = true;
    this.useAsyncParsing = true;
    this.useAsyncIndent = true;
    this.publicationPending = true;
    this.tokenized = false;
    this.autoIndentRequests = 0;
    this.transactionIndentRequests = 0;
    this.cache = new HighlightCache({ maxSnapshots: 256, maxEvents: 128000 });
    this.folds = new Map();
    this.dirtyRanges = new RangeList();
    this.invalidateAll = true;
    this.presentationVersion = 0;
    this.requests = new Set();
    this.requestsByOwner = new WeakMap();
    this.defaultOwner = {};
    this.requestHighlighting(this.defaultOwner, [[0, 63]], false);
    this.session = service.acquire(buffer, grammar, (event) => this.receive(event));
    this.initializeSyntax();
  }

  initializeSyntax() {
    const ready = this.settle().then((result) => {
      if (!this.destroyed && this.ready === ready) {
        this.tokenized = true;
        this.emitter.emit("did-tokenize");
        // Semantic readiness is independent of a moving viewport's paint
        // stream, which may keep accepting new tiles until scrolling stops.
        void this.refresh().catch((error) => this.failed(error));
      }
      return result;
    });
    this.ready = ready;
    void ready.catch((error) => {
      if (this.ready === ready) this.failed(error);
    });
  }

  failed(error) {
    if (this.destroyed || error.name === "AbortError") return;
    if (!this.error) console.error("Syntax worker failed", error);
    this.error = error;
  }

  receive(event) {
    if (this.destroyed) return;
    if (event.event === "settled") {
      if (event.revision === this.buffer.getTextRevision()) this.publicationPending = false;
      return;
    }
    if (event.event === "recovering") {
      this.presentationVersion++;
      this.invalidateAll = true;
      this.error = null;
      this.publicationPending = true;
      this.cache.clear();
      this.folds.clear();
    } else if (event.event === "recovered") {
      this.error = null;
      this.initializeSyntax();
    } else if (event.event === "failure") this.failed(event.error ?? new Error(event.message));
    else if (event.event === "pending" || event.event === "invalidate") {
      this.presentationVersion++;
      this.invalidateAll = true;
      this.refreshController?.abort();
      this.publicationPending = true;
      this.folds.clear();
      if (this.error && !this.service.terminalError) {
        this.error = null;
        this.initializeSyntax();
      }
      this.schedule();
    } else if (event.event === "highlight" && event.revision === this.buffer.getTextRevision()) {
      this.presentationVersion++;
      this.refreshController?.abort();
      const range = this.buffer.clipRange(Range.fromObject(event.range));
      this.dirtyRanges.add(
        new Range([range.start.row, 0], this.buffer.clipPosition([range.end.row + 1, 0])),
      );
      this.schedule();
    } else if (event.event === "injection") {
      const grammar = this.service.grammars.grammarForScopeName(event.scopeName);
      if (grammar) this.emitter.emit("did-use-injection-grammar", grammar);
    }
  }

  onDidUseInjectionGrammar(callback) {
    return this.emitter.on("did-use-injection-grammar", callback);
  }

  shouldParseSynchronously() {
    return false;
  }

  prepareInitialHighlighting(row = 0) {
    // Keep the previous pane item visible while a small document prepares its
    // first colors. Parsing/transport remain asynchronous and the wait is
    // bounded even for a cold grammar, a slow query or a failed worker.
    if (this.destroyed || this.error || this.buffer.getLength() > 65536) return;
    row = typeof row === "number" && !Number.isNaN(row) ? Math.max(0, row) : 0;
    row = Math.min(this.buffer.getLastRow(), Math.floor(row));
    const first = Math.max(0, row - 32);
    const last = Math.min(this.buffer.getLastRow(), first + 127);
    const start = this.buffer.clipPosition([first, 0]);
    const end = this.buffer.clipPosition([last + 1, 0]);
    const ready = () => start.isEqual(end) || this.cache.covers(start, end);
    if (ready()) return;
    return new Promise((resolve) => {
      const finish = () => {
        subscription.dispose();
        cancelInitialPaint(timer);
        resolve();
      };
      const subscription = this.onDidChangeHighlighting(() => {
        if (this.destroyed || this.error || ready()) finish();
      });
      const timer = scheduleInitialPaint(finish, 32);
      this.requestHighlighting(this.defaultOwner, [[first, last]]);
    });
  }

  getSyntaxGeneration() {
    return `${this.session.epoch}:${this.session.generation}`;
  }

  getSyntaxRequestEpoch() {
    return `${this.service.syntaxEpoch}:${this.session.epoch}`;
  }

  bufferDidChange(change) {
    this.presentationVersion++;
    this.refreshController?.abort();
    if (!this.publicationPending) this.transactionIndentRequests = 0;
    this.publicationPending = true;
    this.cache.edit(change);
    const first = Math.max(0, change.newRange.start.row - 1);
    this.dirtyRanges.add(
      new Range([first, 0], this.buffer.clipPosition([change.newRange.end.row + 2, 0])),
    );
    if (change.oldRange.end.row !== change.newRange.end.row)
      this.dirtyFromRow = Math.min(this.dirtyFromRow ?? Infinity, first);
    this.folds.clear();
  }

  canBatchTextChanges(count) {
    return count >= 128;
  }

  copyHighlighting(source, target) {
    const visible = [...this.requests].flatMap((request) => request.ranges);
    if (
      this.cache.copyRange(
        source.start,
        source.end,
        target,
        [this.grammar.idForScope(this.grammar.scopeName)],
        (snapshot) =>
          visible.some(([first, last]) => snapshot.start.row <= last && snapshot.end.row > first),
      )
    ) {
      this.emitter.emit(
        "did-change-highlighting",
        new Range(target, target.traverse(source.getExtent())),
      );
    }
  }

  bufferDidChangeBatch(change) {
    this.bufferDidChange(change);
  }

  bufferDidFinishTransaction() {
    this.transactionIndentRequests += this.autoIndentRequests;
    this.autoIndentRequests = 0;
    this.schedule();
  }

  async settle(signal) {
    const result = await this.service.settle(this.session, signal);
    if (this.destroyed) return { parseError: true };
    this.publicationPending = false;
    this.receiveMetadata(result);
    return {
      ...result,
      range: result.range && Range.fromObject(result.range),
      autoIndentRequests: this.transactionIndentRequests,
    };
  }

  async atGrammarSettlement() {
    await this.ready;
    return this.settle();
  }

  atTransactionEnd() {
    return this.atGrammarSettlement();
  }

  hasQuery(type) {
    return Boolean(
      this.grammar.queryPaths?.[type] || this.grammar[type] || this.availableQueries?.has(type),
    );
  }

  receiveMetadata(result) {
    const previous = this.softTabsHint;
    this.availableQueries = new Set(result.queries);
    this.usedGrammarScopes = result.grammars;
    this.softTabsHint = result.softTabs;
    if (this.tokenized && previous !== this.softTabsHint) this.emitter.emit("did-tokenize");
  }

  getSoftTabsHint() {
    return this.softTabsHint;
  }

  getUsedGrammars() {
    return (this.usedGrammarScopes ?? [this.grammar.scopeName])
      .map((scope) => this.service.grammars.grammarForScopeName(scope))
      .filter(Boolean);
  }

  async analyze(module, method, params, options = {}) {
    return this.service.request(this.session, "analyze", { module, method, params }, options);
  }

  getSyntaxNodeAtPosition() {
    throw new TypeError("Syntax nodes belong to the worker; use editor.analyzeSyntax()");
  }
  getSyntaxNodeContainingRange() {
    throw new TypeError("Syntax nodes belong to the worker; use editor.analyzeSyntax()");
  }
  getQueryCaptureGroups() {
    throw new TypeError("Syntax captures belong to the worker; use editor.analyzeSyntax()");
  }

  async builtin(method, args, { convert = (value) => value, ...options } = {}) {
    if (!STREAMED_BUILTINS.has(method))
      return this.service.request(this.session, "builtin", { method, args }, options);
    const values = [],
      entries = new Map();
    const summary = await this.service.request(
      this.session,
      "builtin",
      { method, args, stream: true },
      {
        ...options,
        onChunk(packet) {
          if (packet.kind === "map") {
            for (const [key, value] of packet.values) entries.set(key, convert(value));
          } else if (packet.kind === "array") {
            for (const value of packet.values) values.push(convert(value));
          } else throw new Error("Invalid syntax result packet");
        },
      },
    );
    if (!summary?.stream) return summary;
    const result = summary.stream === "map" ? entries : values;
    if ((result.size ?? result.length) !== summary.count)
      throw new Error("Incomplete syntax result stream");
    return result;
  }

  requestHighlighting(
    owner,
    ranges,
    schedule = true,
    { priority = 1, prefetch = true, background = false } = {},
  ) {
    if (this.destroyed) return;
    if (owner !== this.defaultOwner) {
      const initial = this.requestsByOwner.get(this.defaultOwner);
      if (initial) this.requests.delete(initial);
      this.requestsByOwner.delete(this.defaultOwner);
    }
    let request = this.requestsByOwner.get(owner);
    if (!request) {
      request = { owner: new WeakRef(owner), ranges: [] };
      this.requestsByOwner.set(owner, request);
      this.requests.add(request);
    }
    const previous = request.ranges[0]?.[0];
    const start = ranges[0]?.[0];
    if (previous != null && start != null && previous !== start) {
      const now = performance.now();
      const elapsed = Math.max(16, now - (request.movedAt ?? now));
      const direction = Math.sign(start - previous);
      request.direction = direction;
      // Cover about 120 ms of travel, with a hard spatial cap. Slow scrolling
      // needs one tile; Alt-wheel needs enough lead to survive a busy worker.
      request.leadRows = Math.min(
        1024,
        Math.max(
          TILE_ROWS,
          Math.ceil(((Math.abs(start - previous) / elapsed) * 120) / TILE_ROWS) * TILE_ROWS,
        ),
      );
      request.movedAt = now;
    }
    request.ranges = ranges;
    request.priority = priority;
    request.prefetch = prefetch;
    request.background = background;
    if (schedule) this.schedule();
    return ranges.every(([first, last]) => {
      const start = this.buffer.clipPosition([first, 0]);
      const end = this.buffer.clipPosition([last + 1, 0]);
      return start.isEqual(end) || this.cache.covers(start, end);
    });
  }

  wantedRanges() {
    const last = this.buffer.getLastRow();
    const views = [];
    for (const request of this.requests) {
      const owner = request.owner.deref();
      if (!owner || owner.destroyed) {
        this.requests.delete(request);
        continue;
      }
      const ranges = [];
      let size = 0;
      for (const [start, end] of request.ranges) {
        size += end - start + 1;
        for (let row = Math.max(0, start); row <= Math.min(last, end); row += TILE_ROWS)
          ranges.push([row, Math.min(last, end, row + TILE_ROWS - 1)]);
      }
      const visibleCount = ranges.length;
      if (request.prefetch && visibleCount) {
        const first = Math.floor(request.ranges[0][0] / TILE_ROWS) * TILE_ROWS;
        const final = Math.floor(request.ranges.at(-1)[1] / TILE_ROWS) * TILE_ROWS;
        const direction = request.direction || 1;
        const add = (row) => {
          if (row >= 0 && row <= last) ranges.push([row, Math.min(last, row + TILE_ROWS - 1)]);
        };
        // A folded view requests only visible fragments, never hidden interiors.
        if (request.ranges.length === 1) {
          if (direction > 0) for (let row = first; row <= final; row += TILE_ROWS) add(row);
          else for (let row = final; row >= first; row -= TILE_ROWS) add(row);
        }
        for (
          let distance = TILE_ROWS;
          distance <= (request.leadRows ?? TILE_ROWS);
          distance += TILE_ROWS
        )
          add(direction > 0 ? final + distance : first - distance);
        add(direction > 0 ? first - TILE_ROWS : final + TILE_ROWS);
      }
      views.push({ ranges, visibleCount, size, priority: request.priority });
    }
    views.sort((a, b) => a.priority - b.priority || a.size - b.size);
    const ranges = [];
    // Every visible split precedes the lead of another split. Minimap and
    // measurement owners cannot put auxiliary reads ahead of editor text.
    for (const priority of new Set(views.map((view) => view.priority))) {
      const group = views.filter((view) => view.priority === priority);
      for (const view of group) ranges.push(...view.ranges.slice(0, view.visibleCount));
      for (const view of group) ranges.push(...view.ranges.slice(view.visibleCount));
    }
    return [...new Map(ranges.map((range) => [range.join(":"), range])).values()];
  }

  backgroundRange(stamp) {
    // Spend spare worker time on nearby unvisited text, retaining it within
    // the existing event allowance. Keep headroom for new visible windows.
    const requests = [...this.requests]
      .filter((request) => request.background && request.ranges.length && request.owner.deref())
      .sort((a, b) => a.priority - b.priority);
    const request = requests[0];
    if (!request || request.ranges.length !== 1) return;
    const center = request.ranges[0][0];
    const first = Math.max(0, Math.floor(center / TILE_ROWS) * TILE_ROWS - 16384);
    const end = this.buffer.clipPosition([center + 16384, 0]);
    const gaps = this.cache.uncoveredRanges(new Point(first, 0), end, stamp);
    gaps.sort(
      (a, b) =>
        Math.max(a[0].row - center, center - a[1].row, 0) -
        Math.max(b[0].row - center, center - b[1].row, 0),
    );
    const gap = gaps[0];
    if (!gap) return;
    if (
      this.cache.snapshots.length >= this.cache.maxSnapshots * 0.75 ||
      this.cache.snapshots.reduce((sum, item) => sum + item.events.length, 0) >=
        this.cache.maxEvents * 0.75
    ) {
      // A full cache must follow a new viewport instead of staying frozen
      // around the first one. Replace only a strictly more distant fragment,
      // with two tiles of hysteresis to avoid work oscillating at the edge.
      const protectedRanges = this.wantedRanges();
      let distance = Math.max(gap[0].row - center, center - gap[1].row, 0) + 2 * TILE_ROWS;
      let index = -1;
      for (let i = 0; i < this.cache.snapshots.length; i++) {
        const snapshot = this.cache.snapshots[i];
        const candidate = Math.max(snapshot.start.row - center, center - snapshot.end.row, 0);
        if (
          candidate <= distance ||
          protectedRanges.some(
            ([first, last]) => snapshot.start.row <= last && snapshot.end.row > first,
          )
        )
          continue;
        distance = candidate;
        index = i;
      }
      if (index < 0) return;
      const removed = this.cache.removeSnapshot(index);
      for (const row of this.folds.keys())
        if (
          row >= removed.start.row &&
          (row < removed.end.row || (row === removed.end.row && removed.end.column > 0))
        )
          this.folds.delete(row);
    }
    const last = gap[1].row - (gap[1].column === 0 ? 1 : 0);
    const row = Math.max(
      gap[0].row,
      Math.min(
        Math.floor(last / TILE_ROWS) * TILE_ROWS,
        Math.floor(center / TILE_ROWS) * TILE_ROWS,
      ),
    );
    return [row, Math.min(last, row + TILE_ROWS - 1)];
  }

  canRefresh() {
    return (
      !this.destroyed &&
      !this.error &&
      !this.session?.closed &&
      !this.service.closed &&
      !this.service.terminalError
    );
  }

  schedule() {
    if (!this.canRefresh()) return;
    if (this.timer || this.refreshPromise) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.refresh().catch((error) => this.failed(error));
      },
      this.publicationPending && this.buffer.getLength() >= 512 * 1024 ? 50 : 0,
    );
  }

  async refresh() {
    if (!this.canRefresh()) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      for (;;) {
        if (!this.canRefresh()) return;
        const revision = this.buffer.getTextRevision();
        const generation = this.session.generation;
        const presentation = this.presentationVersion;
        const stamp = { revision, generation, presentation };
        const current = () =>
          !this.destroyed &&
          revision === this.buffer.getTextRevision() &&
          generation === this.session.generation &&
          presentation === this.presentationVersion;
        const nextRange = () =>
          this.wantedRanges().find(
            ([first, last]) =>
              !this.cache.covers(
                new Point(first, 0),
                this.buffer.clipPosition([last + 1, 0]),
                stamp,
              ),
          ) ?? this.backgroundRange(stamp);
        const first = nextRange();
        if (!first) {
          return;
        }
        const ids = new Map();
        let tile;
        const controller = (this.refreshController = new AbortController());
        try {
          const metadata = await this.service.request(
            this.session,
            "view",
            { ranges: [first], stream: true, follow: true },
            {
              revision,
              signal: controller.signal,
              onChunk: (packet) => {
                controller.signal.throwIfAborted();
                if (!current())
                  throw Object.assign(new Error("Obsolete syntax paint"), { name: "AbortError" });
                for (const [id, name] of packet.names) ids.set(id, this.grammar.idForScope(name));
                if (packet.start) {
                  tile = {
                    start: Point.fromObject(packet.start),
                    end: Point.fromObject(packet.end),
                    scopes: packet.scopes.map((id) => ids.get(id)),
                    events: [],
                  };
                }
                for (const event of packet.events)
                  tile.events.push({
                    position: Point.fromObject(event.position),
                    open: event.open.map((id) => ids.get(id)),
                    close: event.close.map((id) => ids.get(id)),
                  });
                if (packet.kind === "end") {
                  const range = new Range(tile.start, tile.end);
                  const updates = new RangeList();
                  const candidates = new RangeList();
                  if (this.invalidateAll) {
                    this.dirtyRanges.add(this.buffer.getRange());
                    this.invalidateAll = false;
                  }
                  for (const [start, end] of this.cache.uncoveredRanges(tile.start, tile.end))
                    candidates.add(new Range(start, end));
                  if (this.dirtyFromRow != null) {
                    this.dirtyRanges.add(
                      new Range([this.dirtyFromRow, 0], this.buffer.getEndPosition()),
                    );
                    this.dirtyRanges.remove(
                      new Range(this.buffer.getEndPosition(), Point.INFINITY),
                    );
                    this.dirtyFromRow = null;
                  }
                  for (const dirty of this.dirtyRanges)
                    if (range.intersectsWith(dirty, true))
                      candidates.add(
                        new Range(
                          range.start.isGreaterThan(dirty.start) ? range.start : dirty.start,
                          range.end.isLessThan(dirty.end) ? range.end : dirty.end,
                        ),
                      );
                  // A viewport may have already published the middle of a
                  // larger prefetch tile. Do not invalidate those fresh rows
                  // again just to fill its offscreen prefix and suffix.
                  for (const candidate of candidates)
                    for (const [start, end] of this.cache.uncoveredRanges(
                      candidate.start,
                      candidate.end,
                      stamp,
                    ))
                      updates.add(new Range(start, end));
                  const visible = [...this.requests].flatMap((request) => request.ranges);
                  const evicted = this.cache.replace([tile], stamp, (snapshot) =>
                    visible.some(
                      ([first, last]) => snapshot.start.row <= last && snapshot.end.row > first,
                    ),
                  );
                  // Completing the current viewport does not repair retained
                  // paint elsewhere. Keep those invalidations until their own
                  // tiles arrive, including after scrolling or a file reload.
                  this.dirtyRanges.remove(range);
                  for (const [row, fold] of packet.folds ?? []) {
                    if (Boolean(this.folds.get(row)) !== Boolean(fold))
                      updates.add(new Range([row, 0], this.buffer.clipPosition([row, Infinity])));
                    if (fold) this.folds.set(row, Range.fromObject(fold));
                    else this.folds.delete(row);
                  }
                  if (evicted) {
                    const coverage = this.cache.getOrderedSnapshots();
                    for (const row of this.folds.keys()) {
                      let low = 0,
                        high = coverage.length;
                      while (low < high) {
                        const middle = (low + high) >>> 1;
                        if (coverage[middle].start.row <= row) low = middle + 1;
                        else high = middle;
                      }
                      const end = coverage[low - 1]?.end;
                      if (!end || row > end.row || (row === end.row && end.column === 0))
                        this.folds.delete(row);
                    }
                  }
                  // A complete tile is useful immediately. Later packets may
                  // belong to a minimap or a viewport that has already moved.
                  for (const update of updates) {
                    if (!current()) break;
                    // Display invalidation includes the endpoint's row. A
                    // half-open paint gap must not also dirty its fresh neighbor.
                    const end =
                      update.end.column === 0 && update.end.row > update.start.row
                        ? this.buffer.clipPosition([update.end.row - 1, Infinity])
                        : update.end;
                    this.emitter.emit("did-change-highlighting", new Range(update.start, end));
                  }
                  if (current()) return { range: nextRange() };
                }
              },
            },
          );
          if (current()) {
            this.receiveMetadata(metadata);
            this.publicationPending = false;
          }
        } catch (error) {
          if (error.name === "AbortError" && !this.destroyed) continue;
          throw error;
        }
      }
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  buildHighlightIterator() {
    return this.buildPresentationHighlightIterator();
  }

  buildPresentationHighlightIterator() {
    const mode = this;
    let iterator;
    return {
      seek(position, endRow = mode.buffer.getLastRow()) {
        const result = mode.cache.read(
          Point.fromObject(position),
          mode.buffer.clipPosition([endRow + 1, 0]),
          [mode.grammar.idForScope(mode.grammar.scopeName)],
        );
        iterator = result.iterator;
        return result.scopes;
      },
      getPosition: () => iterator?.getPosition() ?? Point.INFINITY,
      getOpenScopeIds: () => iterator?.getOpenScopeIds() ?? [],
      getCloseScopeIds: () => iterator?.getCloseScopeIds() ?? [],
      moveToSuccessor: () => iterator?.moveToSuccessor(),
    };
  }

  classNameForScopeId(id) {
    return this.grammar.classNameForScopeId(id);
  }
  scopeNameForScopeId(id) {
    return this.grammar.scopeNameForScopeId(id);
  }

  scopeDescriptorForPosition(position) {
    let point = this.buffer.clipPosition(Point.fromObject(position));
    if (point.column > 0 && point.column === this.buffer.lineLengthForRow(point.row))
      point = point.translate([0, -1]);
    const end = this.buffer.clipPosition(point.translate([0, 1]));
    // Synchronous UI consumers read the retained, edit-adjusted presentation.
    // Exact semantic decisions use the asynchronous scope analysis instead.
    if (!this.cache.covers(point, end))
      return new ScopeDescriptor({ scopes: [this.grammar.scopeName, "text"] });
    const result = this.cache.read(point, point.translate([0, 1]), [
      this.grammar.idForScope(this.grammar.scopeName),
    ]);
    const scopes = [...result.scopes];
    while (result.iterator.getPosition().compare(point) <= 0) {
      for (const id of result.iterator.getCloseScopeIds()) {
        const index = scopes.lastIndexOf(id);
        if (index !== -1) scopes.splice(index, 1);
      }
      scopes.push(...result.iterator.getOpenScopeIds());
      if (!result.iterator.moveToSuccessor()) break;
    }
    const names = scopes.map((id) => this.grammar.scopeNameForScopeId(id));
    if (
      !names.length &&
      !this.cache.covers(point, end, {
        revision: this.buffer.getTextRevision(),
        generation: this.session.generation,
      })
    )
      names.push(this.grammar.scopeName, "text");
    return new ScopeDescriptor({ scopes: names });
  }

  suggestedIndentForLineAtBufferRow(...args) {
    this.autoIndentRequests++;
    return super.suggestedIndentForLineAtBufferRow(...args);
  }
  commentStringsForPosition(point) {
    return this.builtin("commentStringsForPosition", [point]);
  }
  commentStringsForRows(rows) {
    return this.builtin("comments", [rows]);
  }
  rootLanguageRangesChanged() {
    this.service.updateRootRanges(this.session);
  }
  validateGrammarQueries() {
    return this.builtin("validateGrammarQueries", []);
  }
  syntaxSelectionRanges(ranges, options = {}) {
    return this.builtin("syntaxSelections", [ranges], { ...options, convert: rangeFromData });
  }
  suggestedIndentForBufferRow(...args) {
    this.autoIndentRequests++;
    return this.builtin("suggestedIndentForBufferRow", args);
  }
  suggestedIndentForEditedBufferRow(row, ...args) {
    const first = this.buffer.lineForRow(row)?.[0];
    if (row === 0 || (first !== " " && first !== "\t")) return;
    return this.builtin("suggestedIndentForEditedBufferRow", [row, ...args]);
  }
  hasPendingIndentRequests() {
    return this.autoIndentRequests > 0 || this.transactionIndentRequests > 0;
  }
  suggestedIndentForBufferRows(startRow, endRow, tabLength, options, requestOptions = {}) {
    return this.builtin(
      "suggestedIndentForBufferRows",
      [startRow, endRow, tabLength, options],
      requestOptions,
    );
  }
  suggestedIndentForBufferRowsAtRows(...args) {
    return this.builtin("suggestedIndentForBufferRowsAtRows", args);
  }

  suggestedIndentForPastedRanges(ranges, tabLength, options = {}) {
    return this.builtin("suggestedIndentForPastedRanges", [ranges, tabLength], options);
  }

  async getFoldRangeForRow(...args) {
    const range = await this.builtin("getFoldRangeForRow", args);
    return range && Range.fromObject(range);
  }
  isFoldableAtRow(row) {
    return this.builtin("isFoldableAtRow", [row]);
  }
  isFoldableAtRowForRendering(row) {
    return Boolean(this.folds.get(row));
  }
  async syntaxTreeScopeDescriptorForPosition(point) {
    return new ScopeDescriptor({ scopes: await this.builtin("syntaxScopes", [point]) });
  }
  async bufferRangeForScopeAtPosition(selector, point) {
    const range = await this.builtin("bufferRangeForScopeAtPosition", [selector, point]);
    return range && Range.fromObject(range);
  }
  async tokenForPosition(point) {
    const Token = require("./token");
    return new Token(await this.builtin("token", [point]));
  }
  getFoldableRanges(tabLength, options = {}) {
    return this.builtin("getFoldableRanges", [tabLength], { ...options, convert: rangeFromData });
  }
  getFoldableRangesAtIndentLevel(level, tabLength, options = {}) {
    return this.builtin("getFoldableRangesAtIndentLevel", [level, tabLength], {
      ...options,
      convert: rangeFromData,
    });
  }
  async getFoldableRangeContainingPoint(point, tabLength, options = {}) {
    const range = await this.builtin(
      "getFoldableRangeContainingPoint",
      [point, tabLength],
      options,
    );
    return range && Range.fromObject(range);
  }
  async getRangeForSyntaxNodeContainingRange(...args) {
    const range = await this.builtin("getRangeForSyntaxNodeContainingRange", args);
    return range && Range.fromObject(range);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.timer);
    this.refreshController?.abort();
    this.service.release(this.session);
    this.requests.clear();
    this.cache.clear();
    this.folds.clear();
    this.dirtyRanges.clear();
    super.destroy();
  }
}

module.exports = TreeSitterWorkerLanguageMode;
