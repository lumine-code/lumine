const {
  assertSafeCatalogPackageSource,
  cloneUrlForRepository,
  listPackageRepositoryRefs,
  normalizeRepositoryOrigin,
  parsePackageSource,
  parseRemoteTags,
  resolvePackageSource,
  selectLatestTag,
  sortRemoteTags,
} = require("../src/package-source");

describe("package source", function () {
  it("defaults to the latest release selector", function () {
    expect(parsePackageSource("owner/repo")).toEqual({
      repository: "owner/repo",
      selector: { type: "latest", value: null },
      source: "owner/repo",
    });
  });

  it("parses explicit branches, tags, and commits", function () {
    expect(parsePackageSource("owner/repo#branch:next").selector).toEqual({
      type: "branch",
      value: "next",
    });
    expect(parsePackageSource("owner/repo#tag:v2.0.0").selector).toEqual({
      type: "tag",
      value: "v2.0.0",
    });
    expect(parsePackageSource("owner/repo#commit:abcdef1").selector).toEqual({
      type: "commit",
      value: "abcdef1",
    });
  });

  it("parses compact tag, commit, and branch selectors", function () {
    expect(parsePackageSource("owner/repo@2.1.1").selector).toEqual({
      type: "tag",
      value: "2.1.1",
    });
    expect(parsePackageSource("owner/repo#abcdef1").selector).toEqual({
      type: "commit",
      value: "abcdef1",
    });
    expect(parsePackageSource("owner/repo~feature/Next").selector).toEqual({
      type: "branch",
      value: "feature/Next",
    });
  });

  it("supports GitHub shorthand and generic Git URLs", function () {
    expect(cloneUrlForRepository("owner/repo")).toBe("https://github.com/owner/repo.git");
    expect(cloneUrlForRepository("https://example.com/owner/repo.git")).toBe(
      "https://example.com/owner/repo.git",
    );
  });

  it("normalizes transports and preserves unknown-host path case", function () {
    expect(normalizeRepositoryOrigin("Owner/Repo@1.0.0")).toBe("github.com/owner/repo");
    expect(normalizeRepositoryOrigin("git@github.com:OWNER/Repo.git")).toBe(
      "github.com/owner/repo",
    );
    expect(normalizeRepositoryOrigin("ssh://git@example.test:22/Owner/Repo.git")).toBe(
      "example.test/Owner/Repo",
    );
    expect(normalizeRepositoryOrigin("https://example.test/owner/repo.git")).toBe(
      "example.test/owner/repo",
    );
    expect(normalizeRepositoryOrigin("https://Example.test:8443/Owner/Repo.git")).toBe(
      "example.test:8443/Owner/Repo",
    );
    expect(normalizeRepositoryOrigin("https://[2001:4860:4860::8888]:8443/Owner/Repo.git")).toBe(
      "[2001:4860:4860::8888]:8443/Owner/Repo",
    );
  });

  it("limits automatic catalog sources to public HTTPS", function () {
    expect(assertSafeCatalogPackageSource("Owner/Repo").originKey).toBe("github.com/owner/repo");
    expect(() => assertSafeCatalogPackageSource("git@github.com:owner/repo.git")).toThrow();
    expect(() => assertSafeCatalogPackageSource("git://github.com/owner/repo.git")).toThrow();
    expect(() => assertSafeCatalogPackageSource("ext::helper owner/repo")).toThrow();
    expect(() => assertSafeCatalogPackageSource("file:///tmp/owner/repo")).toThrow();
    expect(() => assertSafeCatalogPackageSource("https://localhost/owner/repo")).toThrow();
    expect(() => assertSafeCatalogPackageSource("https://10.0.0.1/owner/repo")).toThrow();
    expect(() => assertSafeCatalogPackageSource("../repo")).toThrow();
  });

  it("selects the highest stable semver tag and uses peeled annotated tag SHAs", function () {
    const tags = parseRemoteTags(
      [
        "1111111111111111111111111111111111111111\trefs/tags/v1.0.0",
        "2222222222222222222222222222222222222222\trefs/tags/v2.0.0-beta.1",
        "3333333333333333333333333333333333333333\trefs/tags/v1.5.0",
        "4444444444444444444444444444444444444444\trefs/tags/v1.5.0^{}",
      ].join("\n"),
    );
    expect(selectLatestTag(tags)).toEqual({
      name: "v1.5.0",
      sha: "4444444444444444444444444444444444444444",
      version: "1.5.0",
    });
  });

  it("falls back to the default branch when a repository has only prerelease tags", async () => {
    expect(
      selectLatestTag([{ name: "v2.0.0-beta.1", sha: "2222222222222222222222222222222222222222" }]),
    ).toBeNull();

    let call = 0;
    const resolved = await resolvePackageSource("owner/repo", async () => {
      call++;
      return call === 1
        ? "2222222222222222222222222222222222222222\trefs/tags/v2.0.0-beta.1"
        : "1111111111111111111111111111111111111111\tHEAD";
    });

    expect(resolved.selector).toEqual({ type: "default", value: "HEAD" });
    expect(resolved.updatePolicy).toBe("default-branch");
  });

  it("resolves the default selector to the latest stable tag", async () => {
    const resolved = await resolvePackageSource("owner/repo", async (_url, options) => {
      expect(options).toEqual(["--tags"]);
      return [
        "1111111111111111111111111111111111111111\trefs/tags/v1.0.0",
        "2222222222222222222222222222222222222222\trefs/tags/v2.0.0",
      ].join("\n");
    });

    expect(resolved.fetchRef).toBe("refs/tags/v2.0.0");
    expect(resolved.sha).toBe("2222222222222222222222222222222222222222");
    expect(resolved.updatePolicy).toBe("latest-tag");
  });

  it("resolves an unprefixed semantic version to a v-prefixed tag when necessary", async () => {
    const resolved = await resolvePackageSource(
      "owner/repo@2.1.1",
      async () => "1111111111111111111111111111111111111111\trefs/tags/v2.1.1",
    );

    expect(resolved.selector).toEqual({ type: "tag", value: "v2.1.1" });
    expect(resolved.fetchRef).toBe("refs/tags/v2.1.1");
    expect(resolved.updatePolicy).toBe("pinned");
  });

  it("sorts stable, prerelease, and textual tags and lists branches lazily", async () => {
    expect(
      sortRemoteTags([
        { name: "nightly", sha: SHA },
        { name: "v2.0.0-beta.1", sha: SHA },
        { name: "v1.0.0", sha: SHA },
      ]).map(({ name }) => name),
    ).toEqual(["v1.0.0", "v2.0.0-beta.1", "nightly"]);

    const refs = await listPackageRepositoryRefs(
      "owner/repo",
      async () =>
        ["ref: refs/heads/main\tHEAD", `${SHA}\tHEAD`, `${SHA}\trefs/heads/main`].join("\n"),
      { includeBranches: true },
    );

    expect(refs.defaultBranch).toBe("main");
    expect(refs.branches).toEqual([{ name: "main", sha: SHA }]);
  });
});

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
