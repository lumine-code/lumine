// Opt-in Electron benchmark. LUMINE_SYNTAX_BENCHMARK_CONFIG selects the file,
// packages, output directory and backend; synthetic uses a small unsaved JS buffer.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ipcRenderer } = require("electron");

function scopeMismatches(editor, mode, component, lines) {
  if (!mode.cache || !lines.length) return [];
  const mismatches = [];
  for (const index of new Set([0, Math.floor(lines.length / 2), lines.length - 1])) {
    const line = lines[index];
    const rendered = [...component.lineComponentsByScreenLineId.values()].find(
      (entry) => entry.element === line,
    );
    if (!rendered || rendered.props.offScreen || rendered.props.screenLine.lineText.length < 2)
      continue;
    const row = Number(line.dataset.screenRow);
    const column = Math.floor(rendered.props.screenLine.lineText.length / 2);
    const point = editor.bufferPositionForScreenPosition([row, column]);
    const projected = editor.screenPositionForBufferPosition(point);
    if (projected.row !== row || projected.column !== column) continue;
    if (!mode.cache.covers(point, editor.getBuffer().clipPosition([point.row, point.column + 1])))
      continue;
    const iterator = mode.buildPresentationHighlightIterator();
    const scopes = [...iterator.seek(point, point.row)];
    while (iterator.getPosition().compare(point) <= 0) {
      for (const id of iterator.getCloseScopeIds()) {
        const index = scopes.lastIndexOf(id);
        if (index >= 0) scopes.splice(index, 1);
      }
      scopes.push(...iterator.getOpenScopeIds());
      iterator.moveToSuccessor();
    }
    let offset = column,
      textNode;
    for (const node of rendered.textNodes) {
      if (offset < node.length) {
        textNode = node;
        break;
      }
      offset -= node.length;
    }
    if (!textNode) continue;
    const actual = new Set();
    for (
      let node = textNode.parentElement;
      node && node !== editor.getElement();
      node = node.parentElement
    )
      for (const name of node.classList) if (name.startsWith("syntax--")) actual.add(name);
    const expected = new Set(scopes.flatMap((id) => mode.classNameForScopeId(id).split(/\s+/)));
    if ([...expected].some((name) => !actual.has(name)))
      mismatches.push({ row, column, expected: [...expected], actual: [...actual] });
  }
  return mismatches;
}
describe("Fast scroll syntax coverage", () => {
  it("measures visible colors during wheel and scrollbar movement", async () => {
    jasmine.useRealClock();
    const c = JSON.parse(process.env.LUMINE_SYNTAX_BENCHMARK_CONFIG);
    if (
      !c.out ||
      !c.file ||
      !Array.isArray(c.packages) ||
      !["worker", "inline"].includes(c.backend)
    )
      throw new Error("Provide out, file, packages and backend");
    fs.mkdirSync(c.out, { recursive: true });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(c.file)).digest("hex");
    const before = hash();
    const workspace = lumine.workspace.getElement();
    workspace.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
    jasmine.attachToDOM(workspace);
    lumine.grammars.syntaxExecution = c.backend;
    lumine.config.set("minimap.autoToggle", Boolean(c.minimap));
    lumine.config.set("editor.smoothScrolling", true);
    lumine.config.set("editor.altWheelScrollMultiplier", 8);
    for (const name of c.packages) await lumine.packages.activatePackage(name);
    const editor = await lumine.workspace.open(c.synthetic ? undefined : c.file);
    if (c.synthetic) {
      editor.setText(
        Array.from({ length: 1200 }, (_, i) => `const value${i} = "color"; // comment`).join("\n"),
      );
      lumine.grammars.assignGrammar(
        editor.getBuffer(),
        lumine.grammars.grammarForScopeName("source.js"),
      );
    }
    const element = editor.getElement();
    element.setUpdatedSynchronously(false);
    const waitForColors = element.component.waitForScrollHighlighting;
    let paintDecisions = null,
      waitStartedAt = null;
    element.component.waitForScrollHighlighting = function (...args) {
      const requested = this.scrollHighlightingRequested;
      const expired = this.scrollHighlightingExpired;
      let waiting;
      if (c.frameDeadline === false) {
        this.cancelScrollHighlighting();
        waiting = false;
      } else waiting = waitForColors.apply(this, args);
      if (waiting && waitStartedAt == null) waitStartedAt = performance.now();
      if (requested && !waiting && paintDecisions) {
        const at = performance.now();
        paintDecisions.push({
          at,
          expired: Boolean(expired),
          waitMs: waitStartedAt == null ? 0 : at - waitStartedAt,
          first: this.getRenderedStartRow(),
          last: this.getRenderedEndRow(),
        });
        waitStartedAt = null;
      }
      return waiting;
    };
    const mode = editor.getBuffer().getLanguageMode();
    const result = { configuration: c, inputHash: before, cases: [] };
    let stopFrames, restoreRequest, restorePaint, releaseMouse;
    try {
      await editor.whenGrammarSettled();
      for (const name of c.trusted && c.gesture === "thumb"
        ? ["middle-down", "middle-up", "middle-reverse"]
        : ["middle-down", "end-up", "middle-reverse"]) {
        editor.setCursorBufferPosition([
          name === "end-up"
            ? editor.getLastBufferRow() - 100
            : Math.floor(editor.getLastBufferRow() / 2),
          0,
        ]);
        editor.scrollToCursorPosition({ mode: "center" });
        element.focus();
        if (c.trusted) {
          const area = element.getBoundingClientRect();
          for (const type of ["mouseMove", "mouseDown", "mouseUp"])
            await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
              type,
              x: Math.round(area.left + 100),
              y: Math.round(area.top + 100),
              button: "left",
              clickCount: 1,
              modifiers: [],
            });
        }
        if (c.trusted && c.gesture === "thumb") {
          element.component.setScrollTop(element.component.getMaxScrollTop() / 2);
          element.component.updateSync();
        }
        await sleep(2500);
        const rect = (
          c.gesture === "thumb" ? element.component.refs.verticalScrollbar.element : element
        ).getBoundingClientRect();
        const mouseX = Math.round(c.gesture === "thumb" ? rect.right - 3 : rect.left + 100);
        let mouseY = Math.round((rect.top + rect.bottom) / 2);
        const mouse = (type, held = false) =>
          ipcRenderer.invoke("lumine:window", "sendInputEvent", {
            type,
            x: mouseX,
            y: mouseY,
            button: "left",
            clickCount: 1,
            modifiers: held ? ["leftButtonDown"] : [],
          });
        const nativeStart = {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          top: element.component.refs.verticalScrollbar.element.scrollTop,
          logicalTop: element.component.getScrollTop(),
          maximum: element.component.getMaxScrollTop(),
        };
        if (c.trusted && c.gesture === "thumb") {
          await mouse("mouseUp");
          await mouse("mouseMove");
          await mouse("mouseDown", true);
          releaseMouse = () => mouse("mouseUp");
        }
        const component = element.component;
        let paintedFirst = editor.getFirstVisibleScreenRow();
        let paintedLast = editor.getLastVisibleScreenRow();
        const transform = component.updateContentScrollTransform;
        component.updateContentScrollTransform = function (...args) {
          const result = transform.apply(this, args);
          paintedFirst = editor.getFirstVisibleScreenRow();
          paintedLast = editor.getLastVisibleScreenRow();
          return result;
        };
        restorePaint = () => {
          component.updateContentScrollTransform = transform;
        };
        const frames = [],
          wheels = [],
          requests = [],
          chunks = [];
        paintDecisions = [];
        let active = true,
          bounce = 1,
          previous,
          original;
        stopFrames = () => {
          active = false;
        };
        if (mode.service) {
          original = mode.service.request;
          restoreRequest = () => {
            mode.service.request = original;
          };
          mode.service.request = async function (session, operation, data, options) {
            if (operation !== "view") return original.call(this, session, operation, data, options);
            const record = { at: performance.now(), ranges: data.ranges };
            requests.push(record);
            const accept = options?.onChunk;
            if (accept)
              options = {
                ...options,
                onChunk(packet) {
                  const at = performance.now();
                  const answer = accept(packet);
                  chunks.push({
                    at,
                    ms: performance.now() - at,
                    kind: packet.kind,
                    row: packet.start?.row,
                    events: packet.events?.length ?? 0,
                    viewport: editor.getFirstVisibleScreenRow(),
                    next: answer?.range,
                  });
                  return answer;
                },
              };
            try {
              return await original.call(this, session, operation, data, options);
            } finally {
              record.ms = performance.now() - record.at;
            }
          };
        }
        const start = performance.now();
        const frame = (t) => {
          if (!active) return;
          const first = paintedFirst,
            last = paintedLast;
          let covered = 0,
            total = 0;
          for (let row = first; row <= last; row++) {
            const p = editor.bufferPositionForScreenPosition([row, 0]);
            if (mode.cache?.covers(p, editor.getBuffer().clipPosition([p.row + 1, 0]))) covered++;
            total++;
          }
          const visibleLines = [
            ...element.querySelectorAll(".lines .line[data-screen-row]"),
          ].filter(
            (line) =>
              Number(line.dataset.screenRow) >= first && Number(line.dataset.screenRow) <= last,
          );
          frames.push({
            at: performance.now() - start,
            first,
            last,
            targetFirst: editor.getFirstVisibleScreenRow(),
            waitingForColors: Boolean(component.scrollHighlightingFrame),
            scopeMismatches: scopeMismatches(editor, mode, component, visibleLines),
            covered,
            total,
            lag: performance.now() - t,
            interval: previous == null ? 0 : t - previous,
            colored: visibleLines.reduce(
              (count, line) =>
                count +
                line.querySelectorAll(
                  ".syntax--keyword, .syntax--constant, .syntax--comment, .syntax--entity, .syntax--string",
                ).length,
              0,
            ),
          });
          previous = t;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        await Promise.all(
          Array.from(
            { length: 180 },
            (_, i) =>
              new Promise((resolve, reject) => {
                const target = start + i * (c.interval ?? 16.667);
                setTimeout(
                  async () => {
                    try {
                      const at = performance.now();
                      const direction = c.synthetic
                        ? i % 40 < 20
                          ? 1
                          : -1
                        : name === "end-up" ||
                            name === "middle-up" ||
                            (name === "middle-reverse" && i >= 90)
                          ? -1
                          : 1;
                      if (c.trusted && c.gesture === "thumb") {
                        if (
                          mouseY + 3 * direction * bounce < rect.top + 25 ||
                          mouseY + 3 * direction * bounce > rect.bottom - 25
                        )
                          bounce *= -1;
                        mouseY += 3 * direction * bounce;
                        await mouse("mouseMove", true);
                      } else if (c.trusted) {
                        await ipcRenderer.invoke("lumine:window", "sendInputEvent", {
                          type: "mouseWheel",
                          x: mouseX,
                          y: mouseY,
                          deltaX: 0,
                          deltaY: -(c.delta ?? 100) * direction,
                          modifiers: ["alt"],
                          canScroll: true,
                        });
                      } else if (c.gesture === "thumb") {
                        // Exercise the native-scroll event path used by a dragged
                        // scrollbar thumb; no smooth-wheel animation is involved.
                        const scrollbar = element.component.refs.verticalScrollbar.element;
                        const delta = (c.delta ?? 100) * direction;
                        if (
                          scrollbar.scrollTop + delta * bounce < 0 ||
                          scrollbar.scrollTop + delta * bounce > element.component.getMaxScrollTop()
                        )
                          bounce *= -1;
                        scrollbar.scrollTop += delta * bounce;
                        scrollbar.dispatchEvent(new Event("scroll"));
                      } else
                        element.dispatchEvent(
                          new WheelEvent("wheel", {
                            bubbles: true,
                            cancelable: true,
                            deltaY: (c.delta ?? 100) * direction,
                            altKey: true,
                          }),
                        );
                      wheels.push({
                        at: at - start,
                        delay: at - target,
                        ms: performance.now() - at,
                      });
                      resolve();
                    } catch (error) {
                      reject(error);
                    }
                  },
                  Math.max(0, target - performance.now()),
                );
              }),
          ),
        );
        if (releaseMouse) {
          await releaseMouse();
          releaseMouse = null;
        }
        await sleep(400);
        active = false;
        restorePaint();
        restorePaint = null;
        restoreRequest?.();
        restoreRequest = null;
        result.cases.push({
          name,
          start,
          frames,
          wheels,
          requests,
          chunks,
          nativeStart,
          paintDecisions,
        });
        paintDecisions = null;
        expect(frames.some((frame) => frame.first !== frames[0].first)).toBeTrue();
      }
    } finally {
      stopFrames?.();
      restoreRequest?.();
      restorePaint?.();
      await releaseMouse?.();
      element.component.waitForScrollHighlighting = waitForColors;
      editor.destroy();
      expect(hash()).toBe(before);
    }
    fs.writeFileSync(path.join(c.out, "fast-scroll.json"), JSON.stringify(result));
    const percentile = (values, fraction) =>
      values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;
    const summaries = result.cases.map((item) => {
      const frames = item.frames.filter(
        (frame) => frame.at > 100 && frame.at < item.wheels.at(-1).at,
      );
      return {
        name: item.name,
        frames: frames.length,
        viewportTravelRows: frames.reduce(
          (sum, frame, i) => sum + (i ? Math.abs(frame.first - frames[i - 1].first) : 0),
          0,
        ),
        framesWaitingForColors: frames.filter((frame) => frame.waitingForColors).length,
        framesWithScopeMismatch: frames.filter((frame) => frame.scopeMismatches.length).length,
        mismatchesWithoutExpiredBudget: frames.flatMap((frame) =>
          frame.scopeMismatches.filter((sample) => {
            const decision = item.paintDecisions
              .filter(
                (decision) =>
                  decision.at <= item.start + frame.at &&
                  decision.first <= sample.row &&
                  decision.last > sample.row,
              )
              .at(-1);
            return !decision?.expired;
          }),
        ).length,
        coveredFraction: mode.cache
          ? frames.reduce((sum, f) => sum + f.covered / f.total, 0) / frames.length
          : null,
        framesWithMissingColors: mode.cache
          ? frames.filter((frame) => frame.covered < frame.total).length
          : null,
        framesWithoutColoredSpans: frames.filter((f) => !f.colored).length,
        frameIntervalP99: percentile(
          frames.map((f) => f.interval),
          0.99,
        ),
        frameCallbackLagP99: percentile(
          frames.map((f) => f.lag),
          0.99,
        ),
        inputDelayP99: percentile(
          item.wheels.map((w) => w.delay),
          0.99,
        ),
        paintPacketP99: percentile(
          item.chunks.map((p) => p.ms),
          0.99,
        ),
        paintPacketMax: Math.max(0, ...item.chunks.map((p) => p.ms)),
      };
    });
    fs.writeFileSync(
      path.join(c.out, "fast-scroll-summary.json"),
      JSON.stringify(summaries, null, 2),
    );
    if (c.backend === "worker" && c.frameDeadline !== false)
      for (const summary of summaries) expect(summary.mismatchesWithoutExpiredBudget).toBe(0);
    console.log(JSON.stringify(summaries));
  }, 180000);
});
