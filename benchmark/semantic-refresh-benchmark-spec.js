// LUMINE_SEMANTIC_REFRESH_CONFIG: {out, packages}. Real editor markers and
// rendering with a deterministic provider, to separate refresh cost from RPC.
const fs = require("node:fs");
const path = require("node:path");

describe("Semantic refresh with active packages", () => {
  it("measures unchanged and partially changed dense classifications", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_SEMANTIC_REFRESH_CONFIG);
    const count = config.count ?? 20000;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate) => {
      const start = performance.now();
      while (!predicate()) {
        if (performance.now() - start > 30000) throw new Error("Classification did not settle");
        await sleep(10);
      }
    };
    for (const name of config.packages) await lumine.packages.activatePackage(name);
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1200px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const editor = await lumine.workspace.open();
    editor.getElement().setUpdatedSynchronously(false);
    editor.setText(
      Array(Math.ceil(count / 5))
        .fill("word word word word word")
        .join("\n"),
    );
    await sleep(500);
    const main = lumine.packages.getActivePackage("semantic-tokens").mainModule;
    const manager = main.manager;
    let tokens = Array.from({ length: count }, (_, i) => ({
      row: Math.floor(i / 5),
      column: (i % 5) * 5,
      length: 4,
      type: "variable",
    }));
    const provider = { priority: 10000, semanticTokens: () => tokens };
    const registration = main.consumeSemanticTokens(provider);
    const state = manager.states.get(editor);
    await waitFor(
      () => state.tokens.length === count && state.markerTokens.size > 0 && !state.building,
    );
    const results = [];
    const operations =
      count > 20000
        ? ["unchanged", "one-type-change", "one-last-type-change", "unchanged-again"]
        : ["unchanged", "one-type-change", "unchanged-again"];
    for (const operation of operations) {
      const previous = new Set(state.markerTokens.keys());
      const previousStore = state.tokens;
      const changedIndex = operation === "one-last-type-change" ? count - 1 : 0;
      const changesVisibleToken = [...previous].some((marker) =>
        marker
          .getStartBufferPosition()
          .isEqual([Math.floor(changedIndex / 5), (changedIndex % 5) * 5]),
      );
      tokens = tokens.map((token, i) => ({
        ...token,
        type: operation.startsWith("one-") && i === changedIndex ? "class" : token.type,
      }));
      const frames = [];
      let running = true,
        last;
      const frame = (at) => {
        if (!running) return;
        if (last !== undefined) frames.push(at - last);
        last = at;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const cpu = process.cpuUsage(),
        start = performance.now();
      await manager.fetch(state);
      const workMs = performance.now() - start;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const presentMs = performance.now() - start,
        consumed = process.cpuUsage(cpu);
      running = false;
      expect(state.tokens.length).toBe(count);
      expect(state.markerTokens.size).toBe(previous.size);
      let retained = 0;
      for (const marker of state.markerTokens.keys()) if (previous.has(marker)) retained++;
      expect(editor.getElement().querySelector(".line .semantic-tokens")).not.toBeNull();
      results.push({
        operation,
        count,
        rendered: previous.size,
        changesVisibleToken,
        workMs,
        presentMs,
        cpuMs: (consumed.user + consumed.system) / 1000,
        retained,
        storeRetained: state.tokens === previousStore,
        frames,
      });
      await sleep(200);
    }
    registration.dispose();
    editor.destroy();
    fs.writeFileSync(
      path.join(config.out, "result.json"),
      JSON.stringify({ finished: true, packages: config.packages, cases: results }, null, 2),
    );
  }, 120000);
});
