// Run against a normal window launched by script/drive.js with an isolated home.
// Usage: node benchmark/syntax-worker-scroll.js <config.json>
// Config: {port,out,gesture: "wheel"|"thumb",capture?:true,warmup?:1000}.
const fs = require("fs"),
  path = require("path");
const crypto = require("node:crypto");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (
  !config.out ||
  !Number.isInteger(config.port) ||
  !["wheel", "thumb"].includes(config.gesture ?? "wheel")
)
  throw new Error("Provide out, port and gesture (wheel or thumb)");
const out = path.resolve(config.out);
fs.mkdirSync(out, { recursive: true });
(async () => {
  const target = (await (await fetch(`http://127.0.0.1:${config.port}/json/list`)).json()).find(
    (t) => t.type === "page" && t.url.includes("index.html"),
  );
  if (!target) throw new Error("No normal Lumine window on the requested CDP port");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map(),
    frames = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      pending.set(n, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      m.error ? p.reject(m.error) : p.resolve(m.result);
    } else if (m.method === "Page.screencastFrame") {
      frames.push(m.params);
      void send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
    }
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw r.exceptionDetails;
    return r.result.value;
  };
  let probeInstalled = false,
    capturing = false,
    pressed = null;
  try {
    const input = await evaluate("lumine.workspace.getActiveTextEditor()?.getPath()");
    if (!input) throw new Error("Open the fixture in the isolated window before measuring");
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(input)).digest("hex");
    const inputHash = hash();
    await evaluate(`window.__lumineSyntaxScrollConfig=${JSON.stringify(config)};`);
    console.log(
      await evaluate(
        fs.readFileSync(path.join(__dirname, "syntax-worker-scroll-probe.js"), "utf8"),
      ),
    );
    probeInstalled = true;
    if (config.capture) {
      await send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      capturing = true;
    }
    const rect = await evaluate(
      `(()=>{const r=lumine.workspace.getActiveTextEditor().getElement().getBoundingClientRect();return {x:r.x+100,y:r.y+100}})()`,
    );
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...rect,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...rect,
      button: "left",
      clickCount: 1,
    });
    if (config.gesture === "thumb")
      await evaluate(
        `(()=>{const c=lumine.workspace.getActiveTextEditor().getElement().component;c.setScrollTop(c.getMaxScrollTop()/2);c.updateSync();return new Promise(r=>setTimeout(r,500))})()`,
      );
    await evaluate("window.__lumineSyntaxScrollProbe.start()");
    const gesture = config.gesture || "wheel";
    const bar =
      gesture === "thumb"
        ? await evaluate(
            `(()=>{const c=lumine.workspace.getActiveTextEditor().getElement().component,r=c.refs.verticalScrollbar.element.getBoundingClientRect();return {x:r.right-3,y:(r.top+r.bottom)/2,top:r.top,bottom:r.bottom}})()`,
          )
        : null;
    if (bar) {
      pressed = { x: bar.x, y: bar.y };
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: bar.x,
        y: bar.y,
        button: "left",
        clickCount: 1,
      });
    }
    let y = bar?.y,
      dir = 1;
    const began = performance.now();
    const inputs = [];
    for (let n = 0; n < 180; n++) {
      const wait = began + n * (config.interval ?? 16.667) - performance.now();
      if (wait > 0) await delay(wait);
      if (bar) {
        y += dir * (config.thumbStep ?? 6);
        if (y > bar.bottom - 20 || y < bar.top + 20) {
          dir = -dir;
          y += dir * (config.thumbStep ?? 6);
        }
        pressed = { x: bar.x, y };
        inputs.push(
          send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: bar.x,
            y,
            button: "left",
            buttons: 1,
          }),
        );
      } else
        inputs.push(
          send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            ...rect,
            deltaX: 0,
            deltaY: (n < 90 ? 1 : -1) * (config.delta ?? 400),
            modifiers: 1,
          }),
        );
    }
    await Promise.all(inputs);
    if (bar)
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: bar.x,
        y,
        button: "left",
        clickCount: 1,
      });
    pressed = null;
    await delay(500);
    const data = await evaluate("window.__lumineSyntaxScrollProbe.stop()");
    probeInstalled = false;
    if (config.capture) await send("Page.stopScreencast");
    capturing = false;
    if (hash() !== inputHash) throw new Error("Fixture changed during scrolling");
    data.configuration = config;
    data.inputHash = inputHash;
    if (data.summary.range[0] === data.summary.range[1])
      throw new Error("Gesture did not move the viewport");
    fs.writeFileSync(path.join(out, "data.json"), JSON.stringify(data));
    for (let n = 0; n < frames.length; n++)
      fs.writeFileSync(
        path.join(out, `frame-${String(n).padStart(4, "0")}.png`),
        Buffer.from(frames[n].data, "base64"),
      );
    fs.writeFileSync(
      path.join(out, "frames.json"),
      JSON.stringify(frames.map(({ metadata }) => metadata)),
    );
    console.log(JSON.stringify({ frames: frames.length, summary: data.summary }));
  } finally {
    if (pressed)
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...pressed,
        button: "left",
        clickCount: 1,
      }).catch(() => {});
    if (probeInstalled) await evaluate("window.__lumineSyntaxScrollProbe?.stop()").catch(() => {});
    if (capturing) await send("Page.stopScreencast").catch(() => {});
    ws.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
