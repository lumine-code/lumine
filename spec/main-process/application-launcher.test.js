const assert = require("./assert");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sinon = require("sinon");
const { openApplication } = require("../../src/application-launcher");

describe("Application launcher", () => {
  let sandbox;
  let child;
  const executablePath = path.resolve("applications", "GUI application.exe");
  const cwd = path.resolve("project with spaces");

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    child = new EventEmitter();
    child.pid = 123;
    child.unref = sandbox.spy();
  });

  afterEach(() => sandbox.restore());

  it("launches literal arguments directly and resolves only after spawn, without waiting for exit", async () => {
    const spawn = sandbox.stub(childProcess, "spawn").returns(child);
    const args = ["a file & more.gra", 'literal "quotes"', "%PATH%", "a|b", ""];
    let settled = false;
    const pending = openApplication(executablePath, args, { cwd }).then((pid) => {
      settled = true;
      return pid;
    });
    await Promise.resolve();

    assert.isFalse(settled);
    assert.isFalse(child.unref.called);
    assert.isTrue(
      spawn.calledWithExactly(executablePath, args, {
        cwd,
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }),
    );
    child.emit("spawn");

    assert.strictEqual(await pending, 123);
    assert.isTrue(child.unref.calledOnce);
    assert.strictEqual(child.listenerCount("spawn"), 0);
    assert.strictEqual(child.listenerCount("error"), 0);
    assert.strictEqual(child.listenerCount("exit"), 0);
  });

  it("rejects asynchronous startup errors and releases both startup listeners", async () => {
    sandbox.stub(childProcess, "spawn").returns(child);
    const error = Object.assign(new Error("Executable is missing"), { code: "ENOENT" });
    const pending = openApplication(executablePath);
    child.emit("error", error);

    await assert.rejects(pending, error);
    assert.isFalse(child.unref.called);
    assert.strictEqual(child.listenerCount("spawn"), 0);
    assert.strictEqual(child.listenerCount("error"), 0);
  });

  it("turns a synchronous spawn failure into a rejected promise", async () => {
    const error = Object.assign(new Error("Spawn failed"), { code: "EINVAL" });
    sandbox.stub(childProcess, "spawn").throws(error);

    const pending = openApplication(executablePath);

    assert.isTrue(pending instanceof Promise);
    await assert.rejects(pending, error);
    assert.isFalse(child.unref.called);
  });

  it("rejects relative paths, invalid arguments, and unsupported spawn controls before spawning", async () => {
    const spawn = sandbox.stub(childProcess, "spawn").returns(child);
    for (const args of [
      ["application.exe"],
      [""],
      [null],
      [executablePath + "\0"],
      [executablePath, "file.gra"],
      [executablePath, [123]],
      [executablePath, new Array(1)],
      [executablePath, ["file\0.gra"]],
      [executablePath, [], null],
      [executablePath, [], []],
      [executablePath, [], { cwd: "relative" }],
      [executablePath, [], { cwd: null }],
      [executablePath, [], { cwd: cwd + "\0" }],
      [executablePath, [], { shell: true }],
      [executablePath, [], { windowsVerbatimArguments: true }],
      [executablePath, [], { detached: false }],
    ]) {
      await assert.rejects(openApplication(...args), TypeError);
    }
    assert.isFalse(spawn.called);
  });

  it("reports ENOENT for an executable that really does not exist", async () => {
    const missing = path.join(os.tmpdir(), `lumine-missing-application-${process.pid}`, "app");

    await assert.rejects(openApplication(missing), { code: "ENOENT" });
  });

  it("preserves spaces, quotes, shell metacharacters, and cwd in a real child process", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lumine application launch "));
    const script = path.join(directory, "argv probe.js");
    const output = path.join(directory, "result.json");
    const args = ["a file & more.gra", 'literal "quotes"', "%PATH%", "a|b", ""];
    fs.writeFileSync(
      script,
      "require('fs').writeFileSync(process.argv[2], JSON.stringify({argv: process.argv.slice(3), cwd: process.cwd()}));",
    );
    const originalRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    let pid;

    try {
      // The test runner uses Electron; its executable is also a portable Node
      // probe when this environment key is set. The child inherits its snapshot.
      process.env.ELECTRON_RUN_AS_NODE = "1";
      try {
        pid = await openApplication(process.execPath, [script, output, ...args], {
          cwd: directory,
        });
      } finally {
        if (originalRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
        else process.env.ELECTRON_RUN_AS_NODE = originalRunAsNode;
      }
      assert.isTrue(Number.isInteger(pid) && pid > 0);

      const deadline = Date.now() + 5000;
      while (!fs.existsSync(output) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), { argv: args, cwd: directory });
    } finally {
      if (pid) {
        try {
          process.kill(pid);
        } catch (error) {
          assert.strictEqual(error.code, "ESRCH");
        }
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
