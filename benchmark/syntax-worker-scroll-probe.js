// Installed by syntax-worker-scroll.js in an isolated normal editor window.
// Observe every mounted visible row; never include source text in the report.
(async () => {
  const editor = lumine.workspace.getActiveTextEditor(),
    element = editor.getElement(),
    component = element.component,
    mode = editor.getBuffer().getLanguageMode();
  if (!mode.cache) throw new Error("The scroll probe requires worker syntax");
  await editor.whenGrammarSettled();
  editor.setCursorBufferPosition([Math.min(2000, editor.getLastBufferRow()), 0]);
  editor.scrollToCursorPosition({ mode: "center" });
  element.focus();
  if (window.__lumineSyntaxScrollConfig.gesture === "thumb") {
    component.setScrollTop(component.getMaxScrollTop() / 2);
    component.updateSync();
  }
  await new Promise((r) => setTimeout(r, window.__lumineSyntaxScrollConfig.warmup ?? 1000));
  let active = false;
  const frames = [],
    packets = [],
    requests = [],
    waits = [];
  let paintedFirst = component.getFirstVisibleRow(),
    paintedLast = component.getLastVisibleRow();
  const transform = component.updateContentScrollTransform;
  component.updateContentScrollTransform = function (...a) {
    const result = transform.apply(this, a);
    paintedFirst = this.getFirstVisibleRow();
    paintedLast = this.getLastVisibleRow();
    return result;
  };
  const original = mode.service.request;
  mode.service.request = async function (session, operation, data, options) {
    if (operation !== "view") return original.call(this, session, operation, data, options);
    requests.push({ at: performance.now(), ranges: data.ranges });
    const chunk = options.onChunk;
    return original.call(this, session, operation, data, {
      ...options,
      onChunk(packet) {
        const start = performance.now();
        const next = chunk(packet);
        packets.push({
          at: start,
          ms: performance.now() - start,
          start: packet.start,
          end: packet.end,
          kind: packet.kind,
          next,
          events: packet.events.length,
        });
        return next;
      },
    });
  };
  const wait = component.waitForScrollHighlighting;
  component.waitForScrollHighlighting = function (...a) {
    const req = this.scrollHighlightingRequested,
      exp = this.scrollHighlightingExpired;
    const result = wait.apply(this, a);
    if (req)
      waits.push({
        at: performance.now(),
        result,
        expired: exp,
        start: this.getRenderedStartRow(),
        end: this.getRenderedEndRow(),
      });
    return result;
  };
  const tick = () => {
    if (!active) return;
    const began = performance.now();
    const visible = [...component.lineComponentsByScreenLineId.values()].filter(
      (l) =>
        !l.props.offScreen &&
        Number(l.element.dataset.screenRow) >= paintedFirst &&
        Number(l.element.dataset.screenRow) <= paintedLast,
    );
    const lines = visible.map((l) => {
      const row = Number(l.element.dataset.screenRow),
        point = editor.bufferPositionForScreenPosition([row, 0]),
        end = editor.getBuffer().clipPosition([point.row + 1, 0]);
      return {
        row,
        chars: l.props.screenLine.lineText.length,
        coverage: mode.cache.covers(point, end),
        colored: l.element.querySelectorAll(
          '[class*="syntax--keyword"],[class*="syntax--string"],[class*="syntax--constant"],[class*="syntax--comment"],[class*="syntax--entity"],[class*="syntax--support"]',
        ).length,
      };
    });
    let readyButUnpainted = false;
    if (lines.length && lines.every((line) => line.coverage && !line.colored)) {
      const start = editor.bufferPositionForScreenPosition([paintedFirst, 0]);
      const end = editor.bufferPositionForScreenPosition([paintedLast, Infinity]);
      const iterator = mode.buildPresentationHighlightIterator();
      const colored = (ids) =>
        ids.some((id) =>
          /syntax--(?:keyword|string|constant|comment|entity|support)\b/.test(
            mode.classNameForScopeId(id),
          ),
        );
      readyButUnpainted = colored(iterator.seek(start, end.row));
      while (!readyButUnpainted && iterator.getPosition().compare(end) <= 0) {
        readyButUnpainted = colored(iterator.getOpenScopeIds());
        iterator.moveToSuccessor();
      }
    }
    frames.push({
      at: began,
      first: paintedFirst,
      last: paintedLast,
      logical: component.getFirstVisibleRow(),
      waiting: !!component.scrollHighlightingFrame,
      lines,
      readyButUnpainted,
      ms: performance.now() - began,
    });
    requestAnimationFrame(tick);
  };
  window.__lumineSyntaxScrollProbe = {
    start() {
      active = true;
      requestAnimationFrame(tick);
    },
    stop() {
      active = false;
      component.updateContentScrollTransform = transform;
      component.waitForScrollHighlighting = wait;
      mode.service.request = original;
      if (mode.error) throw mode.error;
      return {
        frames,
        packets,
        requests,
        waits,
        packages: lumine.packages.getActivePackages().map((pack) => pack.name),
        cache: {
          snapshots: mode.cache.snapshots.length,
          events: mode.cache.snapshots.reduce((n, s) => n + s.events.length, 0),
          maxEvents: mode.cache.maxEvents,
        },
        summary: {
          frames: frames.length,
          missing: frames.filter((f) => f.lines.some((l) => !l.coverage)).length,
          plain: frames.filter((f) => f.lines.length && !f.lines.some((l) => l.colored)).length,
          readyButUnpainted: frames.filter((f) => f.readyButUnpainted).length,
          packets: packets.length,
          waits: waits.length,
          expired: waits.filter((w) => w.expired).length,
          range: [Math.min(...frames.map((f) => f.first)), Math.max(...frames.map((f) => f.first))],
          owners: [...mode.requests].map((r) => ({
            ranges: r.ranges,
            lead: r.leadRows,
            priority: r.priority,
          })),
          viewport: [component.getRenderedStartRow(), component.getRenderedEndRow()],
        },
      };
    },
  };
  return { mode: mode.constructor.name, grammar: editor.getGrammar().scopeName };
})();
