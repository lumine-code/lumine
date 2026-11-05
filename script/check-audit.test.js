const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const check = require("./check-audit");

function report(severity, name = "example") {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      [name]: {
        severity,
        nodes: [`node_modules/${name}`],
        via: [{ url: "https://github.com/advisories/GHSA-6wfj-92cw-88vg" }],
      },
    },
  };
}

test("a successful empty audit passes", () => {
  assert.deepEqual(check({ auditReportVersion: 2, vulnerabilities: {} }), {
    findings: [],
    failed: false,
  });
});

for (const severity of ["info", "low", "moderate"])
  test(`${severity} findings remain visible below the high-severity gate`, () => {
    const result = check(report(severity));
    assert.equal(result.failed, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, severity);
  });

for (const [name, severity] of [
  ["example", "high"],
  ["example", "critical"],
  ["git-diff", "critical"],
  ["git-chunk", "critical"],
])
  test(`${name} ${severity} findings block without package-name exceptions`, () => {
    const result = check(report(severity, name));
    assert.equal(result.failed, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].name, name);
  });

test("audit failures and malformed reports fail closed", () => {
  for (const value of [
    undefined,
    null,
    [],
    42,
    "report",
    {},
    { error: { message: "offline" } },
    { auditReportVersion: 1, vulnerabilities: {} },
    { auditReportVersion: 2, vulnerabilities: null },
    { auditReportVersion: 2, vulnerabilities: [] },
    { auditReportVersion: 2, vulnerabilities: 42 },
    { auditReportVersion: 2, vulnerabilities: { malformed: null } },
    { auditReportVersion: 2, vulnerabilities: { malformed: [] } },
    { auditReportVersion: 2, vulnerabilities: { malformed: {} } },
    { auditReportVersion: 2, vulnerabilities: { malformed: { severity: "unknown" } } },
  ])
    assert.throws(() => check(value), /audit report/);
});

test("the CLI rejects invalid JSON and exits according to the complete audit report", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-audit-gate-"));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "audit.json");
  const run = (contents) => {
    fs.writeFileSync(file, contents);
    return spawnSync(process.execPath, [path.join(__dirname, "check-audit.js"), file], {
      encoding: "utf8",
      windowsHide: true,
    });
  };
  const malformed = run("{");
  assert.equal(malformed.status, 1);
  assert.notEqual(malformed.stderr, "");
  const moderate = run(JSON.stringify(report("moderate")));
  assert.equal(moderate.status, 0, moderate.stderr);
  assert.equal(JSON.parse(moderate.stdout).findings.length, 1);
  const critical = run(JSON.stringify(report("critical", "git-diff")));
  assert.equal(critical.status, 1, critical.stderr);
  assert.equal(JSON.parse(critical.stdout).findings[0].name, "git-diff");
});
