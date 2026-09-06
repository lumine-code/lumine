const fs = require("@lumine-code/fs-plus");
const path = require("path");
const temp = require("@lumine-code/temp").track();
const {
  discoverRepositoryDescriptor,
  discoverRepositoryDescriptorAsync,
  discoverGitDirectory,
  inspectRepositoryDescriptorAsync,
  assertRepositoryDescriptorAvailableAsync,
} = require("../src/git-repository-descriptor");

// Pin repository discovery and working-directory computation against the real
// filesystem so identity and path routing cannot silently drift.
describe("git repository descriptor", () => {
  const fixturePath = (...segments) => path.join(__dirname, "fixtures", "git", ...segments);
  const real = (p) => fs.realpathSync.native(p);
  const canonical = (p) => real(p).replace(/\\/g, "/");

  function copyFixture(name) {
    const dir = temp.mkdirSync(`descriptor-${name}-`);
    fs.copySync(fixturePath(name), dir);
    fs.renameSync(path.join(dir, "git.git"), path.join(dir, ".git"));
    return dir;
  }

  function copyGitDirectory(destination) {
    fs.copySync(fixturePath("working-dir", "git.git"), destination);
  }

  function createGitfileRepository() {
    const root = temp.mkdirSync("descriptor-gitfile-");
    const workingDirectory = path.join(root, "worktree");
    const gitDirectory = path.join(root, "metadata.git");
    fs.mkdirSync(workingDirectory);
    copyGitDirectory(gitDirectory);
    fs.writeFileSync(
      path.join(workingDirectory, ".git"),
      `gitdir: ${path.relative(workingDirectory, gitDirectory)}\n`,
    );
    return { root, workingDirectory, gitDirectory };
  }

  it("discovers the git directory and working directory for a working tree", () => {
    const workingDir = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(workingDir);

    expect(real(descriptor.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(descriptor.getPath())).toBe(real(path.join(workingDir, ".git")));
    expect(descriptor.getWorktreeGitMarker().kind).toBe("directory");
    expect(descriptor.getWorktreeGitMarker().path).toBe(canonical(path.join(workingDir, ".git")));
    expect(descriptor.caseInsensitiveFs).toBe(fs.isCaseInsensitive());
  });

  it("matches synchronous descriptor semantics through asynchronous discovery", async () => {
    const workingDir = copyFixture("working-dir");
    const synchronous = discoverRepositoryDescriptor(workingDir);
    const asynchronous = await discoverRepositoryDescriptorAsync(workingDir);

    expect(asynchronous.getPath()).toBe(synchronous.getPath());
    expect(asynchronous.getWorkingDirectory()).toBe(synchronous.getWorkingDirectory());
    expect(asynchronous.openedWorkingDirectory).toBe(synchronous.openedWorkingDirectory);
    expect(asynchronous.caseInsensitiveFs).toBe(synchronous.caseInsensitiveFs);
  });

  it("does not fall back to synchronous realpath calls during asynchronous discovery", async () => {
    const workingDir = copyFixture("working-dir");
    const realpathSync = spyOn(fs.realpathSync, "native").and.callThrough();

    const descriptor = await discoverRepositoryDescriptorAsync(
      path.join(workingDir, "missing", "file.txt"),
    );

    expect(descriptor).not.toBeNull();
    expect(realpathSync).not.toHaveBeenCalled();
  });

  it("discovers the repository from a nested path", () => {
    const workingDir = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(path.join(workingDir, "a.txt"));

    expect(real(descriptor.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(descriptor.getPath())).toBe(real(path.join(workingDir, ".git")));
  });

  it("discovers sync and async from a missing nested path", async () => {
    const workingDir = copyFixture("working-dir");
    const missingPath = path.join(workingDir, "missing", "b#", "file#hash.md");

    const synchronous = discoverRepositoryDescriptor(missingPath);
    const asynchronous = await discoverRepositoryDescriptorAsync(missingPath);

    expect(real(synchronous.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(asynchronous.getWorkingDirectory())).toBe(real(workingDir));
    expect(real(synchronous.getPath())).toBe(real(path.join(workingDir, ".git")));
    expect(asynchronous.getPath()).toBe(synchronous.getPath());
  });

  it("retains a symlink alias for a missing descendant", async () => {
    const workingDir = copyFixture("working-dir");
    const aliasRoot = temp.mkdirSync("descriptor-alias-");
    const alias = path.join(aliasRoot, "repo-link");
    fs.symlinkSync(workingDir, alias, process.platform === "win32" ? "junction" : "dir");
    const missingPath = path.join(alias, "missing", "file.txt");

    const synchronous = discoverRepositoryDescriptor(missingPath);
    const asynchronous = await discoverRepositoryDescriptorAsync(missingPath);

    expect(path.resolve(synchronous.openedWorkingDirectory)).toBe(path.resolve(alias));
    expect(path.resolve(asynchronous.openedWorkingDirectory)).toBe(path.resolve(alias));
    expect(
      asynchronous
        .getGitDirectoryAliases()
        .some((gitDirectory) => path.resolve(gitDirectory) === path.resolve(alias, ".git")),
    ).toBe(true);
  });

  it("walks up into a bare-style git directory", () => {
    const descriptor = discoverRepositoryDescriptor(fixturePath("master.git", "objects"));

    expect(real(descriptor.getPath())).toBe(real(fixturePath("master.git")));
    // master.git declares an explicit core.worktree pointing at its parent.
    expect(real(descriptor.getWorkingDirectory())).toBe(real(fixturePath()));
    expect(descriptor.worktreeGitMarker).toBeNull();
  });

  it("rejects a direct non-bare Git directory with no worktree relationship", async () => {
    const gitDirectory = path.join(temp.mkdirSync("descriptor-unbound-gitdir-"), "metadata.git");
    copyGitDirectory(gitDirectory);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
    );

    expect(discoverRepositoryDescriptor(path.join(gitDirectory, "objects"))).toBeNull();
    expect(await discoverRepositoryDescriptorAsync(path.join(gitDirectory, "objects"))).toBeNull();
  });

  it("uses the discovered gitfile worktree for --separate-git-dir repositories", async () => {
    const { workingDirectory, gitDirectory } = createGitfileRepository();
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = "../old location"\n',
    );

    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);

    expect(descriptor.getPath().replace(/\\/g, "/")).toBe(canonical(gitDirectory));
    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect(descriptor.worktreeGitMarker).toEqual({
      path: canonical(path.join(workingDirectory, ".git")),
      kind: "gitfile",
    });
    expect(fs.existsSync(path.join(gitDirectory, "gitdir"))).toBe(false);
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("validates linked worktrees without requiring a gitdir backlink", async () => {
    const root = temp.mkdirSync("descriptor-linked-worktree-");
    const commonDirectory = path.join(root, "common.git");
    const workingDirectory = path.join(root, "linked");
    copyGitDirectory(commonDirectory);
    fs.mkdirSync(workingDirectory);
    const gitDirectory = path.join(commonDirectory, "worktrees", "linked");
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
    fs.writeFileSync(
      path.join(workingDirectory, ".git"),
      `gitdir: ${path.relative(workingDirectory, gitDirectory)}\n`,
    );

    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const inspection = await inspectRepositoryDescriptorAsync(descriptor);

    expect(fs.existsSync(path.join(gitDirectory, "gitdir"))).toBe(false);
    expect(descriptor.worktreeGitMarker.kind).toBe("gitfile");
    expect(inspection.available).toBe(true);
    expect(inspection.descriptor.gitDirectory).toBe(canonical(gitDirectory));
  });

  it("retains a linked worktree marker when discovery starts in its Git directory", async () => {
    const root = temp.mkdirSync("descriptor-linked-backlink-");
    const commonDirectory = path.join(root, "common.git");
    const workingDirectory = path.join(root, "linked");
    copyGitDirectory(commonDirectory);
    fs.mkdirSync(workingDirectory);
    const gitDirectory = path.join(commonDirectory, "worktrees", "linked");
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
    const markerPath = path.join(workingDirectory, ".git");
    fs.writeFileSync(markerPath, `gitdir: ${gitDirectory}\n`);
    fs.writeFileSync(path.join(gitDirectory, "gitdir"), `${markerPath}\n`);

    const descriptor = await discoverRepositoryDescriptorAsync(path.join(gitDirectory, "HEAD"));

    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect(descriptor.worktreeGitMarker).toEqual({
      path: canonical(markerPath),
      kind: "gitfile",
    });
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);

    fs.unlinkSync(path.join(gitDirectory, "gitdir"));
    expect(await discoverRepositoryDescriptorAsync(gitDirectory)).toBeNull();
  });

  it("retains the gitfile marker for a submodule", async () => {
    const root = temp.mkdirSync("descriptor-submodule-");
    fs.copySync(fixturePath("repo-with-submodules"), root);
    fs.renameSync(path.join(root, "git.git"), path.join(root, ".git"));
    fs.renameSync(path.join(root, "jstips", "git.git"), path.join(root, "jstips", ".git"));

    const descriptor = await discoverRepositoryDescriptorAsync(path.join(root, "jstips"));

    expect(descriptor.worktreeGitMarker.kind).toBe("gitfile");
    expect(descriptor.getWorkingDirectory()).toBe(canonical(path.join(root, "jstips")));
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("normalizes and freezes an available host descriptor", async () => {
    const workingDirectory = copyFixture("working-dir");
    const descriptor = discoverRepositoryDescriptor(workingDirectory);

    const inspection = await inspectRepositoryDescriptorAsync({
      gitDirectory: descriptor.getPath(),
      workingDirectory: descriptor.getWorkingDirectory(),
      worktreeGitMarker: descriptor.worktreeGitMarker,
      gitDirectoryIdentity: descriptor.getGitDirectoryIdentity(),
      workingDirectoryIdentity: descriptor.getWorkingDirectoryIdentity(),
      commonDirectory: descriptor.getCommonDirectory(),
      commonDirectoryIdentity: descriptor.getCommonDirectoryIdentity(),
    });
    const identity = (candidate) => {
      const stats = fs.statSync(candidate, { bigint: true });
      return { device: String(stats.dev), inode: String(stats.ino) };
    };

    expect(inspection).toEqual({
      available: true,
      descriptor: {
        gitDirectory: descriptor.getPath().replace(/\\/g, "/"),
        workingDirectory: descriptor.getWorkingDirectory(),
        worktreeGitMarker: descriptor.worktreeGitMarker,
        gitDirectoryIdentity: identity(descriptor.getPath()),
        workingDirectoryIdentity: identity(descriptor.getWorkingDirectory()),
        commonDirectory: descriptor.getPath().replace(/\\/g, "/"),
        commonDirectoryIdentity: identity(descriptor.getPath()),
      },
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.descriptor)).toBe(true);
    expect(Object.isFrozen(inspection.descriptor.worktreeGitMarker)).toBe(true);
  });

  it("reports a missing, malformed, and retargeted gitfile marker", async () => {
    const { workingDirectory, gitDirectory } = createGitfileRepository();
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const markerPath = path.join(workingDirectory, ".git");

    fs.unlinkSync(markerPath);
    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "worktree-marker-missing",
    });

    fs.writeFileSync(markerPath, "not a gitfile\n");
    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "worktree-marker-invalid",
    });

    fs.unlinkSync(markerPath);
    fs.mkdirSync(markerPath);
    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "worktree-marker-wrong-type",
    });

    fs.rmdirSync(markerPath);
    const otherGitDirectory = path.join(path.dirname(gitDirectory), "other.git");
    copyGitDirectory(otherGitDirectory);
    fs.writeFileSync(markerPath, `gitdir: ${path.relative(workingDirectory, otherGitDirectory)}\n`);
    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "worktree-marker-mismatch",
    });
  });

  it("uses stable reasons for missing and wrong-type repository directories", async () => {
    {
      const { workingDirectory } = createGitfileRepository();
      const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
      fs.removeSync(workingDirectory);
      expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
        available: false,
        reason: "working-directory-missing",
      });
    }
    {
      const { workingDirectory } = createGitfileRepository();
      const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
      fs.removeSync(workingDirectory);
      fs.writeFileSync(workingDirectory, "not a directory");
      expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
        available: false,
        reason: "working-directory-not-directory",
      });
    }
    {
      const { workingDirectory, gitDirectory } = createGitfileRepository();
      const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
      fs.removeSync(gitDirectory);
      expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
        available: false,
        reason: "git-directory-missing",
      });
    }
    {
      const { workingDirectory, gitDirectory } = createGitfileRepository();
      const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
      fs.removeSync(gitDirectory);
      fs.writeFileSync(gitDirectory, "not a directory");
      expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
        available: false,
        reason: "git-directory-not-directory",
      });
    }
    {
      const { workingDirectory, gitDirectory, root } = createGitfileRepository();
      const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
      const commonPath = path.join(root, "common-file");
      fs.writeFileSync(commonPath, "not a directory");
      fs.writeFileSync(path.join(gitDirectory, "commondir"), "../common-file\n");
      expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
        available: false,
        reason: "common-directory-not-directory",
      });
    }
  });

  it("compares a directory marker target by filesystem identity", async () => {
    const root = temp.mkdirSync("descriptor-directory-marker-");
    const workingDirectory = path.join(root, "worktree");
    const originalGitDirectory = path.join(root, "original.git");
    const replacementGitDirectory = path.join(root, "replacement.git");
    fs.mkdirSync(workingDirectory);
    copyGitDirectory(originalGitDirectory);
    copyGitDirectory(replacementGitDirectory);
    const markerPath = path.join(workingDirectory, ".git");
    fs.symlinkSync(
      originalGitDirectory,
      markerPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);

    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);

    fs.unlinkSync(markerPath);
    fs.symlinkSync(
      replacementGitDirectory,
      markerPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "worktree-marker-mismatch",
    });
  });

  it("does not retarget a descriptor through a replacement worktree junction", async () => {
    const root = temp.mkdirSync("descriptor-retargeted-worktree-");
    const workingDirectory = path.join(root, "original");
    const movedDirectory = path.join(root, "moved");
    fs.copySync(fixturePath("working-dir"), workingDirectory);
    fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);

    fs.renameSync(workingDirectory, movedDirectory);
    fs.symlinkSync(
      movedDirectory,
      workingDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "working-directory-mismatch",
    });
  });

  it("rejects a different Git directory created at the same path", async () => {
    const workingDirectory = copyFixture("working-dir");
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const gitDirectory = path.join(workingDirectory, ".git");

    fs.removeSync(gitDirectory);
    copyGitDirectory(gitDirectory);

    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "git-directory-mismatch",
    });
  });

  it("detects a Git directory replaced during descriptor inspection", async () => {
    const workingDirectory = copyFixture("working-dir");
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const gitDirectory = path.join(workingDirectory, ".git");
    const replacement = path.join(workingDirectory, "replacement.git");
    copyGitDirectory(replacement);
    const realpath = fs.promises.realpath.bind(fs.promises);
    let replaced = false;
    spyOn(fs.promises, "realpath").and.callFake((candidate, ...args) => {
      if (!replaced && path.basename(candidate) === ".git") {
        replaced = true;
        fs.removeSync(gitDirectory);
        fs.renameSync(replacement, gitDirectory);
      }
      return realpath(candidate, ...args);
    });

    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "git-directory-mismatch",
    });
    expect(replaced).toBe(true);
  });

  it("validates bare and markerless core.worktree repositories", async () => {
    const root = temp.mkdirSync("descriptor-markerless-");
    const bareGitDirectory = path.join(root, "bare.git");
    copyGitDirectory(bareGitDirectory);
    fs.writeFileSync(
      path.join(bareGitDirectory, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
    );
    const bare = await discoverRepositoryDescriptorAsync(path.join(bareGitDirectory, "objects"));
    expect(bare.getWorkingDirectory()).toBeNull();
    expect(bare.worktreeGitMarker).toBeNull();
    expect((await inspectRepositoryDescriptorAsync(bare)).available).toBe(true);

    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "configured worktree");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${JSON.stringify(
        workingDirectory,
      )}\n`,
    );
    const configured = await discoverRepositoryDescriptorAsync(path.join(gitDirectory, "objects"));
    expect(configured.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect(configured.worktreeGitMarker).toBeNull();
    expect((await inspectRepositoryDescriptorAsync(configured)).available).toBe(true);

    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = "../somewhere else"\n',
    );
    expect(await inspectRepositoryDescriptorAsync(configured)).toEqual({
      available: false,
      reason: "core-worktree-mismatch",
    });
  });

  it("reads bare booleans and core.worktree from per-worktree config", async () => {
    const root = temp.mkdirSync("descriptor-worktree-config-");
    const bareGitDirectory = path.join(root, "bare.git");
    copyGitDirectory(bareGitDirectory);
    fs.writeFileSync(path.join(bareGitDirectory, "config"), "[core]\n\tbare\n");
    const bare = await discoverRepositoryDescriptorAsync(bareGitDirectory);
    expect(bare.getWorkingDirectory()).toBeNull();
    expect((await inspectRepositoryDescriptorAsync(bare)).available).toBe(true);

    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "configured worktree");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      "[core]\n\tbare = false\n[extensions]\n\tworktreeConfig\n",
    );
    fs.writeFileSync(
      path.join(gitDirectory, "config.worktree"),
      `[core]\n\tworktree = ${JSON.stringify(workingDirectory)}\n`,
    );
    const configured = await discoverRepositoryDescriptorAsync(gitDirectory);
    expect(configured.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect((await inspectRepositoryDescriptorAsync(configured)).available).toBe(true);
  });

  it("parses exact config sections, quoted comments, and empty booleans", async () => {
    const root = temp.mkdirSync("descriptor-config-syntax-");
    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "configured # worktree");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[core]\n\tbare =\n\trepositoryformatversion = 0 # a comment ending in ${"\\"}\n\tworktree = ${JSON.stringify(
        workingDirectory,
      )} # keep the quoted hash\n[core "ignored"]\n\tworktree = ../wrong\n[extensions]\n\tworktreeConfig = false\n`,
    );

    const descriptor = await discoverRepositoryDescriptorAsync(gitDirectory);

    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("treats malformed repository config as an operational error", async () => {
    const root = temp.mkdirSync("descriptor-invalid-config-");
    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "worktree");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[core]\n\tbare = false\n\tworktree = ${JSON.stringify(workingDirectory)}\n`,
    );
    const descriptor = await discoverRepositoryDescriptorAsync(gitDirectory);

    for (const contents of [
      '[core]\n\tworktree = "unterminated\n',
      "[core\n\tworktree = ../worktree\n",
      "[core]\n\tworktree = ../worktree\n\tthis is not valid\n",
      "[core]\n\tworktree = C:\\invalid\n",
    ]) {
      fs.writeFileSync(path.join(gitDirectory, "config"), contents);
      let error;
      try {
        await inspectRepositoryDescriptorAsync(descriptor);
      } catch (caught) {
        error = caught;
      }
      expect(error.code).toBe("ERR_GIT_CONFIG_INVALID");
      expect(error.code).not.toBe("ERR_GIT_REPOSITORY_UNAVAILABLE");
    }
  });

  it("returns null when a markerless core.worktree directory is missing", async () => {
    const root = temp.mkdirSync("descriptor-missing-core-worktree-");
    const gitDirectory = path.join(root, "configured.git");
    const missingWorkingDirectory = path.join(root, "missing-worktree");
    copyGitDirectory(gitDirectory);
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[core]\n\tbare = false\n\tworktree = ${JSON.stringify(missingWorkingDirectory)}\n`,
    );

    expect(discoverRepositoryDescriptor(gitDirectory)).toBeNull();
    expect(await discoverRepositoryDescriptorAsync(gitDirectory)).toBeNull();
  });

  it("resolves markerless core.worktree through an included repository config", async () => {
    const root = temp.mkdirSync("descriptor-included-core-worktree-");
    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "included-worktree");
    const includedConfig = path.join(root, "worktree.config");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(
      includedConfig,
      `[core]\n\tbare = false\n\tworktree = ${JSON.stringify(workingDirectory)}\n`,
    );
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[include]\n\tpath = ${JSON.stringify(includedConfig)}\n`,
    );

    const descriptor = await discoverRepositoryDescriptorAsync(gitDirectory);

    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("resolves markerless core.worktree through a matching gitdir includeIf", async () => {
    const root = temp.mkdirSync("descriptor-conditional-core-worktree-");
    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "conditional-worktree");
    const includedConfig = path.join(root, "worktree.config");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(
      includedConfig,
      `[core]\n\tbare = false\n\tworktree = ${JSON.stringify(workingDirectory)}\n`,
    );
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[includeIf "gitdir:**/configured.git"]\n\tpath = ${JSON.stringify(includedConfig)}\n`,
    );

    const descriptor = await discoverRepositoryDescriptorAsync(gitDirectory);

    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("parses a continued core.worktree value", async () => {
    const root = temp.mkdirSync("descriptor-continued-core-worktree-");
    const gitDirectory = path.join(root, "configured.git");
    const workingDirectory = path.join(root, "continued-worktree");
    copyGitDirectory(gitDirectory);
    fs.mkdirSync(workingDirectory);
    const configuredPath = workingDirectory.replace(/\\/g, "/");
    const splitAt = configuredPath.length - "worktree".length;
    const continuedPath = `${configuredPath.slice(0, splitAt)}\\\n${configuredPath.slice(splitAt)}`;
    fs.writeFileSync(
      path.join(gitDirectory, "config"),
      `[core]\n\tbare = false\n\tworktree = ${continuedPath}\n`,
    );

    const descriptor = await discoverRepositoryDescriptorAsync(gitDirectory);

    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("accepts a linked worktree with a nonstandard commondir layout", async () => {
    const root = temp.mkdirSync("descriptor-arbitrary-common-");
    const commonDirectory = path.join(root, "object-store.git");
    const workingDirectory = path.join(root, "linked");
    const gitDirectory = path.join(root, "metadata", "linked.git");
    copyGitDirectory(commonDirectory);
    fs.mkdirSync(workingDirectory);
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(
      path.join(gitDirectory, "commondir"),
      `${path.relative(gitDirectory, commonDirectory)}\n`,
    );
    fs.writeFileSync(path.join(workingDirectory, ".git"), `gitdir: ${gitDirectory}\n`);

    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const inspection = await inspectRepositoryDescriptorAsync(descriptor);

    expect(descriptor.getCommonDirectory()).toBe(canonical(commonDirectory));
    expect(inspection.available).toBe(true);
    expect(inspection.descriptor.commonDirectory).toBe(canonical(commonDirectory));
  });

  it("discovers markerless core.worktree from per-worktree config with commondir", async () => {
    const root = temp.mkdirSync("descriptor-markerless-common-");
    const commonDirectory = path.join(root, "common.git");
    const gitDirectory = path.join(root, "metadata", "linked.git");
    const workingDirectory = path.join(root, "linked-worktree");
    copyGitDirectory(commonDirectory);
    fs.writeFileSync(
      path.join(commonDirectory, "config"),
      "[core]\n\tbare = false\n[extensions]\n\tworktreeConfig\n",
    );
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.mkdirSync(workingDirectory);
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(
      path.join(gitDirectory, "commondir"),
      `${path.relative(gitDirectory, commonDirectory)}\n`,
    );
    fs.writeFileSync(
      path.join(gitDirectory, "config.worktree"),
      `[core]\n\tworktree = ${JSON.stringify(workingDirectory)}\n`,
    );

    const descriptor = await discoverRepositoryDescriptorAsync(gitDirectory);

    expect(descriptor.getWorkingDirectory()).toBe(canonical(workingDirectory));
    expect(descriptor.getWorktreeGitMarker()).toBeNull();
    expect((await inspectRepositoryDescriptorAsync(descriptor)).available).toBe(true);
  });

  it("checks the linked worktree common directory", async () => {
    const root = temp.mkdirSync("descriptor-missing-common-");
    const commonDirectory = path.join(root, "common.git");
    const workingDirectory = path.join(root, "linked");
    copyGitDirectory(commonDirectory);
    fs.mkdirSync(workingDirectory);
    const gitDirectory = path.join(commonDirectory, "worktrees", "linked");
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
    fs.writeFileSync(path.join(workingDirectory, ".git"), `gitdir: ${gitDirectory}\n`);
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);

    fs.writeFileSync(path.join(gitDirectory, "commondir"), "../../../missing.git\n");

    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "common-directory-missing",
    });
  });

  it("rejects a linked worktree whose commondir is retargeted", async () => {
    const root = temp.mkdirSync("descriptor-retargeted-common-");
    const commonDirectory = path.join(root, "common.git");
    const otherCommonDirectory = path.join(root, "other.git");
    const workingDirectory = path.join(root, "linked");
    copyGitDirectory(commonDirectory);
    copyGitDirectory(otherCommonDirectory);
    fs.mkdirSync(workingDirectory);
    const gitDirectory = path.join(commonDirectory, "worktrees", "linked");
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    fs.writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
    fs.writeFileSync(path.join(workingDirectory, ".git"), `gitdir: ${gitDirectory}\n`);
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);

    fs.writeFileSync(path.join(gitDirectory, "commondir"), `${otherCommonDirectory}\n`);

    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "common-directory-mismatch",
    });
  });

  it("detects commondir retargeting during descriptor inspection", async () => {
    const root = temp.mkdirSync("descriptor-racing-common-");
    const commonDirectory = path.join(root, "common.git");
    const otherCommonDirectory = path.join(root, "other.git");
    const workingDirectory = path.join(root, "linked");
    copyGitDirectory(commonDirectory);
    copyGitDirectory(otherCommonDirectory);
    fs.mkdirSync(workingDirectory);
    const gitDirectory = path.join(commonDirectory, "worktrees", "linked");
    fs.mkdirSync(gitDirectory, { recursive: true });
    fs.writeFileSync(path.join(gitDirectory, "HEAD"), "ref: refs/heads/master\n");
    const commonPointer = path.join(gitDirectory, "commondir");
    fs.writeFileSync(commonPointer, "../..\n");
    fs.writeFileSync(path.join(workingDirectory, ".git"), `gitdir: ${gitDirectory}\n`);
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const stat = fs.promises.stat.bind(fs.promises);
    let pointerChecks = 0;
    spyOn(fs.promises, "stat").and.callFake((candidate, ...args) => {
      if (path.basename(candidate) === "commondir" && ++pointerChecks === 2) {
        fs.writeFileSync(commonPointer, `${otherCommonDirectory}\n`);
      }
      return stat(candidate, ...args);
    });

    expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
      available: false,
      reason: "common-directory-mismatch",
    });
  });

  if (process.platform !== "win32") {
    it("classifies a looping worktree marker as unavailable", async () => {
      const { workingDirectory } = createGitfileRepository();
      const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
      const markerPath = path.join(workingDirectory, ".git");
      fs.unlinkSync(markerPath);
      fs.symlinkSync(".git", markerPath);

      expect(await inspectRepositoryDescriptorAsync(descriptor)).toEqual({
        available: false,
        reason: "worktree-marker-invalid",
      });
    });
  }

  it("throws a repository-unavailable error with stable identity details", async () => {
    const { workingDirectory } = createGitfileRepository();
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    fs.unlinkSync(path.join(workingDirectory, ".git"));

    let error;
    try {
      await assertRepositoryDescriptorAvailableAsync(descriptor, { operation: "status" });
    } catch (caught) {
      error = caught;
    }

    expect(error.code).toBe("ERR_GIT_REPOSITORY_UNAVAILABLE");
    expect(error.operation).toBe("status");
    expect(error.reason).toBe("worktree-marker-missing");
    expect(error.gitDirectory).toBe(descriptor.getPath().replace(/\\/g, "/"));
    expect(error.workingDirectory).toBe(descriptor.getWorkingDirectory());
  });

  it("rejects an incomplete legacy host descriptor", async () => {
    const workingDirectory = copyFixture("working-dir");
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);

    await expectAsync(
      assertRepositoryDescriptorAvailableAsync({
        gitDirectory: descriptor.getPath(),
        workingDirectory: descriptor.getWorkingDirectory(),
        worktreeGitMarker: descriptor.getWorktreeGitMarker(),
      }),
    ).toBeRejectedWith(
      jasmine.objectContaining({
        code: "ERR_GIT_REPOSITORY_DESCRIPTOR",
      }),
    );
  });

  it("stops at a malformed or dangling nested .git marker instead of using its parent", async () => {
    const outerWorkingDirectory = copyFixture("working-dir");
    const nestedDirectory = path.join(outerWorkingDirectory, "nested");
    fs.mkdirSync(nestedDirectory);
    const markerPath = path.join(nestedDirectory, ".git");

    for (const contents of [
      "broken\n",
      "gitdir: ../missing.git\n",
      "junk\ngitdir: ../.git\n",
      "gitdir:\n../.git\n",
    ]) {
      fs.writeFileSync(markerPath, contents);
      expect(discoverRepositoryDescriptor(nestedDirectory)).toBeNull();
      expect(await discoverRepositoryDescriptorAsync(nestedDirectory)).toBeNull();
    }

    fs.unlinkSync(markerPath);
    fs.symlinkSync(
      path.join(nestedDirectory, "missing.git"),
      markerPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(discoverRepositoryDescriptor(nestedDirectory)).toBeNull();
    expect(await discoverRepositoryDescriptorAsync(nestedDirectory)).toBeNull();
  });

  it("returns null outside a repository", () => {
    const dir = temp.mkdirSync("descriptor-no-repo-");
    expect(discoverRepositoryDescriptor(dir)).toBeNull();
    expect(discoverGitDirectory(path.join(dir, "missing.txt"))).toBeNull();
  });

  it("does not fall through to a parent repository when a nested marker is inaccessible", async () => {
    const workingDirectory = copyFixture("working-dir");
    const nestedDirectory = path.join(workingDirectory, "nested");
    const markerPath = path.join(nestedDirectory, ".git");
    fs.mkdirSync(nestedDirectory);
    const permissionError = Object.assign(new Error("marker access denied"), { code: "EACCES" });
    const lstat = fs.promises.lstat.bind(fs.promises);
    spyOn(fs.promises, "lstat").and.callFake((candidate, ...args) =>
      path.resolve(candidate) === path.resolve(markerPath)
        ? Promise.reject(permissionError)
        : lstat(candidate, ...args),
    );

    await expectAsync(discoverRepositoryDescriptorAsync(nestedDirectory)).toBeRejectedWith(
      permissionError,
    );
  });

  it("propagates inspection permission errors without classifying them as unavailable", async () => {
    const workingDirectory = copyFixture("working-dir");
    const descriptor = await discoverRepositoryDescriptorAsync(workingDirectory);
    const permissionError = Object.assign(new Error("Git directory access denied"), {
      code: "EACCES",
    });
    const stat = fs.promises.stat.bind(fs.promises);
    spyOn(fs.promises, "stat").and.callFake((candidate, ...args) =>
      path.resolve(candidate) === path.resolve(descriptor.getPath())
        ? Promise.reject(permissionError)
        : stat(candidate, ...args),
    );

    await expectAsync(assertRepositoryDescriptorAvailableAsync(descriptor)).toBeRejectedWith(
      permissionError,
    );
  });
});
