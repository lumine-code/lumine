const fs = require("node:fs");
const path = require("node:path");
describe("Resident fuzzy workers", () => {
  it("measures async query publication through actual list layout", async () => {
    jasmine.useRealClock();
    const config = JSON.parse(process.env.LUMINE_FUZZY_WORKERS);
    const { Matcher } = require(config.implementation);
    const { Pool } = require(path.join(config.implementation, "benchmark/browser-pool"));
    const corpus = JSON.parse(fs.readFileSync(config.corpus));
    const items = Array.from({ length: config.count || 100000 }, (_, id) => ({
      id,
      text:
        id < corpus.length
          ? corpus[id]
          : `project-${Math.floor(id / corpus.length)}/${corpus[id % corpus.length]}`,
    }));
    const values = items.map((item) => item.text),
      expected = new Map();
    const reference = new Matcher(
      items.map((item) => item.id),
      values,
    );
    for (const query of ["s", "se", "sel", "slv", "notfound987654321"])
      expected.set(query, reference.matchIds(query, { algorithm: "fuzzaldrin" }));
    const native = spyOn(lumine.tools.fuzzyMatcher, "match").and.callThrough();
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1100px";
    workspace.style.height = "850px";
    jasmine.attachToDOM(workspace);
    const results = [];
    for (const workers of config.workers || [4, 8]) {
      const times = new Map();
      for (let sample = -2; sample < (config.samples || 9); sample++) {
        const start = performance.now(),
          pool = new Pool(config.implementation, values, workers);
        const single = new Matcher([], []);
        let list, host;
        const record = (name, time) => {
          if (sample < 0) return;
          if (!times.has(name)) times.set(name, []);
          times.get(name).push(time);
        };
        try {
          await pool.ready;
          list = lumine.workspace.buildSelectList({
            getItemId: (item) => item.id,
            source: {
              mode: "query",
              debounceMs: 0,
              load: async ({ query, signal }) => {
                const ids = query ? await pool.matchIds(query) : items.map((item) => item.id);
                if (signal.aborted) return undefined;
                return {
                  items: ids.map((id) => items[id]),
                  itemUpdateOptions: { selection: { mode: "first" } },
                };
              },
            },
            renderItem: (item, { highlight }) => {
              const li = document.createElement("li");
              const indexes =
                single.matchCandidate(item.text, list.getQuery(), {
                  algorithm: "fuzzaldrin",
                  recordMatchIndexes: true,
                })?.matchIndexes || [];
              li.appendChild(highlight(item.text, indexes));
              return li;
            },
          });
          host = lumine.workspace.addSelectList(list);
          const publication = (count, query) => {
            let lease, timer;
            const ready = new Promise((resolve, reject) => {
              lease = list.onDidChangeItems(() => {
                if (list.getQuery() === query && list.getItemCount() === count) resolve();
              });
              timer = setTimeout(() => reject(new Error("Source did not publish")), 15000);
            });
            return {
              ready,
              close: () => {
                lease.dispose();
                clearTimeout(timer);
              },
            };
          };
          const initial = publication(items.length, "");
          try {
            await host.show();
            await initial.ready;
            await list.updateComponent();
          } finally {
            initial.close();
          }
          list.getElement().getBoundingClientRect();
          record("open", performance.now() - start);
          for (const [name, query] of [
            ["first", "s"],
            ["extend", "se"],
            ["extend-more", "sel"],
            ["backspace", "se"],
            ["repeat", "s"],
            ["selective", "slv"],
            ["miss", "notfound987654321"],
          ]) {
            const current = publication(expected.get(query).length, query);
            const before = performance.now();
            try {
              const update = list.setQuery(query);
              const synchronous = performance.now() - before;
              await update;
              await current.ready;
              await list.updateComponent();
              list.getElement().getBoundingClientRect();
              record(name, performance.now() - before);
              record(name + "/sync", synchronous);
              expect(list.getFilteredItems().map((item) => item.id)).toEqual(expected.get(query));
            } finally {
              current.close();
            }
          }
        } finally {
          await host?.destroy();
          await list?.destroy();
          await pool.close();
        }
      }
      for (const [name, samples] of times) {
        const sorted = samples.slice().sort((a, b) => a - b);
        results.push({
          workers,
          name,
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          samples,
        });
      }
    }
    expect(native).not.toHaveBeenCalled();
    fs.writeFileSync(
      config.output,
      JSON.stringify({ runtime: process.versions, count: items.length, results }, null, 2),
    );
  }, 240000);
});
