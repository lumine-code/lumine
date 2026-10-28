const { test } = require("node:test");
const assert = require("node:assert/strict");
const check = require("./check-audit");

function fixture() {
  return {
    report: {
      auditReportVersion: 2,
      vulnerabilities: {
        "git-diff": {
          severity: "critical",
          nodes: ["node_modules/git-diff"],
          via: [{ url: "https://github.com/advisories/GHSA-6wfj-92cw-88vg" }],
        },
      },
    },
    lock: {
      packages: {
        "node_modules/git-diff": {
          resolved: "git+ssh://git@github.com/lumine-code/git-diff.git#" + "a".repeat(40),
        },
      },
    },
    manifest: {
      name: "git-diff",
      repository: "https://github.com/lumine-code/git-diff",
      engines: { lumine: "^1.0.0" },
    },
  };
}
test("only the verified editor-package name collision is excluded", () => {
  const { report, lock, manifest } = fixture();
  const result = check(report, lock, () => manifest);
  assert.equal(result.failed, false);
  assert.equal(result.ignored.length, 1);
  report.vulnerabilities.other = { severity: "high", nodes: ["node_modules/other"], via: [] };
  assert.equal(check(report, lock, () => manifest).failed, true);
});
for (const change of [
  (f) =>
    f.report.vulnerabilities["git-diff"].via.push({ url: "https://github.com/advisories/new" }),
  (f) => f.report.vulnerabilities["git-diff"].via.push("shelljs"),
  (f) =>
    (f.lock.packages["node_modules/git-diff"].resolved =
      "https://registry.npmjs.org/git-diff/-/git-diff-1.0.0.tgz"),
  (f) =>
    (f.lock.packages["node_modules/git-diff"].resolved =
      "git+https://github.com/other/git-diff#" + "a".repeat(40)),
  (f) => (f.manifest.repository = "https://github.com/other/git-diff"),
  (f) => delete f.manifest.engines,
])
  test("other sources and advisories remain blocking: " + change.toString(), () => {
    const f = fixture();
    change(f);
    assert.equal(check(f.report, f.lock, () => f.manifest).failed, true);
  });
test("audit failures and missing reports fail closed", () => {
  for (const report of [{}, { error: { message: "offline" } }])
    assert.throws(() => check(report, {}, () => ({})), /audit report/);
  assert.throws(
    () => check({ auditReportVersion: 2, vulnerabilities: { malformed: {} } }, {}, () => ({})),
    /audit report/,
  );
});
