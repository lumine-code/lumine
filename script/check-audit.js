const fs = require("node:fs");

function checkAudit(report) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.error ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    typeof report.vulnerabilities !== "object" ||
    Array.isArray(report.vulnerabilities)
  )
    throw new Error("Missing or unsuccessful npm audit report");
  const findings = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !["info", "low", "moderate", "high", "critical"].includes(entry.severity)
    )
      throw new Error("Invalid severity in npm audit report");
    findings.push({ ...entry, name });
  }
  return {
    findings,
    failed: findings.some((entry) => ["high", "critical"].includes(entry.severity)),
  };
}

if (require.main === module) {
  try {
    const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const result = checkAudit(report);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = checkAudit;
