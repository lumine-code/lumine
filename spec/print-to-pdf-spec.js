const fs = require("fs");
const path = require("path");
const temp = require("@lumine-code/temp").track();

// End to end on purpose: this crosses IPC into the main process, opens a real
// offscreen window and asks Chromium for a real PDF. A stub either side of that
// boundary would prove nothing about the part that can actually break.
describe("lumine.application.printToPDF", () => {
  let outputPath;

  beforeEach(() => {
    jasmine.useRealClock();
    outputPath = path.join(temp.mkdirSync("lumine-print-to-pdf"), "out.pdf");
  });

  afterEach(() => {
    try {
      temp.cleanupSync();
    } catch {
      // Temp cleanup is best-effort.
    }
  });

  it("writes a PDF for the document it was given", async () => {
    const result = await lumine.application.printToPDF(
      "<!doctype html><title>t</title><h1>Printed from a spec</h1>",
      outputPath,
    );

    expect(result.outcome).toBe("success");
    expect(result.result).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);

    // A PDF is identified by its header, not by its extension.
    const contents = fs.readFileSync(outputPath);
    expect(contents.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(contents.length).toBeGreaterThan(0);
  });

  it("honours the print options it is passed", async () => {
    const portraitPath = path.join(path.dirname(outputPath), "portrait.pdf");
    await lumine.application.printToPDF("<!doctype html><title>t</title><p>x</p>", portraitPath, {
      pageSize: "A4",
    });
    await lumine.application.printToPDF("<!doctype html><title>t</title><p>x</p>", outputPath, {
      pageSize: "A4",
      landscape: true,
    });

    // Same content, same paper, different orientation — so the two files cannot
    // be identical unless the options were dropped on the floor.
    expect(fs.readFileSync(outputPath).length).not.toBe(fs.readFileSync(portraitPath).length);
  });

  // A missing parent directory is not one of these: fs-plus creates it, so a
  // destination inside a folder the user has not made yet still works.
  it("reports a destination it cannot write instead of throwing", async () => {
    const result = await lumine.application.printToPDF(
      "<!doctype html><title>t</title><p>x</p>",
      path.dirname(outputPath),
    );

    expect(result.outcome).toBe("failure");
    expect(result.error.message).toBeTruthy();
  });

  it("creates the destination's directory when it does not exist yet", async () => {
    const nestedPath = path.join(path.dirname(outputPath), "not", "made", "yet", "out.pdf");

    const result = await lumine.application.printToPDF(
      "<!doctype html><title>t</title><p>x</p>",
      nestedPath,
    );

    expect(result.outcome).toBe("success");
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it("refuses arguments the main process cannot use", async () => {
    await expectAsync(lumine.application.printToPDF("", outputPath)).toBeRejected();
    await expectAsync(lumine.application.printToPDF("<p>x</p>", "")).toBeRejected();
    await expectAsync(
      lumine.application.printToPDF("<p>x</p>", outputPath, ["not-an-object"]),
    ).toBeRejected();
  });
});
