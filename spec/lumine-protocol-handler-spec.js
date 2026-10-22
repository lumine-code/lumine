const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe('"lumine" package resource URL', () => {
  let directory;
  const name = "protocol-resource-lifecycle-spec";
  const scopedName = "@scope/protocol-resource-lifecycle-spec";

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-protocol-lifecycle-"));
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded(name)) await lumine.packages.unloadPackage(name);
    if (lumine.packages.isPackageLoaded(scopedName))
      await lumine.packages.unloadPackage(scopedName);
    if (
      fs.realpathSync(path.dirname(directory)) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(directory).startsWith("lumine-protocol-lifecycle-")
    )
      throw new Error("Unexpected protocol fixture directory");
    fs.rmSync(directory, { recursive: true });
  });

  function createPackage(dirname, value) {
    const root = path.join(directory, dirname);
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name, version: "1.0.0", engines: { lumine: "^1.0.0" } }),
    );
    fs.writeFileSync(path.join(root, "value.txt"), value);
    return root;
  }

  it("routes by loaded manifest identity and follows unload/reload without stale files", async () => {
    const first = createPackage("unrelated-first-directory", "first generation");
    const second = createPackage("unrelated-second-directory", "second generation");
    lumine.packages.loadPackage(first);
    expect(await (await fetch(`lumine://${name}/value.txt`)).text()).toBe("first generation");
    await expectAsync(fetch("lumine://unrelated-first-directory/value.txt")).toBeRejected();
    await lumine.packages.unloadPackage(name);
    await expectAsync(fetch(`lumine://${name}/value.txt`)).toBeRejected();
    lumine.packages.loadPackage(second);
    expect(await (await fetch(`lumine://${name}/value.txt`)).text()).toBe("second generation");
  });

  it("does not expose libraries that were never loaded as packages", async () => {
    await expectAsync(fetch("lumine://async/package.json")).toBeRejected();
  });

  it("loads and unloads scoped packages that do not use hostname resources", async () => {
    const root = createPackage("scoped-install-directory", "scoped generation");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: scopedName, version: "1.0.0", engines: { lumine: "^1.0.0" } }),
    );
    const pack = lumine.packages.loadPackage(root);
    expect(pack.name).toBe(scopedName);
    expect(lumine.packages.getLoadedPackage(scopedName)).toBe(pack);
    await lumine.packages.unloadPackage(scopedName);
    expect(lumine.packages.isPackageLoaded(scopedName)).toBe(false);
  });
});
