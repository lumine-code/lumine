const findInstallMethod = require("../src/find-install-method.js");

describe("find-install-method main", async () => {
  const platform = process.platform;
  const arch = process.arch;

  it("reports the spec-mode install method, deferring to the release channel", async () => {
    // The atom API cannot be mocked from a package, but a test run is by
    // definition in spec mode. A non-stable release channel (a -dev version)
    // outranks it, so derive the expectation instead of assuming one flavour.
    const expected = atom.getReleaseChannel() !== "stable" ? "Custom Release Channel" : "Spec Mode";

    let method = await findInstallMethod();

    expect(method.installMethod).toBe(expected);
    expect(method.platform).toBe(platform);
    expect(method.arch).toBe(arch);
  });
});
