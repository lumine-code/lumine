"use strict";

const semver = require("semver");
const net = require("net");

const SELECTOR_TYPES = new Set(["branch", "tag", "commit"]);
const CASE_INSENSITIVE_PATH_HOSTS = new Set(["github.com"]);
// npm's hosted-git shorthands, which a manifest's `repository` field is free to
// use. They look like an SCP-style URL and must be recognised before one.
const HOSTED_GIT_SHORTHANDS = new Map([
  ["github", "github.com"],
  ["gitlab", "gitlab.com"],
  ["bitbucket", "bitbucket.org"],
]);
const DEFAULT_PORTS = new Map([
  ["http:", "80"],
  ["https:", "443"],
  ["ssh:", "22"],
]);
const MAX_REMOTE_REFS = 10000;
const MAX_REMOTE_OUTPUT_BYTES = 10 * 1024 * 1024;

function validRepositorySegment(value) {
  return !!value && value !== "." && value !== "..";
}

function githubShorthandMatch(value) {
  const match = String(value || "").match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return match && validRepositorySegment(match[1]) && validRepositorySegment(match[2])
    ? match
    : null;
}

function parsePackageSource(input) {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("A package repository is required.");
  }

  // Friendly shorthand for GitHub-style owner/repo sources. Generic Git URLs
  // retain the explicit #branch:, #tag:, and #commit: forms so URL characters
  // are never interpreted ambiguously.
  const shorthandCandidate = /#(?:branch|tag|commit):/i.test(value)
    ? null
    : value.match(/^([\w.-]+\/[\w.-]+)(?:@(.+)|#(.+)|~(.+))?$/i);
  const shorthand =
    shorthandCandidate && shorthandCandidate[1].split("/").every(validRepositorySegment)
      ? shorthandCandidate
      : null;
  if (shorthand) {
    const [, repository, tag, commit, branch] = shorthand;
    let selector = { type: "latest", value: null };
    if (tag) selector = { type: "tag", value: tag };
    if (commit) selector = { type: "commit", value: commit };
    if (branch) selector = { type: "branch", value: branch };
    return { repository, selector, source: value };
  }

  const hashIndex = value.lastIndexOf("#");
  const repository = (hashIndex === -1 ? value : value.slice(0, hashIndex)).trim();
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex + 1).trim();
  if (!repository) {
    throw new Error(`Invalid package repository: "${input}".`);
  }

  let selector = { type: "latest", value: null };
  if (fragment) {
    const separator = fragment.indexOf(":");
    const possibleType = separator === -1 ? "" : fragment.slice(0, separator).toLowerCase();
    if (SELECTOR_TYPES.has(possibleType)) {
      const selectorValue = fragment.slice(separator + 1).trim();
      if (!selectorValue) {
        throw new Error(`The ${possibleType} selector must include a value.`);
      }
      selector = { type: possibleType, value: selectorValue };
    } else {
      selector = { type: "ref", value: fragment };
    }
  }

  return { repository, selector, source: value };
}

