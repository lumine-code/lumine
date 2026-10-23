const Service = require("../src/syntax-worker-service");
const { setTimeout, clearTimeout } = require("node:timers");
const WorkerMode = require("../src/tree-sitter-worker-language-mode");
const path = require("node:path");

describe("Syntax requests waiting for readiness", () => {
  for (const cancelled of [false, true]) {
    it(`handles a readiness failure after cancellation ${cancelled}`, async () => {
      let fail;
      const error = new Error("Environment unavailable");
      const controller = new AbortController();
      const service = {
        syntaxEpoch: 1,
        ensureEnvironment: () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      };
      const session = {
        controller: new AbortController(),
        epoch: 1,
        buffer: { getTextRevision: () => 1 },
      };
      const pending = Service.prototype.request
        .call(service, session, "analyze", {}, { signal: controller.signal })
        .catch((error) => error);
      if (cancelled) {
        controller.abort();
        expect((await pending).name).toBe("AbortError");
      }
      fail(error);
      if (!cancelled) expect(await pending).toBe(error);
      // The cancelled wait must still consume the shared operation's late rejection.
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  for (const phase of ["environment", "document edits"]) {
    for (const cancellation of ["caller", "session"]) {
      it(`cancels ${cancellation} during ${phase} without cancelling another view or document`, async () => {
        let release, timer;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const session = () => ({
          controller: new AbortController(),
          epoch: 1,
          generation: 2,
          buffer: { getTextRevision: () => 7 },
          chain: phase === "document edits" ? gate : Promise.resolve(),
        });
        const first = session();
        const second = cancellation === "caller" ? first : session();
        const service = {
          syntaxEpoch: 1,
          ensureEnvironment: () => (phase === "environment" ? gate : Promise.resolve()),
          client: {
            request: jasmine
              .createSpy("request")
              .and.resolveTo({ revision: 7, generation: 2, value: "ready" }),
          },
        };
        const controller = new AbortController();
        const pending = Service.prototype.request
          .call(service, first, "analyze", {}, { signal: controller.signal })
          .then(
            () => "unexpected success",
            (error) => error.name,
          );
        const surviving = Service.prototype.request.call(service, second, "analyze");
        await Promise.resolve();
        if (cancellation === "caller") controller.abort();
        else first.controller.abort();
        try {
          const result = await Promise.race([
            pending,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve("still waiting"), 50);
            }),
          ]);
          expect(result).toBe("AbortError");
          expect(service.client.request).not.toHaveBeenCalled();
        } finally {
          clearTimeout(timer);
          release();
        }
        expect(await pending).toBe("AbortError");
        expect(await surviving).toBe("ready");
        expect(service.client.request).toHaveBeenCalledTimes(1);
      });
    }
  }
});

describe("Syntax analysis shared by split editors", () => {
  for (const phase of ["environment", "document edits"]) {
    it(`closes one view while ${phase} is pending and keeps the other view usable`, async () => {
      jasmine.useRealClock();
      await lumine.packages.activatePackage("language-javascript");
      const service = new Service(lumine.grammars);
      const first = lumine.workspace.buildTextEditor();
      first.setText("const value = 1;\n");
      const mode = new WorkerMode({
        buffer: first.getBuffer(),
        grammar: lumine.grammars.grammarForScopeName("source.js"),
        service,
      });
      first.getBuffer().setLanguageMode(mode);
      const second = first.copy();
      let release, entered, timer;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const modulePath = path.join(__dirname, "fixtures/syntax-worker-analysis.js");
      let pending;
      try {
        await first.whenGrammarSettled();
        await mode.refresh();
        const analyze = mode.analyze.bind(mode);
        let held = false;
        spyOn(mode, "analyze").and.callFake((...args) => {
          if (!held) {
            held = true;
            if (phase === "environment") spyOn(service, "ensureEnvironment").and.returnValue(gate);
            else {
              const previous = mode.session.chain;
              mode.session.chain = gate.then(() => previous);
            }
            entered();
          }
          return analyze(...args);
        });
        pending = first.analyzeSyntax(modulePath, "summary");
        await started;
        first.destroy();
        const result = await Promise.race([
          pending,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("still waiting"), 100);
          }),
        ]);
        expect(result).toBeNull();
        expect(mode.session.closed).toBe(false);
        release();
        await pending;
        second.getBuffer().append("const next = 2;\n");
        const surviving = await second.analyzeSyntax(modulePath, "summary");
        expect(surviving.text).toBe(second.getText());
        expect(mode.error).toBeFalsy();
      } finally {
        clearTimeout(timer);
        release();
        first.destroy();
        second.destroy();
        await service.dispose();
        await pending;
      }
    });
  }
});
