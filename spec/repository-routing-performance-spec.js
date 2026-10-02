const fs = require("fs");
const path = require("path");
const {
  RoutingRepository,
  createRoutingFixture,
  routingEvents,
  countRoutingWork,
} = require("../benchmark/helpers/repository-routing-fixture");

describe("Repository routing across large filesystem batches", () => {
  let registry;
  let repositories;
  let root;

  beforeEach(() => {
    ({ registry, repositories, root } = createRoutingFixture(512));
  });

  afterEach(() => registry.destroy());

  for (const count of [1000, 8000]) {
    for (const kind of ["working-tree", "metadata"]) {
      it(`routes ${count} ${kind} directories without scanning the fleet per directory`, () => {
        const events = routingEvents(repositories, count, kind);
        const { plan, metrics } = countRoutingWork(registry, () => ({
          plan: registry.repositoryRefreshPlanForFileChanges(events),
        }));
        expect(plan.pending.size).toBe(repositories.length);
        for (const repository of repositories) {
          expect(plan.pending.get(repository)).toBe(kind === "metadata" ? "both" : "status");
        }
        // One metadata-domain snapshot covers every directory in this batch;
        // ancestor lookups may grow with path depth, never fleet size × events.
        expect(metrics.entryVisits).toBeLessThanOrEqual(repositories.length);
        expect(metrics.metadataDomains).toBeLessThanOrEqual(repositories.length);
        const pathDepth = Math.max(...events.map((event) => event.path.split(path.sep).length));
        expect(metrics.ownerLookups).toBeLessThanOrEqual(
          count * pathDepth * 2 + repositories.length * 4,
        );
      });
    }
  }

  it("answers known working-tree and private Git paths without visiting unrelated entries", () => {
    const events = routingEvents(repositories, 1000, "working-tree");
    const { metrics } = countRoutingWork(registry, () => {
      for (let index = 0; index < events.length; index++) {
        const repository = repositories[index % repositories.length];
        expect(registry.getForPath(events[index].path)).toBe(repository);
        const matches = registry.matchGitDirectories(path.join(repository.getPath(), "refs"));
        expect(matches[0].entry.repository).toBe(repository);
      }
      return {};
    });
    expect(metrics.entryVisits).toBe(0);
    expect(metrics.metadataDomains).toBe(0);
  });

  it("preserves submodule, linked-worktree and common-metadata refresh domains", () => {
    const mainPath = path.join(root, "main");
    const mainGit = path.join(mainPath, ".git");
    const main = new RoutingRepository(mainPath, mainGit);
    const submodule = new RoutingRepository(
      path.join(mainPath, "vendor", "submodule"),
      path.join(mainGit, "modules", "submodule"),
    );
    const worktree = new RoutingRepository(
      path.join(root, "linked"),
      path.join(mainGit, "worktrees", "linked"),
      mainGit,
    );
    for (const repository of [main, submodule, worktree]) {
      registry.register(repository, { emit: false });
    }
    expect(registry.getForPath(path.join(submodule.getWorkingDirectory(), "src", "main.js"))).toBe(
      submodule,
    );
    const submodulePlan = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(submodule.getPath(), "HEAD") },
    ]);
    expect(submodulePlan.pending.get(submodule)).toBe("both");
    expect(submodulePlan.pending.get(main)).toBe("status");
    const privatePlan = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(worktree.getPath(), "HEAD") },
    ]);
    expect(privatePlan.pending.get(worktree)).toBe("both");
    expect(privatePlan.pending.get(main)).toBe("refs");
    const sharedPlan = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(mainGit, "refs", "heads", "main") },
    ]);
    expect(sharedPlan.pending.get(main)).toBe("both");
    expect(sharedPlan.pending.get(worktree)).toBe("both");
    expect(sharedPlan.pending.has(submodule)).toBe(false);
  });

  it("rereads common-domain relationships and discovered main aliases between batches", () => {
    const main = repositories[6];
    const linked = repositories[7];
    const alias = path.join(root, "metadata-alias");
    const normalized = (filePath) =>
      process.platform === "win32" ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
    registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(main.getPath(), "refs", "heads", "main") },
    ]);
    main.gitDirectoryAliases.push(alias);
    registry.register(main, { emit: false });
    const privateAlias = path.join(alias, "worktrees", "linked-7");
    const privatePlan = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(privateAlias, "HEAD") },
    ]);
    expect(privatePlan.pending.get(linked)).toBe("both");
    expect(privatePlan.pending.get(main)).toBe("refs");
    expect(registry.gitDirectoryOwners.get(normalized(privateAlias))).toBeUndefined();
    linked.commonDirectory = path.join(root, "new-common");
    const movedCommon = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(linked.commonDirectory, "refs", "heads", "changed") },
    ]);
    expect(movedCommon.pending.get(linked)).toBe("both");
    expect(movedCommon.pending.has(main)).toBe(false);
  });

  it("honors displaced aliases and skips missing, destroyed and removed owners", () => {
    const original = repositories[0];
    const pin = registry.retain(original, "routing-owner-spec");
    const replacement = new RoutingRepository(
      original.getWorkingDirectory(),
      path.join(root, "replacement.git"),
    );
    registry.register(replacement, { emit: false });
    const target = path.join(original.getWorkingDirectory(), "current.txt");
    expect(original.isDestroyed()).toBe(false);
    expect(registry.getForPath(target)).toBe(replacement);
    const replacementEntry = registry.entryByRepository.get(replacement);
    replacementEntry.missing = true;
    expect(registry.getForPath(target)).toBeNull();
    replacementEntry.missing = false;
    registry.entriesById.delete(replacementEntry.id);
    expect(registry.getForPath(target)).toBeNull();
    expect(registry.matchGitDirectories(replacement.getPath())).toEqual([]);
    registry.entriesById.set(replacementEntry.id, replacementEntry);
    replacement.destroy();
    expect(registry.getForPath(target)).toBeNull();
    pin.dispose();
  });

  it("keeps private Git alias ownership exclusive after displacement", () => {
    const original = repositories[1];
    const pin = registry.retain(original, "displaced-metadata-spec");
    const replacement = new RoutingRepository(
      path.join(root, "replacement-working-tree"),
      path.join(root, "replacement-metadata.git"),
    );
    replacement.gitDirectoryAliases.push(original.getPath());
    registry.register(replacement, { emit: false });
    const directory = path.join(original.getPath(), "refs", "heads");
    const matches = registry.matchGitDirectories(directory);
    expect(matches.map(({ entry }) => entry.repository)).toEqual([replacement]);
    const plan = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(directory, "main") },
    ]);
    expect(plan.pending.get(replacement)).toBe("both");
    expect(plan.pending.has(original)).toBe(false);
    expect(original.isDestroyed()).toBe(false);
    pin.dispose();
  });

  it("matches a filesystem root without introducing a doubled separator", () => {
    const filesystemRoot = path.parse(root).root;
    const repository = new RoutingRepository(null, filesystemRoot);
    registry.register(repository, { emit: false });
    const directory = path.join(filesystemRoot, "root-routing", "refs");
    expect(registry.getForPath(path.join(directory, "main"))).toBe(repository);
    const matches = registry.matchGitDirectories(directory);
    expect(matches[0].entry.repository).toBe(repository);
    expect(matches[0].relativePath).toBe("root-routing/refs");
  });

  it("translates private worktree metadata through an alias of a shared filesystem root", () => {
    const filesystemRoot = path.parse(root).root;
    const alias = path.join(root, "root-metadata-alias");
    const main = new RoutingRepository(null, filesystemRoot);
    main.gitDirectoryAliases.push(alias);
    const worktree = new RoutingRepository(
      path.join(root, "root-common-worktree"),
      path.join(filesystemRoot, "worktrees", "root-common-worktree"),
      filesystemRoot,
    );
    registry.register(main, { emit: false });
    registry.register(worktree, { emit: false });
    const plan = registry.repositoryRefreshPlanForFileChanges([
      { action: "updated", path: path.join(alias, "worktrees", "root-common-worktree", "HEAD") },
    ]);
    expect(plan.pending.get(worktree)).toBe("both");
    expect(plan.pending.get(main)).toBe("refs");
  });

  if (process.platform === "win32") {
    it("routes UNC share roots and their closest nested metadata domains", () => {
      const share = "\\\\routing-server\\routing-share\\";
      const shareRoot = new RoutingRepository(null, share);
      const nested = new RoutingRepository(
        path.join(share, "working"),
        path.join(share, "metadata"),
      );
      registry.register(shareRoot, { emit: false });
      registry.register(nested, { emit: false });
      expect(registry.getForPath(path.join(share, "working", "src", "main.js"))).toBe(nested);
      const matches = registry.matchGitDirectories(path.join(share, "metadata", "refs", "heads"));
      expect(matches.map(({ entry }) => entry.repository)).toEqual([nested, shareRoot]);
      expect(matches.map(({ relativePath }) => relativePath)).toEqual([
        "refs/heads",
        "metadata/refs/heads",
      ]);
    });
  }

  it("does not access the filesystem while routing public paths and metadata batches", () => {
    const spies = [];
    try {
      for (const [target, methods] of [
        [fs, ["statSync", "lstatSync", "realpathSync"]],
        [fs.promises, ["stat", "lstat", "realpath"]],
      ]) {
        for (const method of methods) {
          spies.push(spyOn(target, method).and.throwError("Routing must remain lexical"));
        }
      }
      const repository = repositories[0];
      expect(
        registry.getForPath(path.join(repository.getWorkingDirectory(), "src", "file.js")),
      ).toBe(repository);
      const plan = registry.repositoryRefreshPlanForFileChanges([
        { action: "updated", path: path.join(repository.getPath(), "refs", "heads", "main") },
      ]);
      expect(plan.pending.get(repository)).toBe("both");
    } finally {
      // The editor's outer afterEach reloads keymaps before Jasmine restores
      // spies, so restore real filesystem behavior before environment teardown.
      for (const spy of spies) spy.and.callThrough();
    }
  });
});
