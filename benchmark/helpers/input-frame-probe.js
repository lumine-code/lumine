// Benchmark-only instrumentation. A marker proves that a subscription frame
// contains an acknowledged editor DOM revision; rAF alone is never a paint.
const { ipcRenderer } = require("electron");
const { summarize } = require("../presentation-observer");

const CHANNEL = "lumine:multicursor-input-frame";
const now = () => Number(process.hrtime.bigint()) / 1e6;

async function attach(editor) {
  const element = editor.getElement();
  const component = element.component;
  const marker = document.createElement("div");
  marker.style.cssText =
    "position:fixed;left:2px;top:2px;width:12px;height:12px;z-index:2147483647;pointer-events:none;opacity:1;";
  const setMarker = (revision) => {
    marker.style.backgroundColor = `rgb(${revision >> 8},${revision & 255},197)`;
  };
  setMarker(0);
  document.body.append(marker);
  let active = null;
  let disposed = false;
  const visible = () => document.visibilityState === "visible" && document.hasFocus();
  const onVisibility = () => {
    if (active && !visible()) active.visibilityLost = true;
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onVisibility);
  const changed = editor.getBuffer().onDidApplyChanges(() => {
    if (!active) return;
    active.publications++;
    if (active.acknowledged) {
      active.acknowledged = false;
      setMarker(0);
    }
  });
  const onCapture = (_event, frame) => {
    if (active?.revision !== frame.revision || active.capture) return;
    active.capture = frame;
    active.resolve(frame);
  };
  ipcRenderer.on(`${CHANNEL}:capture`, onCapture);
  const failureDiagnostic = () => {
    const position = editor.getCursorScreenPosition();
    const selector = `.line[data-screen-row="${position.row}"]:not([data-off-screen])`;
    const line = element.querySelector(selector);
    const rect = element.getBoundingClientRect();
    const pane = lumine.workspace.paneForItem(editor);
    const actualPositions = editor.getCursorBufferPositions().map((point) => point.serialize());
    let nativeWindow;
    try {
      nativeWindow = ipcRenderer.sendSync(`${CHANNEL}:diagnostic`);
    } catch (error) {
      nativeWindow = { error: error.message };
    }
    return {
      nativeWindow,
      actualPositions,
      expectedPositions: active.expectedPositions,
      cursorScreenPosition: position.serialize(),
      cursorLine: {
        selector,
        found: Boolean(line),
        actualText: line?.textContent?.slice(0, 200),
        modelText: editor.screenLineForScreenRow(position.row)?.lineText?.slice(0, 200),
        rect: line?.getBoundingClientRect().toJSON(),
      },
      editor: {
        connected: element.isConnected,
        rect: rect.toJSON(),
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility,
        scrollTop: component.getScrollTop(),
        paneExists: Boolean(pane),
        paneIsActive: lumine.workspace.getActivePane() === pane,
        paneItemIsActive: pane?.getActiveItem() === editor,
        workspaceItemIsActive: lumine.workspace.getActivePaneItem() === editor,
        currentViewIsExpected: lumine.views.getView(editor) === element,
      },
      activeElement: {
        tag: document.activeElement?.tagName,
        editorContains: element.contains(document.activeElement),
      },
      renderedLines: [...element.querySelectorAll(".line:not([data-off-screen])")]
        .slice(0, 50)
        .map((node) => ({ row: node.dataset.screenRow, text: node.textContent.slice(0, 200) })),
    };
  };
  const snapshot = () =>
    active && {
      revision: active.revision,
      startedAt: active.startedAt,
      domAcknowledgedAt: active.domAcknowledgedAt,
      publications: active.publications,
      minimumPublications: active.minimumPublications,
      acknowledged: active.acknowledged,
      visibilityLost: active.visibilityLost,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      visibleLineChecks: active.visibleLineChecks,
      textChecks: active.textChecks,
      verificationMs: active.verificationMs,
      capture: active.capture,
      diagnostic: !active.capture || active.visibilityLost ? failureDiagnostic() : undefined,
    };
  const acknowledge = () => {
    const measured = active;
    if (
      !measured?.startedAt ||
      measured.acknowledged ||
      measured.publications < measured.minimumPublications ||
      !visible()
    )
      return;
    const positions = editor.getCursorBufferPositions();
    if (
      positions.length !== measured.expectedPositions.length ||
      positions.some(
        (point, index) =>
          point.row !== measured.expectedPositions[index][0] ||
          point.column !== measured.expectedPositions[index][1],
      )
    )
      return;
    const row = editor.getCursorScreenPosition().row;
    const line = element.querySelector(`.line[data-screen-row="${row}"]:not([data-off-screen])`);
    measured.visibleLineChecks++;
    if (!line || line.textContent !== editor.screenLineForScreenRow(row).lineText) return;
    // Check a full snapshot only once per matching publication, after cheap
    // position and visible-DOM checks. This verification cost is measured.
    if (measured.verifiedPublication !== measured.publications) {
      measured.verifiedPublication = measured.publications;
      const started = now();
      const source = editor.getBuffer().getTextSnapshot();
      measured.textMatches =
        source.length === measured.expectedText.length && source.slice() === measured.expectedText;
      measured.verificationMs += now() - started;
      measured.textChecks++;
    }
    if (!measured.textMatches) return;
    measured.acknowledged = true;
    measured.domAcknowledgedAt = now();
    setMarker(measured.revision);
    ipcRenderer.send(CHANNEL, {
      type: "ack",
      revision: measured.revision,
      domAcknowledgedAt: measured.domAcknowledgedAt,
    });
  };
  const original = component.updateSyncAfterMeasuringContent;
  const wrapped = function (...args) {
    const result = original.apply(this, args);
    acknowledge();
    return result;
  };
  component.updateSyncAfterMeasuringContent = wrapped;
  let animationFrame;
  const observeFrame = () => {
    // This only observes state after an ordinary component update. It never
    // forces updateSync, layout or a paint in the timed path.
    acknowledge();
    animationFrame = requestAnimationFrame(observeFrame);
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(animationFrame);
    changed.dispose();
    if (component.updateSyncAfterMeasuringContent === wrapped)
      component.updateSyncAfterMeasuringContent = original;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onVisibility);
    ipcRenderer.removeListener(`${CHANNEL}:capture`, onCapture);
    marker.remove();
    active = null;
    await ipcRenderer.invoke(CHANNEL, { type: "detach" });
  };
  try {
    const environment = await ipcRenderer.invoke(CHANNEL, {
      type: "attach",
      marker: { x: 8, y: 8 },
      devicePixelRatio,
    });
    element.focus();
    for (let attempt = 0; attempt < 50 && !visible(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!visible()) throw new Error("Frame capture requires a visible focused renderer");
    const calibrations = [];
    for (let index = 0; index < 7; index++) {
      const sentAt = now();
      const { receivedAt } = await ipcRenderer.invoke(CHANNEL, { type: "clock" });
      const returnedAt = now();
      calibrations.push({
        roundTripMs: returnedAt - sentAt,
        mainMinusRendererBoundsMs: [receivedAt - returnedAt, receivedAt - sentAt],
      });
    }
    const clockCalibration = calibrations.reduce((best, entry) =>
      entry.roundTripMs < best.roundTripMs ? entry : best,
    );
    const [lower, upper] = clockCalibration.mainMinusRendererBoundsMs;
    if (lower > 0.25 || upper < -0.25)
      throw new Error("Renderer and main hrtime clocks are not comparable within the IPC bounds");
    await ipcRenderer.invoke(CHANNEL, { type: "calibration-start" });
    const animationTimes = [];
    for (let index = 0; index < 40; index++) {
      animationTimes.push(await new Promise(requestAnimationFrame));
      setMarker(60000 + index);
    }
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const calibrationFrames = await ipcRenderer.invoke(CHANNEL, { type: "calibration-finish" });
    setMarker(0);
    if (calibrationFrames.length < 5)
      throw new Error("Frame subscription did not reliably decode calibration markers");
    const frameIntervals = calibrationFrames
      .slice(1)
      .map((entry, index) => entry.observedAt - calibrationFrames[index].observedAt);
    const cadence = {
      frames: calibrationFrames,
      intervalsMs: frameIntervals,
      observedSubscriptionIntervals: summarize(frameIntervals),
      animationFrameIntervalsMs: animationTimes
        .slice(1)
        .map((time, index) => time - animationTimes[index]),
      definition:
        "Marker animation calibration outside timed editor operations; not display cadence",
    };
    const style = getComputedStyle(element);
    animationFrame = requestAnimationFrame(observeFrame);
    return {
      metadata: {
        ...environment,
        clock: "process.hrtime.bigint(), shared OS monotonic clock; no offset correction",
        clockCalibration,
        clockCalibrationSamples: calibrations,
        cadence,
        renderer: {
          devicePixelRatio,
          viewport: { width: innerWidth, height: innerHeight },
          font: { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight },
          themes: lumine.themes.getActiveThemeNames(),
        },
        metric: "probe.start immediately before editor invocation to subscription-observed frame",
        caveats: [
          "Captured compositor output, not physical monitor scanout or first display presentation.",
          "Frame subscription includes capture/copy/delivery delay and cannot count missed display frames.",
          "Marker, IPC and exact-text verification add overhead; verificationMs is retained per sample.",
          "DOM acknowledgement proves current text and positions, not syntax-correct highlighting.",
        ],
      },
      async arm({ revision, expectedText, expectedPositions, minimumPublications = 1 }) {
        if (disposed || (active && !active.capture))
          throw new Error("Cannot arm a disposed probe or replace an unfinished sample");
        if (
          !Number.isSafeInteger(revision) ||
          revision < 1 ||
          revision >= 60000 ||
          typeof expectedText !== "string" ||
          !Array.isArray(expectedPositions) ||
          !expectedPositions.length ||
          expectedPositions.some(
            (point) =>
              !Array.isArray(point) ||
              point.length !== 2 ||
              point.some((value) => !Number.isSafeInteger(value) || value < 0),
          ) ||
          !Number.isSafeInteger(minimumPublications) ||
          minimumPublications < 1
        )
          throw new Error("Invalid frame probe expectation");
        setMarker(0);
        let resolve;
        const presented = new Promise((done) => {
          resolve = done;
        });
        active = {
          revision,
          expectedText,
          expectedPositions,
          minimumPublications,
          publications: 0,
          acknowledged: false,
          visibleLineChecks: 0,
          textChecks: 0,
          verificationMs: 0,
          visibilityLost: !visible(),
          presented,
          resolve,
        };
        return ipcRenderer.invoke(CHANNEL, { type: "arm", revision });
      },
      start() {
        if (!active || active.startedAt) throw new Error("Arm one sample before starting it");
        active.startedAt = now();
        ipcRenderer.send(CHANNEL, {
          type: "start",
          revision: active.revision,
          startedAt: active.startedAt,
        });
        return active.startedAt;
      },
      async waitForCapture(timeoutMs = 5000) {
        if (!active?.startedAt) throw new Error("Start a sample before waiting for its capture");
        let timer;
        try {
          await Promise.race([
            active.presented,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Frame capture timed out: ${JSON.stringify(snapshot())}`)),
                timeoutMs,
              );
            }),
          ]);
          const result = snapshot();
          if (
            result.visibilityLost ||
            !visible() ||
            !result.acknowledged ||
            !result.capture.visible ||
            !result.capture.focused ||
            result.capture.invocationToObservedFrameMs < 0
          )
            throw new Error(`Invalid frame observation: ${JSON.stringify(result)}`);
          return result;
        } finally {
          clearTimeout(timer);
        }
      },
      snapshot,
      dispose,
    };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

module.exports = { attach };
