const CommunityPackageCatalogClient = require("../lib/community-package-catalog-client");
const { normalizeCatalogSource, TaskQueue } = CommunityPackageCatalogClient;

const SHA_1 = "1111111111111111111111111111111111111111";
const SHA_2 = "2222222222222222222222222222222222222222";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

function textResponse(status, body, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function createPackageManager({ branches = false } = {}) {
  return {
    getGitCommand: () => "git",
    runProcess: jasmine.createSpy("runProcess").andCallFake((_command, args) => {
      if (args[0] !== "ls-remote") return Promise.resolve({ stdout: "" });
      const includeBranches = args.includes("refs/heads/*");
      return Promise.resolve({
        stdout: [
          "ref: refs/heads/main\tHEAD",
          `${SHA_1}\tHEAD`,
          `${SHA_1}\trefs/tags/v1.0.0`,
          `${SHA_2}\trefs/tags/v2.0.0-beta.1`,
          ...(includeBranches || branches
            ? [`${SHA_1}\trefs/heads/main`, `${SHA_2}\trefs/heads/Next`]
            : []),
        ].join("\n"),
      });
    }),
  };
}

function createFetch(catalogs = {}) {
  return jasmine.createSpy("fetchImpl").andCallFake((url) => {
    if (Object.hasOwn(catalogs, url)) return Promise.resolve(textResponse(200, catalogs[url]));
    if (url.includes("raw.githubusercontent.com/owner/package/")) {
      return Promise.resolve(
        textResponse(200, {
          name: "sample-package",
          version: "1.0.0",
          description: "From its repository",
          repository: "https://github.com/OWNER/package.git",
          engines: { lumine: "*" },
          readme: "# Must remain lazy",
          badges: [{ image: "https://example.test/badge.svg" }],
        }),
      );
    }
    return Promise.resolve(textResponse(404, "not found"));
  });
}

describe("CommunityPackageCatalogClient", function () {
  it("normalizes index.json catalog locations", function () {
    expect(normalizeCatalogSource("owner/catalog")).toBe(
      "https://raw.githubusercontent.com/owner/catalog/main/index.json",
    );
    expect(normalizeCatalogSource("https://github.com/owner/catalog.git")).toBe(
      "https://raw.githubusercontent.com/owner/catalog/main/index.json",
    );
    expect(normalizeCatalogSource("https://catalog.example/community")).toBe(
      "https://catalog.example/community/index.json",
    );
    expect(normalizeCatalogSource("https://example.test/index.json")).toBe(
      "https://example.test/index.json",
    );
  });

  it("accepts only source strings and rejects the old metadata schema", function () {
    const client = new CommunityPackageCatalogClient({ storage: createStorage() });
    expect(client.validate(["owner/package@1.0.0"])[0]).toEqual(
      jasmine.objectContaining({
        originKey: "github.com/owner/package",
        repository: "owner/package",
        selector: { type: "tag", value: "1.0.0" },
      }),
    );
    expect(() => client.validate({ schemaVersion: 1, packages: [] })).toThrow();
    expect(() => client.validate(["owner/package#abcdef1"])).toThrow();
  });

  it("merges installed-package update results into the cached entries", function () {
    const storage = createStorage();
    storage.setItem(
      "settings-view:community-package-catalog-v2",
      JSON.stringify({
        schemaVersion: 2,
        lastFetch: 1,
        catalogSources: ["https://catalog.test/index.json"],
        manifests: {},
        readmes: {},
        packages: {
          "github.com/owner/pkg": {
            originKey: "github.com/owner/pkg",
            name: "pkg",
            version: "1.0.0",
          },
        },
      }),
    );
    const client = new CommunityPackageCatalogClient({ storage });

    client.mergeInstalledUpdates([
      {
        apmInstallSource: { origin: "github.com/owner/pkg" },
        latestSha: "a".repeat(40),
        latestVersion: "1.1.0",
      },
      { apmInstallSource: { origin: "github.com/owner/absent" }, latestSha: "b".repeat(40) },
    ]);

    const cache = JSON.parse(storage.getItem("settings-view:community-package-catalog-v2"));
    expect(cache.packages["github.com/owner/pkg"].latestSha).toBe("a".repeat(40));
    expect(cache.packages["github.com/owner/pkg"].latestVersion).toBe("1.1.0");
    // Existing catalog fields are preserved, and unknown origins are ignored.
    expect(cache.packages["github.com/owner/pkg"].name).toBe("pkg");
    expect(cache.packages["github.com/owner/absent"]).toBeUndefined();
  });

  it("blocks unsafe automatic repository transports and local targets", function () {
    const client = new CommunityPackageCatalogClient({ storage: createStorage() });
    expect(() => client.validate(["git@github.com:owner/package.git"])).toThrow();
    expect(() => client.validate(["file:///tmp/package"])).toThrow();
    expect(() => client.validate(["https://127.0.0.1/package"])).toThrow();
    expect(() => client.validate(["https://user:secret@example.test/package"])).toThrow();
  });

  it("hydrates names and metadata from the exact selected SHA", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const fetchImpl = createFetch({ [catalogUrl]: ["owner/package"] });
    const client = new CommunityPackageCatalogClient({
      fetchImpl,
      packageManager: createPackageManager(),
      storage: createStorage(),
      atomVersion: () => "1.132.1",
    });

    waitsForPromise(() =>
      client.loadAll([catalogUrl], { refresh: true }).then((catalog) => {
        expect(catalog.packages.length).toBe(1);
        expect(catalog.packages[0]).toEqual(
          jasmine.objectContaining({
            name: "sample-package",
            originKey: "github.com/owner/package",
            resolvedSha: SHA_1,
            selectedRef: { type: "latest", value: "v1.0.0" },
            status: "ready",
            readme: undefined,
            badges: [],
          }),
        );
        expect(
          fetchImpl.argsForCall.some((args) => args[0].includes(`/${SHA_1}/package.json`)),
        ).toBe(true);
      }),
    );
  });

  it("shows an engine-incompatible package instead of rejecting it", function () {
    const catalogUrl = "https://catalog.test/index.json";
    const fetchImpl = jasmine.createSpy("fetchImpl").andCallFake((url) => {
      if (url === catalogUrl) return Promise.resolve(textResponse(200, ["owner/package"]));
      if (url.includes(`/${SHA_1}/package.json`)) {
        return Promise.resolve(
          textResponse(200, {
            name: "sample-package",
            version: "1.0.0",
            repository: "https://github.com/owner/package.git",
            engines: { lumine: ">=999.0.0" },
          }),
        );
      }
      return Promise.resolve(textResponse(404, "not found"));
    });
    const client = new CommunityPackageCatalogClient({
      fetchImpl,
      packageManager: createPackageManager(),
      storage: createStorage(),
      atomVersion: () => "1.132.1",
    });

    waitsForPromise(() =>
      client.loadAll([catalogUrl], { refresh: true }).then((catalog) => {
        expect(catalog.packages[0]).toEqual(
          jasmine.objectContaining({
            name: "sample-package",
            originKey: "github.com/owner/package",
            status: "ready",
          }),
        );
        expect(catalog.packages[0].engines).toEqual({ lumine: ">=999.0.0" });
      }),
    );
  });

  it("clears an earlier origin mismatch once a corrected release is published", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    // v1.0.0 ships a manifest whose repository points at the wrong origin; a
    // later v1.1.0 corrects it. Manifests are keyed by SHA, so the corrected
    // release is fetched fresh instead of reusing the rejected manifest.
    let tags = [`${SHA_1}\trefs/tags/v1.0.0`];
    const packageManager = {
      getGitCommand: () => "git",
      runProcess: jasmine.createSpy("runProcess").andCallFake((_command, args) => {
        if (args[0] !== "ls-remote") return Promise.resolve({ stdout: "" });
        return Promise.resolve({
          stdout: ["ref: refs/heads/main\tHEAD", `${SHA_1}\tHEAD`, ...tags].join("\n"),
        });
      }),
    };
    const fetchImpl = jasmine.createSpy("fetchImpl").andCallFake((url) => {
      if (url === catalogUrl) return Promise.resolve(textResponse(200, ["owner/package"]));
      if (url.includes(`/${SHA_1}/package.json`)) {
        return Promise.resolve(
          textResponse(200, {
            name: "sample-package",
            version: "1.0.0",
            repository: "https://github.com/someone-else/package.git",
            engines: { lumine: "*" },
          }),
        );
      }
      if (url.includes(`/${SHA_2}/package.json`)) {
        return Promise.resolve(
          textResponse(200, {
            name: "sample-package",
            version: "1.1.0",
            repository: "https://github.com/owner/package.git",
            engines: { lumine: "*" },
          }),
        );
      }
      return Promise.resolve(textResponse(404, "not found"));
    });
    const client = new CommunityPackageCatalogClient({
      fetchImpl,
      packageManager,
      storage: createStorage(),
      atomVersion: () => "1.132.1",
    });

    waitsForPromise(() =>
      client
        .loadAll([catalogUrl], { refresh: true })
        .then((catalog) => {
          // The mismatched manifest fails strict origin validation.
          expect(catalog.packages[0]).toEqual(
            jasmine.objectContaining({
              originKey: "github.com/owner/package",
              status: "error",
              unverifiedName: true,
            }),
          );
          // Upstream corrects the repository field and publishes a new stable tag.
          tags = [`${SHA_1}\trefs/tags/v1.0.0`, `${SHA_2}\trefs/tags/v1.1.0`];
          return client.loadAll([catalogUrl], { refresh: true });
        })
        .then((catalog) => {
          expect(catalog.packages[0]).toEqual(
            jasmine.objectContaining({
              name: "sample-package",
              originKey: "github.com/owner/package",
              resolvedSha: SHA_2,
              selectedRef: { type: "latest", value: "v1.1.0" },
              status: "ready",
            }),
          );
        }),
    );
  });

  it("inspects an installed update at its exact SHA through Git", function () {
    const storage = createStorage();
    const client = new CommunityPackageCatalogClient({
      packageManager: createPackageManager(),
      storage,
      atomVersion: () => "1.132.1",
    });
    spyOn(client, "fetchManifest").andReturn(
      Promise.resolve({
        name: "renamed-package",
        version: "2.0.0",
        repository: "owner/package",
        engines: { lumine: "*" },
      }),
    );

    waitsForPromise(() =>
      client
        .inspectResolvedManifest(
          {
            name: "old-package",
            apmInstallSource: {
              origin: "github.com/owner/package",
              repository: "owner/package",
            },
          },
          SHA_2,
          { type: "latest", value: "v2.0.0" },
        )
        .then((metadata) => {
          expect(metadata.name).toBe("renamed-package");
          expect(client.fetchManifest).toHaveBeenCalledWith(
            {
              originKey: "github.com/owner/package",
              repository: "owner/package",
              manualSource: true,
            },
            SHA_2,
            null,
          );
        }),
    );
  });

  it("uses the persistent cache without automatic revalidation", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const storage = createStorage();
    const fetchImpl = createFetch({ [catalogUrl]: ["owner/package"] });
    const client = new CommunityPackageCatalogClient({
      fetchImpl,
      packageManager: createPackageManager(),
      storage,
    });

    waitsForPromise(() =>
      client
        .loadAll([catalogUrl], { refresh: true })
        .then(() => {
          fetchImpl.reset();
          return client.loadAll([catalogUrl]);
        })
        .then((catalog) => {
          expect(catalog.cached).toBe(true);
          expect(catalog.packages[0].name).toBe("sample-package");
          expect(fetchImpl).not.toHaveBeenCalled();
          return client.loadAll([catalogUrl, "new/catalog"], { cacheOnly: true });
        })
        .then((catalog) => {
          expect(catalog.packages[0].name).toBe("sample-package");
          expect(catalog.pendingSources).toEqual([
            "https://raw.githubusercontent.com/new/catalog/main/index.json",
          ]);
        }),
    );
  });

  it("preserves the complete previous cache when a refresh is cancelled", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const storage = createStorage();
    storage.setItem(
      "settings-view:community-package-catalog-v2",
      JSON.stringify({
        schemaVersion: 2,
        lastFetch: 123,
        catalogSources: [catalogUrl],
        manifests: {},
        readmes: {},
        packages: {
          "github.com/owner/package": {
            name: "cached-package",
            originKey: "github.com/owner/package",
            repository: "owner/package",
            installSource: "owner/package",
            catalogSources: [catalogUrl],
            status: "ready",
          },
        },
      }),
    );
    const client = new CommunityPackageCatalogClient({
      fetchImpl: createFetch({ [catalogUrl]: ["owner/package"] }),
      packageManager: createPackageManager(),
      storage,
    });

    waitsForPromise(() =>
      client
        .loadAll([catalogUrl], {
          refresh: true,
          onProgress({ processed }) {
            if (processed === 0) client.cancel();
          },
        })
        .then((catalog) => {
          expect(catalog.cancelled).toBe(true);
          expect(catalog.lastFetch).toBe(123);
          expect(catalog.packages.map(({ name }) => name)).toEqual(["cached-package"]);
          return client.loadAll([catalogUrl], { cacheOnly: true });
        })
        .then((catalog) => {
          expect(catalog.packages.map(({ name }) => name)).toEqual(["cached-package"]);
        }),
    );
  });

  it("merges provenance and keeps the first catalog selector", function () {
    const first = "https://one.test/sources.json";
    const second = "https://two.test/sources.json";
    const client = new CommunityPackageCatalogClient({
      fetchImpl: createFetch({
        [first]: ["owner/package@1.0.0"],
        [second]: ["https://github.com/owner/package.git#branch:Next"],
      }),
      packageManager: createPackageManager(),
      storage: createStorage(),
    });
    waitsForPromise(() =>
      client.loadAll([first, second], { refresh: true }).then((catalog) => {
        expect(catalog.packages.length).toBe(1);
        expect(catalog.packages[0].installSource).toBe("owner/package@1.0.0");
        expect(catalog.packages[0].catalogSources).toEqual([first, second]);
        expect(catalog.packages[0].selectorConflict).toBe(true);
      }),
    );
  });

  it("loads the complete branch list lazily and caches it", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const packageManager = createPackageManager();
    const client = new CommunityPackageCatalogClient({
      fetchImpl: createFetch({ [catalogUrl]: ["owner/package"] }),
      packageManager,
      storage: createStorage(),
    });
    waitsForPromise(() =>
      client
        .loadAll([catalogUrl], { refresh: true })
        .then((catalog) => {
          expect(catalog.packages[0].refs.branches).toBeNull();
          return client.loadBranches(catalog.packages[0]);
        })
        .then((pack) => {
          expect(pack.refs.branches.map(({ name }) => name)).toEqual(["main", "Next"]);
          expect(packageManager.runProcess.mostRecentCall.args[1]).toContain("refs/heads/*");
        }),
    );
  });

  it("keeps the previous hydrated record as stale when a repository refresh fails", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const storage = createStorage();
    let sha = SHA_1;
    let failManifest = false;
    const packageManager = createPackageManager();
    packageManager.runProcess.andCallFake(() =>
      Promise.resolve({
        stdout: ["ref: refs/heads/main\tHEAD", `${sha}\tHEAD`, `${sha}\trefs/tags/v1.0.0`].join(
          "\n",
        ),
      }),
    );
    const fetchImpl = jasmine.createSpy("fetchImpl").andCallFake((url) => {
      if (url === catalogUrl) return Promise.resolve(textResponse(200, ["owner/package"]));
      if (failManifest) return Promise.resolve(textResponse(404, "missing"));
      return Promise.resolve(
        textResponse(200, {
          name: "sample-package",
          version: "1.0.0",
          repository: "owner/package",
          engines: { lumine: "*" },
        }),
      );
    });
    const client = new CommunityPackageCatalogClient({ fetchImpl, packageManager, storage });

    waitsForPromise(() =>
      client
        .loadAll([catalogUrl], { refresh: true })
        .then(() => {
          sha = SHA_2;
          failManifest = true;
          return client.loadAll([catalogUrl], { refresh: true });
        })
        .then((catalog) => {
          expect(catalog.packages[0].name).toBe("sample-package");
          expect(catalog.packages[0].status).toBe("stale");
          expect(catalog.packages[0].error).toContain("does not contain");
        }),
    );
  });

  it("keeps a renderable origin-based error record when first hydration fails", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const client = new CommunityPackageCatalogClient({
      fetchImpl: jasmine
        .createSpy("fetchImpl")
        .andCallFake((url) =>
          Promise.resolve(
            url === catalogUrl
              ? textResponse(200, ["owner/broken-package"])
              : textResponse(404, "missing"),
          ),
        ),
      packageManager: createPackageManager(),
      storage: createStorage(),
    });

    waitsForPromise(() =>
      client.loadAll([catalogUrl], { refresh: true }).then((catalog) => {
        expect(catalog.packages[0]).toEqual(
          jasmine.objectContaining({
            name: "broken-package",
            originKey: "github.com/owner/broken-package",
            unverifiedName: true,
            status: "error",
          }),
        );
      }),
    );
  });

  it("rejects more than 2000 unique origins before hydration", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const sources = Array.from({ length: 2001 }, (_value, index) => `owner/package-${index}`);
    const client = new CommunityPackageCatalogClient({
      fetchImpl: createFetch({ [catalogUrl]: sources }),
      packageManager: createPackageManager(),
      storage: createStorage(),
    });
    waitsForPromise(() =>
      client.loadAll([catalogUrl], { refresh: true }).then(
        () => Promise.reject(new Error("expected rejection")),
        (error) => expect(error.message).toContain("safety limit"),
      ),
    );
  });

  it("hydrates and persists an index of 1000 repositories with bounded host concurrency", function () {
    const catalogUrl = "https://catalog.test/sources.json";
    const sources = Array.from({ length: 1000 }, (_value, index) => `owner/package-${index}`);
    const storage = createStorage();
    let activeGit = 0;
    let activeHttp = 0;
    let maximumGit = 0;
    let maximumHttp = 0;
    let finalProgress = null;
    const packageManager = {
      getGitCommand: () => "git",
      runProcess: jasmine.createSpy("runProcess").andCallFake(() => {
        activeGit++;
        maximumGit = Math.max(maximumGit, activeGit);
        return Promise.resolve().then(() => {
          activeGit--;
          return {
            stdout: [
              "ref: refs/heads/main\tHEAD",
              `${SHA_1}\tHEAD`,
              `${SHA_1}\trefs/tags/v1.0.0`,
            ].join("\n"),
          };
        });
      }),
    };
    const fetchImpl = jasmine.createSpy("fetchImpl").andCallFake((url) => {
      activeHttp++;
      maximumHttp = Math.max(maximumHttp, activeHttp);
      return Promise.resolve().then(() => {
        activeHttp--;
        if (url === catalogUrl) return textResponse(200, sources);
        const match = url.match(/\/owner\/(package-\d+)\//);
        return textResponse(200, {
          name: match[1],
          version: "1.0.0",
          repository: `owner/${match[1]}`,
          engines: { lumine: "*" },
        });
      });
    });
    const client = new CommunityPackageCatalogClient({
      fetchImpl,
      packageManager,
      storage,
    });

    waitsForPromise(() =>
      client
        .loadAll([catalogUrl], {
          refresh: true,
          onProgress(progress) {
            finalProgress = progress;
          },
        })
        .then((catalog) => {
          expect(catalog.packages.length).toBe(1000);
          expect(finalProgress).toEqual({ processed: 1000, total: 1000, errors: 0 });
          expect(maximumGit).toBeLessThanOrEqual(4);
          expect(maximumHttp).toBeLessThanOrEqual(4);
          return new CommunityPackageCatalogClient({ storage }).loadAll([catalogUrl], {
            cacheOnly: true,
          });
        })
        .then((catalog) => expect(catalog.packages.length).toBe(1000)),
    );
  });

  it("loads README lazily at the exact SHA and reuses its bounded cache", function () {
    const storage = createStorage();
    const fetchImpl = jasmine
      .createSpy("fetchImpl")
      .andReturn(Promise.resolve(textResponse(200, "# Exact README")));
    const client = new CommunityPackageCatalogClient({ fetchImpl, storage });
    const pack = {
      originKey: "github.com/owner/package",
      repository: "owner/package",
      resolvedSha: SHA_1,
    };
    waitsForPromise(() =>
      client
        .loadReadme(pack)
        .then((readme) => {
          expect(readme.body).toBe("# Exact README");
          expect(fetchImpl.mostRecentCall.args[0]).toContain(`/${SHA_1}/README.md`);
          fetchImpl.reset();
          return client.loadReadme(pack);
        })
        .then((readme) => {
          expect(readme.body).toBe("# Exact README");
          expect(fetchImpl).not.toHaveBeenCalled();
        }),
    );
  });

  it("enforces queue and per-host concurrency", function () {
    const queue = new TaskQueue(3, 2);
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 8 }, () =>
      queue.add(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
      }, "same-host"),
    );
    waitsForPromise(() =>
      Promise.all(tasks).then(() => {
        expect(maximum).toBe(2);
      }),
    );
  });

  it("retries transient HTTP failures with bounded backoff", function () {
    let attempts = 0;
    const client = new CommunityPackageCatalogClient({
      fetchImpl: jasmine.createSpy("fetchImpl").andCallFake(() => {
        attempts++;
        return Promise.resolve(
          attempts === 1 ? textResponse(500, "temporary") : textResponse(200, "ready"),
        );
      }),
      storage: createStorage(),
      delay: () => Promise.resolve(),
    });

    waitsForPromise(() =>
      client.requestText("https://catalog.test/sources.json", { maxBytes: 1024 }).then((body) => {
        expect(body).toBe("ready");
        expect(attempts).toBe(2);
      }),
    );
  });
});
