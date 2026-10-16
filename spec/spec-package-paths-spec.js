const fs = require("node:fs");
const path = require("node:path");
const temp = require("@lumine-code/fs-temp");
const resolveSpecPackagePaths = require("./helpers/spec-package-paths");

describe("spec package dependencies", () => {
  let root, subject, userHome, resourcePath;

  function makePackage(directory, name, metadata = {}) {
    fs.mkdirSync(path.join(directory, "spec"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name,
        engines: { lumine: "^1.0.0" },
        ...metadata,
      }),
    );
    return directory;
  }

  function resolve(extraNames = []) {
    return resolveSpecPackagePaths({
      testPaths: [path.join(subject, "spec")],
      userHome,
      resourcePath,
      extraNames,
    });
  }

  beforeEach(() => {
    root = temp.mkdirSync("spec-package-paths-");
    subject = makePackage(path.join(root, "subject"), "subject", { specPackages: ["peer"] });
    userHome = path.join(root, "private-home");
    resourcePath = path.join(root, "editor");
  });

  it("resolves manifest-declared peers from the source fleet without environment variables", () => {
    const peer = makePackage(path.join(root, "peer"), "peer");
    const result = resolve();
    expect(result.packagePath).toBe(subject);
    expect(result.packageName).toBe("subject");
    expect([...result.packages]).toEqual([["peer", peer]]);
  });

  it("uses explicitly provisioned private-home copies before sibling checkouts", () => {
    makePackage(path.join(root, "peer"), "peer");
    const installed = makePackage(path.join(userHome, "packages", "peer"), "peer");
    expect(resolve().packages.get("peer")).toBe(installed);
  });

  it("uses bundled dependencies when there is no provisioned or source peer", () => {
    const bundled = makePackage(path.join(resourcePath, "node_modules", "peer"), "peer");
    expect(resolve().packages.get("peer")).toBe(bundled);
  });

  it("validates peer identity and package type rather than trusting directory names", () => {
    makePackage(path.join(userHome, "packages", "peer"), "unrelated");
    makePackage(path.join(root, "peer"), "peer", { engines: { node: ">=24" } });
    expect(() => resolve()).toThrowError(/Unable to resolve spec package 'peer'/);
  });

  it("keeps the package under test on its source generation when provisioned explicitly", () => {
    makePackage(path.join(root, "peer"), "peer");
    makePackage(path.join(userHome, "packages", "subject"), "subject");
    expect(resolve(["subject"]).packages.get("subject")).toBe(subject);
  });

  it("rejects malformed declarations instead of interpreting them as paths", () => {
    makePackage(subject, "subject", { specPackages: ["../peer"] });
    expect(() => resolve()).toThrowError(/Invalid spec package name/);
  });
});
