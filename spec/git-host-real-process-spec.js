const path = require("path");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const GitHost = require("../src/git-host");

function copyRepository() {
  const workingDirectory = temp.mkdirSync("git-host-real-process-");
  fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
  fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
  return {
    gitDirectory: path.join(workingDirectory, ".git"),
    workingDirectory,
    hasSubmodules: false,
    submodulePaths: [],
  };
}

describe("git-host real process", () => {
  beforeEach(() => {
    GitHost.reset();
    GitHost.setForkModeForTesting(true);
    GitHost.setChildFactoryForTesting(null);
    GitHost.setBackendPolicyForTesting(null);
  });

  afterEach(() => {
    GitHost.reset();
    GitHost.setForkModeForTesting(null);
    GitHost.setBackendPolicyForTesting(null);
  });

  it("boots the real worker and transports CLI results, Buffers, and native errors", async () => {
    const descriptor = copyRepository();
    const host = GitHost.instance();

    const cli = await host.request("exec", {
      workingDirectory: descriptor.workingDirectory,
      args: ["rev-parse", "--is-inside-work-tree"],
      options: {},
      raw: false,
    });
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.trim()).toBe("true");

    const [object] = await host.request("readObjects", {
      descriptor,
      requests: [{ revision: "HEAD", path: "a.txt" }],
    });
    expect(Buffer.isBuffer(object.content)).toBe(true);
    expect(object.type).toBe("blob");
    expect(host.backendStatus["git-utils"].state).toBe("ready");
    expect(host.nativeVersions.libgit2).toBe("1.9.6");

    let error;
    try {
      await host.request("diff", {
        descriptor,
        request: {
          from: { type: "commit", revision: "missing-ref" },
          to: { type: "commit", revision: "HEAD" },
          format: "structured",
        },
        maxBytes: 1024 * 1024,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_DIFF");
    expect(error.backend).toBe("git-utils");
    expect(error.backendCode).toBe("ERR_GIT_NATIVE_DIFF");
  });

  it("runs the real worker on the complete all-CLI policy without loading git-utils", async () => {
    GitHost.reset();
    GitHost.setBackendPolicyForTesting("cli");
    const descriptor = copyRepository();
    const host = GitHost.instance();

    const [object] = await host.request("readObjects", {
      descriptor,
      requests: [{ revision: "HEAD", path: "a.txt" }],
    });
    expect(Buffer.isBuffer(object.content)).toBe(true);
    expect(
      await host.request("readConfig", {
        descriptor,
        keys: ["core.repositoryformatversion"],
      }),
    ).toEqual({ "core.repositoryformatversion": "0" });
    const history = await host.request("history", {
      descriptor,
      request: { revision: "HEAD", limit: 10, skip: 0 },
    });
    expect(history).toEqual(jasmine.any(Array));
    const diff = await host.request("diff", {
      descriptor,
      request: { from: { type: "empty" }, to: { type: "index" }, format: "structured" },
      maxBytes: 1024 * 1024,
    });
    expect(diff.files.length).toBeGreaterThan(0);
    expect(
      await host.request("lineDiff", {
        descriptor,
        relativePosixPath: "a.txt",
        headOid: history[0].sha,
        text: "changed\n",
      }),
    ).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }]);
    expect(host.backendStatus["git-utils"].state).toBe("uninitialized");
    expect(host.nativeVersions).toBeNull();

    let error;
    try {
      await host.request("diff", {
        descriptor,
        request: {
          from: { type: "commit", revision: "missing-ref" },
          to: { type: "commit", revision: "HEAD" },
          format: "structured",
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_DIFF");
    expect(error.backend).toBe("cli");
    expect(error.backendCode).toBe("ERR_GIT_COMMAND_FAILED");
  });
});
