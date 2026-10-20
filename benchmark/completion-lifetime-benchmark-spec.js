// COMPLETION_LIFETIME_CONFIG: {out}. Isolates request ownership using the real
// renderer AbortController and completion runtime, without popup layout or RPC.
const fs = require("node:fs");
const path = require("node:path");
describe("Completion request lifetime benchmark", () => {
  it("measures settled and superseded requests separately", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.COMPLETION_LIFETIME_CONFIG);
    const pack = await lumine.packages.activatePackage("autocomplete");
    const runtime = require(path.join(pack.path, "lib/completion-runtime"));
    function fixture(pending) {
      let aborts = 0;
      const owner = {
        editor: {},
        providerManager: {
          applicableProviders: () => [
            {
              getSuggestions({ signal }) {
                signal.addEventListener("abort", () => aborts++, { once: true });
                return pending
                  ? new Promise((resolve) =>
                      signal.addEventListener("abort", () => resolve([]), { once: true }),
                    )
                  : [{ text: "abc" }];
              },
            },
          ],
        },
        mergeSuggestionsFromProviders: runtime.mergeSuggestionsFromProviders,
        displaySuggestions: () => {},
      };
      return {
        owner,
        aborts: () => aborts,
        request: () =>
          runtime.getSuggestionsFromProviders.call(owner, { editor: owner.editor, prefix: "a" }),
      };
    }
    const warm = fixture(false);
    for (let i = 0; i < 50; i++) await warm.request();
    warm.owner.suggestionAbortController?.abort();
    const cases = [];
    for (const pending of [false, true]) {
      const f = fixture(pending),
        promises = [],
        count = 500;
      const at = performance.now();
      for (let i = 0; i < count; i++) {
        const result = f.request();
        if (pending) promises.push(result);
        else await result;
      }
      if (pending) {
        f.owner.suggestionAbortController.abort();
        await Promise.all(promises);
      }
      cases.push({ pending, count, ms: performance.now() - at, aborts: f.aborts() });
      if (pending) expect(f.aborts()).toBe(count);
      f.owner.suggestionAbortController?.abort();
    }
    fs.writeFileSync(config.out, JSON.stringify({ cases }, null, 2));
  });
});
