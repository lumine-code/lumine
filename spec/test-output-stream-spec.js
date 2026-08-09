const childProcess = require("child_process");

describe("test output streams", () => {
  it("can be inherited by child processes", async () => {
    const command = process.platform === "win32" ? process.env.ComSpec : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "exit 0"] : ["-c", "exit 0"];

    const exitCode = await new Promise((resolve, reject) => {
      const child = childProcess.spawn(command, args, {
        stdio: ["ignore", process.stdout, process.stderr],
      });
      child.on("error", reject);
      child.on("close", resolve);
    });

    expect(process.stdout.fd).toBe(1);
    expect(process.stderr.fd).toBe(2);
    expect(exitCode).toBe(0);
  });
});
