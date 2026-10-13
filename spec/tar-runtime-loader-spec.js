const { execFileSync } = require("node:child_process");
const path = require("node:path");
const TarRuntimeLoader = require("../src/tar-runtime-loader");

describe("Native archive runtime loading", () => {
  it("loads the installation service without loading tar", () => {
    const source = `
      require("./src/package-installation-service");
      console.log(JSON.stringify(Object.keys(require.cache).filter(filename =>
        filename.replaceAll("\\\\", "/").includes("/node_modules/tar/"))));
    `;
    const output = execFileSync(process.execPath, ["-e", source], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      encoding: "utf8",
    });
    expect(JSON.parse(output.trim())).toEqual([]);
  });

  it("shares one native import across concurrent loads", async () => {
    const loader = new TarRuntimeLoader();
    spyOn(loader, "importArchive").and.callThrough();
    const first = loader.load();
    expect(loader.load()).toBe(first);
    const runtime = await first;
    expect(typeof runtime.x).toBe("function");
    expect(typeof runtime.c).toBe("function");
    expect(loader.importArchive).toHaveBeenCalledTimes(1);
  });

  it("retries a failed import and rejects an invalid extractor", async () => {
    const loader = new TarRuntimeLoader();
    spyOn(loader, "importArchive").and.rejectWith(new Error("Import unavailable"));
    await expectAsync(loader.load()).toBeRejectedWithError("Import unavailable");
    loader.importArchive.and.resolveTo({});
    await expectAsync(loader.load()).toBeRejectedWithError("Invalid archive extractor.");
    loader.importArchive.and.callThrough();
    expect(typeof (await loader.load()).x).toBe("function");
    expect(loader.importArchive).toHaveBeenCalledTimes(3);
  });
});
