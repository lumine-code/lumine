// WORD_REFINEMENT_CONFIG: {out}. Run in Electron's Node mode from the selected
// frozen core. Fixtures are generated; no user file is read.
const fs = require("node:fs");
const crypto = require("node:crypto");
const TextStore = require("../src/text-store");
const config = JSON.parse(process.env.WORD_REFINEMENT_CONFIG);
const stats = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
    total: values.reduce((a, b) => a + b, 0),
  };
};

async function main() {
  const result = { versions: process.versions, cases: [] };
  for (const kind of ["refine", "repeat", "replace-query", "edit-refine", "unicode"]) {
    const store = new TextStore(
      Array.from(
        { length: 6000 },
        (_, row) => `candidate_${row} common_${row % 100} İstanbul_${row} ΟΣ_${row} 𐐀abc_${row}\n`,
      ).join(""),
    );
    const options = {
      extraWordCharacters: "_",
      maxCount: 100,
      position: { row: 3000, column: 12 },
    };
    const queries =
      kind === "repeat"
        ? ["candidate_1"]
        : kind === "replace-query"
          ? ["ca", "common", "notfound", "abc", "i"]
          : kind === "unicode"
            ? ["Ο", "ΟΣ", "ΟΣ_1", "i", "İs", "İsta", "abc"]
            : ["c", "ca", "can", "cand", "candidate", "candidate_", "candidate_1"];
    const coldAt = performance.now();
    await store.findWordCandidates(queries[0], options);
    const coldMs = performance.now() - coldAt;
    const durations = [];
    const digest = crypto.createHash("sha256");
    for (let round = 0; round < 8; round++) {
      for (const query of queries) {
        if (kind === "edit-refine") {
          store.setTextInRange(
            {
              start: { row: 3000, column: 0 },
              end: { row: 3000, column: 0 },
            },
            "x",
          );
        }
        const at = performance.now();
        const values = await store.findWordCandidates(query, options);
        durations.push(performance.now() - at);
        digest.update(JSON.stringify(values));
      }
    }
    result.cases.push({
      kind,
      coldMs,
      durations,
      stats: stats(durations),
      resultHash: digest.digest("hex"),
    });
  }
  fs.writeFileSync(config.out, JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
