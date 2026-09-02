const { jasmineRunFailed, specBody } = require("./runners/jasmine-test-runner");

// The runner used to shim the Jasmine 1.3 API so that specs written against it
// kept passing. That made a half-converted file indistinguishable from a
// converted one — nothing reported the old spelling, so it survived the
// migration to Jasmine 6 in about 140 files. The shim is gone; this pins that,
// so a spec written against the old API fails loudly instead of quietly working.
//
// Lint is the first line of defence (the names are no longer declared as
// globals, so `no-undef` reports them), but lint does not see a spec that
// reaches the old spy members off an object it built at runtime.
describe("the Jasmine API available to specs", () => {
  describe("the 1.3 async queue", () => {
    for (const name of ["waitsForPromise", "waitsFor", "waits", "runs"]) {
      it(`does not define ${name}`, () => {
        expect(window[name]).toBeUndefined();
        expect(global[name]).toBeUndefined();
      });
    }
  });

  describe("the 1.3 spy API", () => {
    let spy;

    beforeEach(() => {
      spy = jasmine.createSpy("subject");
    });

    for (const name of ["andReturn", "andCallFake", "andCallThrough", "andThrow", "reset"]) {
      it(`does not define spy.${name}`, () => {
        expect(spy[name]).toBeUndefined();
      });
    }

    for (const name of ["callCount", "mostRecentCall", "argsForCall", "wasCalled"]) {
      it(`does not define spy.${name}`, () => {
        expect(spy[name]).toBeUndefined();
      });
    }

    it("still offers the Jasmine 6 spellings", () => {
      spy.and.returnValue(7);
      expect(spy("a")).toBe(7);

      expect(spy.calls.count()).toBe(1);
      expect(spy.calls.mostRecent().args).toEqual(["a"]);
      expect(spy.calls.argsFor(0)).toEqual(["a"]);
      expect(spy.calls.any()).toBe(true);

      spy.calls.reset();
      expect(spy.calls.count()).toBe(0);
    });
  });

  describe("the 1.3 user context", () => {
    it("does not define this.addMatchers", function () {
      expect(this.addMatchers).toBeUndefined();
    });
  });

  // Two behaviours of the wrapper that outlived the shim, because the harness
  // itself depends on them.
  describe("what the runner still provides", () => {
    it("awaits a spec body that declares no parameter", async () => {
      let settled = false;
      await Promise.resolve().then(() => (settled = true));
      expect(settled).toBe(true);
    });

    it("tolerates spying a method that is already spied", () => {
      const target = { method() {} };
      const first = spyOn(target, "method");
      expect(() => spyOn(target, "method")).not.toThrow();
      expect(spyOn(target, "method")).toBe(first);
    });

    it("fails the run for suite-level errors even when every registered spec passes", () => {
      expect(
        jasmineRunFailed({
          overallStatus: "failed",
          failedSpecs: [],
          globalFailures: [new Error("duplicate suite")],
        }),
      ).toBe(true);
    });
  });

  // `pending()` reports itself by throwing. Pin the wrapper's propagation with
  // the same control flow but a private sentinel, so testing pending behavior
  // does not make the repository's own run pending.
  describe("a body that stops itself", () => {
    for (const kind of ["spec", "hook"]) {
      it(`propagates the ${kind} exception before later statements run`, () => {
        const stop = new Error(`${kind} stopped`);
        let bodyRan = false;
        const stopNow = () => {
          throw stop;
        };
        const original =
          kind === "spec"
            ? () => {
                stopNow();
                bodyRan = true;
              }
            : (done) => {
                stopNow();
                bodyRan = true;
                done();
              };
        const wrapped = specBody(original);
        const invoke = kind === "spec" ? () => wrapped() : () => wrapped(() => {});

        let caught;
        try {
          invoke();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(stop);
        expect(bodyRan).toBe(false);
      });
    }
  });
});
