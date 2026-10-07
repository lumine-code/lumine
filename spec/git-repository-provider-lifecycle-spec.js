const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ChildProcess = require("node:child_process");
const GitRepositoryProvider = require("../src/git-repository-provider");
const { discoverRepositoryDescriptorAsync } = require("../src/git-repository-descriptor");
const repositoryPaths = require("../src/repository-paths");
const { deferred } = require("../src/file-watch-protocol");

describe("Git repository provider filesystem lifecycle", () => {
  let directory;
  let provider;
  let links;

  const canonical = (target) => fs.realpathSync.native(target).replace(/\\/g, "/");
  const git = (args) => ChildProcess.execFileSync("git", args, { encoding: "utf8" }).trim();

  function makeFilesWritable(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) makeFilesWritable(target);
      else fs.chmodSync(target, 0o666);
    }
  }

  function init(name, options = []) {
    const target = path.join(directory, name);
    git(["init", "--quiet", ...options, target]);
    return target;
  }

  function link(target, name) {
    const alias = path.join(directory, name);
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    links.add(alias);
    return alias;
  }

  async function overlappingLookups(name) {
    const target = init(name);
    const entered = deferred();
    const finish = deferred();
    const stat = fs.promises.stat.bind(fs.promises);
    let hold = true;
    spyOn(fs.promises, "stat").and.callFake(async (candidate, options) => {
      const value = await stat(candidate, options);
      if (hold && path.resolve(candidate) === path.join(target, ".git") && options?.bigint) {
        hold = false;
        entered.resolve();
        await finish.promise;
      }
      return value;
    });
    const older = provider.repositoryForPath(target);
    await entered.promise;
    let newer;
    try {
      newer = await provider.repositoryForPath(target);
    } finally {
      finish.resolve();
    }
    return { target, older: await older, newer };
  }

  beforeEach(() => {
    jasmine.useRealClock?.();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lumine-provider-")));
    provider = new GitRepositoryProvider({ isRegistered: () => false });
    links = new Set();
  });

  afterEach(() => {
    const repositories = new Set(
      [...provider.repositoriesByGitDirectory.values()].flatMap((group) => [...group]),
    );
    for (const repository of repositories) repository.destroy();
    for (const alias of [...links].reverse()) {
      try {
        fs.unlinkSync(alias);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    expect(path.dirname(path.resolve(directory))).toBe(fs.realpathSync.native(os.tmpdir()));
    makeFilesWritable(directory);
    fs.rmSync(directory, { recursive: true, force: true });
    repositoryPaths.clearRealpathCache();
  });

  it("does not discover a lexical parent through a link into an external non-repository", async () => {
    const outer = init("outer");
    const external = path.join(directory, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "file"), "outside");
    const alias = link(external, "outer/linked");
    const requested = path.join(alias, "file");
    const result = ChildProcess.spawnSync("git", ["-C", alias, "rev-parse", "--show-toplevel"]);

    expect(result.status).toBe(128);
    expect(await discoverRepositoryDescriptorAsync(requested)).toBeNull();
    expect(await provider.repositoryForPath(path.join(alias, "missing", "file"))).toBeNull();
    expect(await provider.repositoryForPath(outer)).not.toBeNull();
  });

  it("routes a symlinked directory to the repository containing its physical target", async () => {
    init("outer");
    const target = init("target");
    const nested = path.join(target, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "file"), "target");
    const alias = link(nested, "outer/linked");
    const requested = path.join(alias, "file");

    expect(canonical(git(["-C", alias, "rev-parse", "--show-toplevel"]))).toBe(canonical(target));
    expect((await discoverRepositoryDescriptorAsync(requested)).getWorkingDirectory()).toBe(
      canonical(target),
    );
  });

  it("resolves a relative gitfile against the physical worktree through an alias", async () => {
    const metadata = path.join(directory, "metadata.git");
    const target = init("worktree", ["--separate-git-dir", metadata]);
    fs.unlinkSync(path.join(target, ".git"));
    fs.writeFileSync(path.join(target, ".git"), "gitdir: ../metadata.git\n");
    const alias = link(target, "aliases/repository");
    const repository = await provider.repositoryForPath(alias);

    expect(canonical(git(["-C", alias, "rev-parse", "--absolute-git-dir"]))).toBe(
      canonical(metadata),
    );
    expect(repository.getPath().replace(/\\/g, "/")).toBe(canonical(metadata));
    expect((await discoverRepositoryDescriptorAsync(alias)).getPath().replace(/\\/g, "/")).toBe(
      canonical(metadata),
    );
    provider.commitRepositoryForPath(repository, alias);
    expect(provider.getRepositoryForPath(path.join(alias, "file"))).toBe(repository);
  });

  it("rediscovers a retargeted alias despite primed synchronous path caches", async () => {
    const first = init("first");
    const second = init("second");
    fs.writeFileSync(path.join(first, "file"), "first");
    fs.writeFileSync(path.join(second, "file"), "second");
    const alias = link(first, "alias");
    repositoryPaths.normalizePath(alias, true);
    repositoryPaths.realpathRecursive(path.join(alias, "file"));
    expect((await discoverRepositoryDescriptorAsync(alias)).getWorkingDirectory()).toBe(
      canonical(first),
    );
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias, process.platform === "win32" ? "junction" : "dir");

    expect((await discoverRepositoryDescriptorAsync(alias)).getWorkingDirectory()).toBe(
      canonical(second),
    );
  });

  it("preserves the opened alias for a bare repository", async () => {
    const target = init("bare.git", ["--bare"]);
    const alias = link(target, "bare-alias");
    const repository = await provider.repositoryForPath(path.join(alias, "objects"));
    provider.commitRepositoryForPath(repository, path.join(alias, "objects"));

    expect(repository.getWorkingDirectory()).toBeNull();
    expect(repository.getPath().replace(/\\/g, "/")).toBe(canonical(target));
    expect(provider.getRepositoryForPath(path.join(alias, "objects"))).toBe(repository);
  });

  it("releases a pending candidate after negative rediscovery of a deleted marker", async () => {
    const target = init("pending");
    const repository = await provider.repositoryForPath(target);
    fs.rmSync(path.join(target, ".git"), { recursive: true, force: true });

    expect(await provider.repositoryForPath(target)).toBeNull();
    provider.sweepUnregisteredRepositories();
    provider.commitRepositoryForPath(repository, target);
    expect(repository.isDestroyed()).toBe(true);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
    expect(Object.values(provider.pathToRepository)).toEqual([]);
  });

  it("does not let an older negative lookup destroy a newer pending initialization", async () => {
    const target = path.join(directory, "initialized-during-discovery");
    fs.mkdirSync(target);
    const entered = deferred();
    const finish = deferred();
    const stat = fs.promises.stat.bind(fs.promises);
    let hold = true;
    spyOn(fs.promises, "stat").and.callFake(async (candidate, options) => {
      if (hold && path.resolve(candidate) === path.join(directory, "HEAD")) {
        hold = false;
        entered.resolve();
        await finish.promise;
      }
      return stat(candidate, options);
    });
    const older = provider.repositoryForPath(target);
    await entered.promise;
    let current;
    try {
      git(["init", "--quiet", target]);
      current = await provider.repositoryForPath(target);
      expect(current).not.toBeNull();
    } finally {
      finish.resolve();
    }
    expect(await older).toBeNull();
    expect(current.isDestroyed()).toBe(false);
    provider.commitRepositoryForPath(current, target);
    expect(provider.getRepositoryForPath(target)).toBe(current);
  });

  it("discards an older positive result without replacing a newer pending candidate", async () => {
    const target = init("positive-result-race");
    const metadata = path.join(target, ".git");
    const entered = deferred();
    const finish = deferred();
    const stat = fs.promises.stat.bind(fs.promises);
    let hold = true;
    spyOn(fs.promises, "stat").and.callFake(async (candidate, options) => {
      const value = await stat(candidate, options);
      if (hold && path.resolve(candidate) === metadata && options?.bigint === true) {
        hold = false;
        entered.resolve();
        await finish.promise;
      }
      return value;
    });
    const older = provider.repositoryForPath(target);
    await entered.promise;
    let current;
    try {
      fs.renameSync(metadata, path.join(directory, "old-positive-metadata.git"));
      git(["init", "--quiet", target]);
      current = await provider.repositoryForPath(target);
    } finally {
      finish.resolve();
    }
    expect(await older).toBeNull();
    expect(current.isDestroyed()).toBe(false);
    provider.commitRepositoryForPath(current, target);
    expect(provider.getRepositoryForPath(target)).toBe(current);
    expect(Object.values(provider.pathToRepository)).toEqual([current]);
  });

  it("adopts the current identity without letting an older abandonment destroy its owner", async () => {
    const { target, older, newer } = await overlappingLookups("concurrent-abandonment");
    expect(older).toBe(newer);
    expect(older).not.toBeNull();
    expect(provider.abandonRepositoryForPath(older, target)).toBe(true);
    expect(newer.isDestroyed()).toBe(false);
    provider.commitRepositoryForPath(newer, target);
    expect(provider.getRepositoryForPath(target)).toBe(newer);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
    expect(provider.pendingDiscoveryRequestsByPath.size).toBe(0);
  });

  it("keeps an older accepted lookup alive when the newer overlapping lookup is abandoned", async () => {
    const { target, older, newer } = await overlappingLookups("concurrent-acceptance");
    expect(older).toBe(newer);
    expect(older).not.toBeNull();
    provider.commitRepositoryForPath(older, target);
    expect(provider.abandonRepositoryForPath(newer, target)).toBe(true);
    expect(older.isDestroyed()).toBe(false);
    expect(provider.getRepositoryForPath(target)).toBe(older);
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
    expect(provider.pendingDiscoveryRequestsByPath.size).toBe(0);
  });

  it("uses a new identity when Git is initialized again at the same path", async () => {
    const target = init("reinitialized");
    const original = await provider.repositoryForPath(target);
    provider.commitRepositoryForPath(original, target);
    fs.renameSync(path.join(target, ".git"), path.join(directory, "old-metadata.git"));
    git(["init", "--quiet", target]);
    const replacement = await provider.repositoryForPath(target);

    expect(replacement).not.toBe(original);
    expect(original.isDestroyed()).toBe(false);
    provider.commitRepositoryForPath(replacement, target);
    expect(original.isDestroyed()).toBe(true);
    expect(provider.getRepositoryForPath(target)).toBe(replacement);
  });

  it("discovers Git initialization after an earlier negative lookup", async () => {
    const target = path.join(directory, "not-yet-initialized");
    fs.mkdirSync(target);
    expect(await provider.repositoryForPath(target)).toBeNull();
    git(["init", "--quiet", target]);
    const repository = await provider.repositoryForPath(target);
    expect(repository).not.toBeNull();
    provider.commitRepositoryForPath(repository, target);
    expect(provider.getRepositoryForPath(target)).toBe(repository);
  });

  it("uses a new identity when a repository is replaced by a copy at the same path", async () => {
    const target = init("replaced-by-copy");
    const original = await provider.repositoryForPath(target);
    provider.commitRepositoryForPath(original, target);
    const moved = path.join(directory, "saved-original");
    fs.renameSync(target, moved);
    fs.cpSync(moved, target, { recursive: true });
    const replacement = await provider.repositoryForPath(target);
    expect(replacement).not.toBe(original);
    expect(replacement.getWorkingDirectoryIdentity()).not.toEqual(
      original.getWorkingDirectoryIdentity(),
    );
    provider.commitRepositoryForPath(replacement, target);
    expect(original.isDestroyed()).toBe(true);
    expect(provider.getRepositoryForPath(target)).toBe(replacement);
  });

  it("replaces the facade after a worktree move updates its gitfile relationship", async () => {
    const main = init("main");
    fs.writeFileSync(path.join(main, "file"), "committed");
    git(["-C", main, "add", "file"]);
    git([
      "-C",
      main,
      "-c",
      "user.name=Provider Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Initial",
    ]);
    const oldPath = path.join(directory, "old-worktree");
    const newPath = path.join(directory, "moved-worktree");
    git(["-C", main, "worktree", "add", "--quiet", "--detach", oldPath]);
    const original = await provider.repositoryForPath(oldPath);
    provider.commitRepositoryForPath(original, oldPath);
    git(["-C", main, "worktree", "move", oldPath, newPath]);
    const moved = await provider.repositoryForPath(newPath);

    expect(moved).not.toBe(original);
    expect(moved.getPath()).toBe(original.getPath());
    expect(original.isDestroyed()).toBe(false);
    provider.commitRepositoryForPath(moved, newPath);
    expect(original.isDestroyed()).toBe(true);
    expect(moved.getWorkingDirectory()).toBe(canonical(newPath));
  });

  it("shares concurrent candidate reads while preserving fresh final identity reads", async () => {
    const target = init("many-files");
    const files = Array.from({ length: 40 }, (_, index) => path.join(target, `file-${index}`));
    for (const file of files) fs.writeFileSync(file, "contents");
    const lstat = spyOn(fs.promises, "lstat").and.callThrough();
    const stat = spyOn(fs.promises, "stat").and.callThrough();
    const spawn = spyOn(ChildProcess, "spawn").and.callThrough();
    const repositories = await Promise.all(files.map((file) => provider.repositoryForPath(file)));
    const marker = path.join(target, ".git");
    const markerWalks = lstat.calls
      .allArgs()
      .filter(([candidate]) => path.resolve(candidate) === marker);
    const identityReads = stat.calls
      .allArgs()
      .filter(
        ([candidate, options]) => path.resolve(candidate) === marker && options?.bigint === true,
      );

    expect(new Set(repositories).size).toBe(1);
    expect(markerWalks.length).toBeLessThan(files.length / 2);
    expect(identityReads.length).toBe(files.length * 2);
    expect(spawn).not.toHaveBeenCalled();
    for (let index = 0; index < files.length; index++) {
      provider.commitRepositoryForPath(repositories[index], files[index]);
    }
    expect(provider.pendingDescriptorsByPath.size).toBe(0);
  });

  it("does not borrow a previous request's final identity after same-path replacement", async () => {
    const target = init("concurrent-replacement");
    const metadata = path.join(target, ".git");
    const entered = deferred();
    const finish = deferred();
    const stat = fs.promises.stat.bind(fs.promises);
    let hold = true;
    let oldIdentity;
    spyOn(fs.promises, "stat").and.callFake(async (candidate, options) => {
      const value = await stat(candidate, options);
      if (hold && path.resolve(candidate) === metadata && options?.bigint === true) {
        hold = false;
        oldIdentity = String(value.ino);
        entered.resolve();
        await finish.promise;
      }
      return value;
    });
    const first = discoverRepositoryDescriptorAsync(target);
    await entered.promise;
    fs.renameSync(metadata, path.join(directory, "old-concurrent-metadata.git"));
    git(["init", "--quiet", target]);
    let second;
    const ready = discoverRepositoryDescriptorAsync(target);
    let timeout;
    try {
      second = await Promise.race([
        ready,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Final identity read was borrowed")), 5000);
        }),
      ]);
      expect(second.getGitDirectoryIdentity().inode).not.toBe(oldIdentity);
    } finally {
      clearTimeout(timeout);
      finish.resolve();
      await first;
      await ready;
    }
  });
});
