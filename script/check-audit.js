const fs = require("node:fs");
const path = require("node:path");

// npm matches advisories by package name/version, including git dependencies.
// This editor package is unrelated to npm's shelljs-based gitDiff library.
// Exempt only that advisory and verify both the lock and installed identity.
const COLLISION = "https://github.com/advisories/GHSA-6wfj-92cw-88vg";
function checkAudit(report, lock, readPackage) {
  if (
    report.error ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    Array.isArray(report.vulnerabilities)
  )
    throw new Error("Missing or unsuccessful npm audit report");
  const ignored = [],
    findings = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (!entry || !["info", "low", "moderate", "high", "critical"].includes(entry.severity))
      throw new Error("Invalid severity in npm audit report");
    const collision =
      name === "git-diff" &&
      entry.via?.length > 0 &&
      entry.via.every((via) => via.url === COLLISION) &&
      entry.nodes?.length > 0 &&
      entry.nodes.every((node) => {
        const resolved = lock.packages?.[node]?.resolved;
        if (
          !/^node_modules\//.test(node) ||
          node.includes("\\") ||
          node.split("/").includes("..") ||
          !/^git\+(?:ssh:\/\/git@|https:\/\/)github\.com\/lumine-code\/git-diff(?:\.git)?#[a-f0-9]{40}$/.test(
            resolved ?? "",
          )
        )
          return false;
        const manifest = readPackage(node);
        return (
          manifest.name === "git-diff" &&
          manifest.repository === "https://github.com/lumine-code/git-diff" &&
          manifest.engines?.lumine === "^1.0.0"
        );
      });
    (collision ? ignored : findings).push({ name, ...entry });
  }
  return {
    ignored,
    findings,
    failed: findings.some((entry) => ["high", "critical"].includes(entry.severity)),
  };
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, "..");
    const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const result = checkAudit(report, lock, (node) =>
      JSON.parse(fs.readFileSync(path.join(root, node, "package.json"), "utf8")),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.ignored.length)
      console.log(
        `Excluded ${COLLISION}: the pinned Lumine editor package is not the npm git-diff library.`,
      );
    process.exitCode = result.failed ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = checkAudit;
