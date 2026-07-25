const path = require("path");
const CSON = require("@lumine-code/season");
// eslint-disable-next-line n/no-unpublished-require
const { normalizeRepositoryOrigin, repositoryReference } = require("../../../src/package-source");

const ownerFromRepository = (repository) => {
  if (!repository) return "";

  const loginRegex = /github\.com\/([\w-]+)\/.+/;
  let repo = repository;
  if (typeof repository !== "string") {
    repo = repository.url;
    if (repo.match("git@github")) {
      const repoName = repo.split(":")[1];
      repo = `https://github.com/${repoName}`;
    }
  }

  if (!repo.match("github.com/")) {
    repo = `https://github.com/${repo}`;
  }

  const match = repo.match(loginRegex);
  return match ? match[1] : "";
};

const repoUrlFromRepository = (repository) => {
  if (!repository) return "";

  let repo;

  if (typeof repository === "string") {
    repo = repository;
  } else if (typeof repository === "object" && typeof repository.url === "string") {
    repo = repository.url;
  } else {
    repo = "";
  }
  if (!repo) return "";

  // git@host:owner/repo → https so it opens in a browser, not as a file path.
  const scp = repo.match(/^git@([^:]+):(.+)$/);
  if (scp) repo = `https://${scp[1]}/${scp[2]}`;
  repo = repo.replace(/^git\+/, "");
  if (repo.endsWith(".git")) {
    repo = repo.replace(/\.git$/, "");
  }
  // A bare owner/repo shorthand → GitHub web URL.
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    repo = `https://github.com/${repo}`;
  }

  return repo;
};

// The short license name shown on a package card: the SPDX identifier from
// package.json. Modern manifests carry it as a string; legacy ones use an object
// or a `licenses` array, which npm has deprecated but old packages still ship.
const licenseLabelFromMetadata = (metadata) => {
  if (!metadata) return "";

  const { license, licenses } = metadata;
  const identifier = (value) => {
    if (typeof value === "string") return value.trim();
    if (value && typeof value.type === "string") return value.type.trim();
    return "";
  };

  const single = identifier(license);
  if (single) return single;
  if (Array.isArray(licenses)) {
    return licenses.map(identifier).filter(Boolean).join(", ");
  }
  return identifier(licenses);
};

// The comparable identity includes the host. GitHub shorthand is displayed as
// owner/repo, while generic hosts remain explicit.
const packageOriginKey = (repository) => normalizeRepositoryOrigin(repository);
const repoReferenceFromRepository = (repository) => repositoryReference(repository);

// Package identity, in one place.
//
// A package has two identities that must not be confused:
//   * its NAME is the install SLOT — the install directory, command prefix,
//     config namespace, and activation. Only one package per name can be
//     installed, so the name is unique *among installed packages* but NOT
//     globally: the same name may be published from many sources.
//   * its ORIGIN is the SOURCE PATH (the repository / install source). This is
//     the globally unique identity used to browse, deduplicate catalogs, match
//     update candidates, and decide whether an install would collide.
//
// `packageOrigin` resolves the origin from whatever shape it is handed (a
// catalog entry, a Pulsar entry, a Git-install card, or installed metadata),
// most authoritative first. The package.json `repository` field is the LAST
// resort because it is unreliable in forks — a fork usually still points its
// repository at the upstream, which would otherwise make an unrelated
// same-named package look like the installed one.
const packageOrigin = (pack) => {
  if (!pack) return "";
  const install = pack.apmInstallSource;
  const candidates = [
    // `apmInstallSource.origin` is the canonical origin recorded at install time
    // from the source actually cloned — authoritative, so it wins.
    install && install.origin,
    pack.originKey,
    pack.installSource,
    install && install.source,
    install && install.repository,
    pack.repository,
  ];
  for (const candidate of candidates) {
    const key = packageOriginKey(candidate);
    if (key) return key;
  }
  return "";
};

// The full identity of a package: its install slot (name) and its unique origin.
const packageCoordinate = (pack) => ({
  name: pack ? pack.name : undefined,
  originKey: packageOrigin(pack),
});

const packagePanelKey = (pack) => {
  if (!pack) return "package:unknown";
  if (pack.packageKind === "builtin" || pack.isBuiltinDescriptor) return `builtin:${pack.name}`;
  const origin = packageOrigin(pack);
  if (origin) return `community:${origin}`;
  return `local:${pack.name}`;
};

// The origin key(s) identifying where an installed package actually came from.
// Kept as an array for callers that match with `includes`; today this is the
// single canonical origin.
const installedOriginKeys = (metadata) => {
  const origin = packageOrigin(metadata);
  return origin ? [origin] : [];
};

// Returns the metadata of the installed package with the given name, whether
// it is loaded or merely present in a package directory, or null.
const getInstalledPackageMetadata = (name) => {
  const loadedPackage = atom.packages.getLoadedPackage(name);
  if (loadedPackage && loadedPackage.metadata) return loadedPackage.metadata;
  for (const dirPath of atom.packages.getPackageDirPaths()) {
    try {
      const metadataPath = CSON.resolve(path.join(dirPath, name, "package"));
      if (metadataPath) return CSON.readFileSync(metadataPath);
    } catch {
      // not installed in this directory; keep looking
    }
  }
  return null;
};

const packageComparatorAscending = (left, right) => {
  const leftStatus = atom.packages.isPackageDisabled(left.name);
  const rightStatus = atom.packages.isPackageDisabled(right.name);
  if (leftStatus === rightStatus) {
    if (left.name > right.name) {
      return -1;
    } else if (left.name < right.name) {
      return 1;
    } else {
      return 0;
    }
  } else if (leftStatus > rightStatus) {
    return -1;
  } else {
    return 1;
  }
};

module.exports = {
  ownerFromRepository,
  repoUrlFromRepository,
  packageOriginKey,
  repoReferenceFromRepository,
  licenseLabelFromMetadata,
  packageOrigin,
  packageCoordinate,
  packagePanelKey,
  installedOriginKeys,
  getInstalledPackageMetadata,
  packageComparatorAscending,
};