function cloneUrlForRepository(repository) {
  const shorthand = githubShorthandMatch(repository);
  if (shorthand) {
    return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`;
  }
  if (/^(?:git\+)?(?:https?|ssh|git):\/\//.test(repository) || /^git@[^:]+:.+/.test(repository)) {
    return repository.replace(/^git\+/, "");
  }
  throw new Error(
    "Enter owner/repo[@tag|#commit|~branch] or a Git URL with an explicit #branch:, #tag:, or #commit: selector.",
  );
}

function repositoryString(repository) {
  if (typeof repository === "string") return repository.trim();
  if (repository && typeof repository.url === "string") return repository.url.trim();
  return "";
}

// Return a transport-independent repository identity. Credentials, selectors,
// a trailing .git and default ports never participate in package identity.
// Paths on unknown hosts retain their case because Git servers are allowed to
// treat them as case-sensitive.
function normalizeRepositoryOrigin(repository) {
  const value = repositoryString(repository);
  if (!value) return "";

  let bare;
  try {
    bare = parsePackageSource(value).repository;
  } catch {
    bare = value;
  }
  bare = bare.replace(/^git\+/i, "").replace(/\/+$/, "");

  const canonicalIpv6 = bare.match(/^\[([0-9a-f:]+)\](?::(\d+))?\/(.+)$/i);
  if (canonicalIpv6) {
    const repositoryPath = canonicalIpv6[3].replace(/\.git$/i, "");
    return `[${canonicalIpv6[1].toLowerCase()}]${
      canonicalIpv6[2] ? `:${canonicalIpv6[2]}` : ""
    }/${repositoryPath}`;
  }

  const canonical = bare.match(/^([\w.-]+\.[\w.-]+(?::\d+)?)\/(.+)$/);
  if (canonical) {
    const hostWithPort = canonical[1].toLowerCase();
    const host = hostWithPort.replace(/:\d+$/, "");
    const repositoryPath = canonical[2].replace(/\.git$/i, "");
    return `${hostWithPort}/${
      CASE_INSENSITIVE_PATH_HOSTS.has(host) ? repositoryPath.toLowerCase() : repositoryPath
    }`;
  }

  const shorthand = githubShorthandMatch(bare);
  if (shorthand) {
    return `github.com/${shorthand[1].toLowerCase()}/${shorthand[2].toLowerCase()}`;
  }

  // npm hosted-git shorthand: github:Owner/Repo
  const hosted = bare.match(/^([a-z]+):([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (hosted && HOSTED_GIT_SHORTHANDS.has(hosted[1].toLowerCase())) {
    const hostedHost = HOSTED_GIT_SHORTHANDS.get(hosted[1].toLowerCase());
    const hostedPath = hosted[2];
    return `${hostedHost}/${
      CASE_INSENSITIVE_PATH_HOSTS.has(hostedHost) ? hostedPath.toLowerCase() : hostedPath
    }`;
  }

  // SCP-style SSH URL: git@example.test:Owner/Repo.git. A host is only a host
  // if it is named like one — otherwise `scheme:owner/repo` reads as one.
  const scp = bare.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/);
  let host;
  let port = "";
  let pathname;
  if (scp && (scp[1] != null || scp[2].includes(".")) && !/^[a-z][a-z\d+.-]*:\/\//i.test(bare)) {
    host = scp[2];
    pathname = scp[3];
  } else {
    let parsed;
    try {
      parsed = new URL(bare);
    } catch {
      return "";
    }
    host = parsed.hostname;
    port = parsed.port;
    pathname = decodeURIComponent(parsed.pathname || "");
    if (port && DEFAULT_PORTS.get(parsed.protocol) === port) port = "";
  }

  host = String(host || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  pathname = String(pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  if (!host || !pathname) return "";
  if (CASE_INSENSITIVE_PATH_HOSTS.has(host)) pathname = pathname.toLowerCase();
  const canonicalHost = host.includes(":") ? `[${host}]` : host;
  return `${canonicalHost}${port ? `:${port}` : ""}/${pathname}`;
}

function repositoryReference(repository) {
  const originKey = normalizeRepositoryOrigin(repository);
  if (!originKey) return "";
  return originKey.startsWith("github.com/") ? originKey.slice("github.com/".length) : originKey;
}

function sanitizePackageSource(source) {
  const parsed = parsePackageSource(source);
  let repository = parsed.repository;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(repository)) {
    const url = new URL(repository.replace(/^git\+/, ""));
    url.username = "";
    url.password = "";
    repository = url.toString().replace(/\/$/, "");
  }
  return formatPackageSource(repository, parsed.selector);
}

function isPrivateAddress(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  const family = net.isIP(host);
  if (family === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] >= 224
    );
  }
  if (family === 6) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb")
    );
  }
  return false;
}

// Catalog entries are untrusted and are hydrated without user interaction.
// Keep that path deliberately narrower than the manually entered installer.
function assertSafeCatalogPackageSource(source) {
  const parsed = parsePackageSource(source);
  const repository = parsed.repository;
  if (githubShorthandMatch(repository)) {
    return { ...parsed, originKey: normalizeRepositoryOrigin(repository) };
  }
  if (!/^https:\/\//i.test(repository)) {
    throw new Error(
      "Catalog package sources must use public HTTPS or GitHub owner/repo shorthand.",
    );
  }
  const url = new URL(repository);
  if (url.username || url.password) {
    throw new Error("Catalog package sources must not contain credentials.");
  }
  if (isPrivateAddress(url.hostname)) {
    throw new Error("Catalog package sources must not target localhost or a private network.");
  }
  const originKey = normalizeRepositoryOrigin(repository);
  if (!originKey) throw new Error(`Invalid Git repository: "${source}".`);
  return { ...parsed, originKey };
}

async function resolvePackageSource(input, lsRemote) {
  const parsed = typeof input === "string" ? parsePackageSource(input) : input;
  const cloneUrl = cloneUrlForRepository(parsed.repository);
  let { selector } = parsed;
  let sha = null;
  let fetchRef;
  let version = null;

  if (selector.type === "latest") {
    const tagsOutput = await lsRemote(cloneUrl, ["--tags"], []);
    const latestTag = selectLatestTag(parseRemoteTags(tagsOutput));
    if (latestTag) {
      selector = { type: "latest", value: latestTag.name };
      sha = latestTag.sha;
      fetchRef = `refs/tags/${latestTag.name}`;
      version = latestTag.version;
    } else {
      const refs = parseRemoteRefs(await lsRemote(cloneUrl, [], ["HEAD"]));
      sha = refs.get("HEAD") || null;
      fetchRef = "HEAD";
      selector = { type: "default", value: "HEAD" };
    }
  } else if (selector.type === "commit") {
    if (!/^[0-9a-f]{7,40}$/i.test(selector.value)) {
      throw new Error(`Invalid commit hash: "${selector.value}".`);
    }
    fetchRef = selector.value;
    if (selector.value.length === 40) sha = selector.value.toLowerCase();
  } else {
    const name = selector.value;
    const tagNames =
      selector.type === "tag" && semver.valid(name) && !name.toLowerCase().startsWith("v")
        ? [name, `v${name}`]
        : [name];
    const refs = parseRemoteRefs(
      await lsRemote(
        cloneUrl,
        [],
        [
          ...tagNames.flatMap((tagName) => [`refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]),
          `refs/heads/${name}`,
        ],
      ),
    );
    const resolvedTagName = tagNames.find(
      (tagName) => refs.has(`refs/tags/${tagName}^{}`) || refs.has(`refs/tags/${tagName}`),
    );
    const tagSha = resolvedTagName
      ? refs.get(`refs/tags/${resolvedTagName}^{}`) || refs.get(`refs/tags/${resolvedTagName}`)
      : null;
    const branchSha = refs.get(`refs/heads/${name}`);

    if (selector.type === "tag" || (selector.type === "ref" && tagSha)) {
      if (!tagSha) throw new Error(`Tag "${name}" was not found in ${parsed.repository}.`);
      selector = { type: "tag", value: resolvedTagName };
      sha = tagSha;
      fetchRef = `refs/tags/${resolvedTagName}`;
      version = semver.valid(resolvedTagName);
    } else if (selector.type === "branch" || (selector.type === "ref" && branchSha)) {
      if (!branchSha) throw new Error(`Branch "${name}" was not found in ${parsed.repository}.`);
      selector = { type: "branch", value: name };
      sha = branchSha;
      fetchRef = `refs/heads/${name}`;
    } else if (selector.type === "ref" && /^[0-9a-f]{7,40}$/i.test(name)) {
      selector = { type: "commit", value: name };
      fetchRef = name;
      if (name.length === 40) sha = name.toLowerCase();
    } else {
      throw new Error(`Ref "${name}" was not found in ${parsed.repository}.`);
    }
  }

  return {
    repository: parsed.repository,
    source: formatPackageSource(
      parsed.repository,
      selector.type === "latest" || selector.type === "default" ? null : selector,
    ),
    cloneUrl,
    selector,
    fetchRef,
    sha,
    version,
    updatePolicy: updatePolicyForSelector(selector),
  };
}

