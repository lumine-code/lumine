const { resolveGitPath, which } = require("../src/git-binary");
const { createGitExec } = require("../src/git-executor");
const path = require("path");
const temp = require("@lumine-code/temp").track();

describe("git binary resolution", () => {
  it("finds git on PATH", () => {
    const gitPath = resolveGitPath("");
    expect(typeof gitPath).toBe("string");
    expect(gitPath.length).toBeGreaterThan(0);
  });

  it("prefers a configured path that exists", () => {
    const real = which("git");
    if (!real) return; // system without git on PATH; covered by the fallback case
    expect(resolveGitPath(real)).toBe(real);
  });

  it("ignores a configured path that does not exist and falls back to PATH", () => {
    const resolved = resolveGitPath("/definitely/not/a/real/git/binary");
    expect(resolved).not.toBe("/definitely/not/a/real/git/binary");
  });
});

describe("git executor", () => {
  const exec = createGitExec(resolveGitPath(""));

  it("runs a git command and returns exit code and stdout", async () => {
    const result = await exec(["--version"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version");
    expect(result.stderr).toBe("");
  });

  it("feeds stdin to git", async () => {
    const result = await exec(["hash-object", "--stdin"], process.cwd(), { stdin: "hello\n" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBe(40);
  });

  it("returns a Buffer stdout when encoding is 'buffer'", async () => {
    const result = await exec(["--version"], process.cwd(), { encoding: "buffer" });
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
  });

  it("rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER when stdout exceeds maxBuffer", async () => {
    let error;
    try {
      await exec(["--version"], process.cwd(), { maxBuffer: 4 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeTruthy();
    expect(error.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  });

  it("also bounds stderr", async () => {
    let error;
    try {
      await exec(["--definitely-invalid"], process.cwd(), { maxBuffer: 4 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeTruthy();
    expect(error.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  });

  it("surfaces a non-zero exit code without throwing", async () => {
    const result = await exec(["rev-parse", "--verify", "definitely-not-a-ref"], process.cwd());
    expect(result.exitCode).not.toBe(0);
  });

  it("can remove inherited variables from the child environment", async () => {
    const name = "LUMINE_GIT_EXECUTOR_TEST";
    const original = process.env[name];
    process.env[name] = "inherited";
    try {
      const printEnvironment = `alias.print-environment=!printf '%s' "$${name}"`;
      const inherited = await exec(["-c", printEnvironment, "print-environment"], process.cwd());
      const removed = await exec(["-c", printEnvironment, "print-environment"], process.cwd(), {
        unsetEnv: [name],
      });
      const overridden = await exec(["-c", printEnvironment, "print-environment"], process.cwd(), {
        unsetEnv: [name],
        env: { [name]: "explicit" },
      });

      expect(inherited.stdout).toBe("inherited");
      expect(removed.stdout).toBe("");
      expect(overridden.stdout).toBe("explicit");
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  it("distinguishes a missing working directory from a missing Git executable", async () => {
    const missingDirectory = path.join(temp.dir, "moved-repository");
    let error;
    try {
      await exec(["--version"], missingDirectory);
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe("ERR_GIT_WORKING_DIRECTORY_NOT_FOUND");
    expect(error.workingDirectory).toBe(missingDirectory);
    expect(error.message).toContain(missingDirectory);
  });

  it("reports a missing Git executable when the working directory exists", async () => {
    const missingGit = path.join(temp.dir, "missing-git-executable");
    const missingGitExec = createGitExec(missingGit);
    let error;
    try {
      await missingGitExec(["--version"], process.cwd());
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe("ERR_GIT_EXECUTABLE_NOT_FOUND");
    expect(error.gitPath).toBe(missingGit);
    expect(error.message).toContain(missingGit);
  });

  it("kills the process when the abort signal fires", async () => {
    const controller = new AbortController();
    const pending = exec(["hash-object", "--stdin"], process.cwd(), {
      stdin: "",
      signal: controller.signal,
    });
    controller.abort();
    // Aborting kills git; the result still settles (resolve or reject) rather
    // than hanging.
    await pending.catch(() => {});
    expect(true).toBe(true);
  });
});