function parseRemoteTags(output) {
  const tags = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/i);
    if (!match) continue;
    const [, sha, name, peeled] = match;
    const current = tags.get(name);
    if (!current || peeled) tags.set(name, sha);
  }
  return Array.from(tags, ([name, sha]) => ({ name, sha }));
}

function selectLatestTag(tags) {
  const versions = tags
    .map((tag) => ({ ...tag, version: semver.valid(tag.name) }))
    .filter((tag) => tag.version);
  const stable = versions.filter((tag) => semver.prerelease(tag.version) == null);
  stable.sort((a, b) => semver.rcompare(a.version, b.version));
  return stable[0] || null;
}

function parseRemoteRefs(output) {
  const refs = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
    if (match) refs.set(match[2], match[1]);
  }
  return refs;
}

function parseRemoteHead(output) {
  let defaultBranch = null;
  let headSha = null;
  for (const line of String(output || "").split(/\r?\n/)) {
    const symref = line.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/);
    if (symref) defaultBranch = symref[1];
    const head = line.match(/^([0-9a-f]{40})\s+HEAD$/i);
    if (head) headSha = head[1].toLowerCase();
  }
  return { defaultBranch, headSha };
}

function parseRemoteBranches(output) {
  const branches = [];
  for (const [ref, sha] of parseRemoteRefs(output)) {
    if (ref.startsWith("refs/heads/")) {
      branches.push({ name: ref.slice("refs/heads/".length), sha: sha.toLowerCase() });
    }
  }
  return branches;
}

function sortRemoteTags(tags) {
  const stable = [];
  const prerelease = [];
  const textual = [];
  for (const tag of tags) {
    const version = semver.valid(tag.name);
    const item = { ...tag, version: version || null };
    if (!version) textual.push(item);
    else if (semver.prerelease(version) == null) stable.push(item);
    else prerelease.push(item);
  }
  stable.sort((left, right) => semver.rcompare(left.version, right.version));
  prerelease.sort((left, right) => semver.rcompare(left.version, right.version));
  textual.sort((left, right) => left.name.localeCompare(right.name));
  return [...stable, ...prerelease, ...textual];
}

async function listPackageRepositoryRefs(
  source,
  lsRemote,
  { includeBranches = false, maxRefs = MAX_REMOTE_REFS } = {},
) {
  const parsed = typeof source === "string" ? parsePackageSource(source) : source;
  const cloneUrl = cloneUrlForRepository(parsed.repository);
  const patterns = ["HEAD", "refs/tags/*"];
  if (includeBranches) patterns.push("refs/heads/*");
  const output = await lsRemote(cloneUrl, ["--symref"], patterns);
  if (Buffer.byteLength(String(output || "")) > MAX_REMOTE_OUTPUT_BYTES) {
    throw new Error("Repository ref response exceeds the safety size limit.");
  }
  const tags = sortRemoteTags(parseRemoteTags(output));
  const branches = includeBranches ? parseRemoteBranches(output) : [];
  if (tags.length + branches.length > maxRefs) {
    throw new Error(`Repository exposes more than ${maxRefs} refs; refusing a partial list.`);
  }
  const { defaultBranch, headSha } = parseRemoteHead(output);
  const latestStable =
    tags.find((tag) => tag.version && semver.prerelease(tag.version) == null) || null;
  return {
    repository: parsed.repository,
    originKey: normalizeRepositoryOrigin(parsed.repository),
    cloneUrl,
    selector: parsed.selector,
    defaultBranch,
    headSha,
    tags,
    branches: branches.sort((left, right) => {
      if (left.name === defaultBranch) return -1;
      if (right.name === defaultBranch) return 1;
      return left.name.localeCompare(right.name);
    }),
    latestStable,
  };
}

function formatPackageSource(repository, selector) {
  if (!selector || selector.type === "latest") return repository;
  return `${repository}#${selector.type}:${selector.value}`;
}

function updatePolicyForSelector(selector) {
  if (!selector || selector.type === "latest") return "latest-tag";
  if (selector.type === "default") return "default-branch";
  if (selector.type === "branch") return "branch";
  return "pinned";
}

module.exports = {
  MAX_REMOTE_REFS,
  MAX_REMOTE_OUTPUT_BYTES,
  assertSafeCatalogPackageSource,
  cloneUrlForRepository,
  formatPackageSource,
  isPrivateAddress,
  listPackageRepositoryRefs,
  normalizeRepositoryOrigin,
  parsePackageSource,
  parseRemoteBranches,
  parseRemoteHead,
  parseRemoteRefs,
  parseRemoteTags,
  repositoryReference,
  sanitizePackageSource,
  resolvePackageSource,
  selectLatestTag,
  sortRemoteTags,
  updatePolicyForSelector,
};
