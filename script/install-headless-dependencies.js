"use strict";

const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url"),
  { spawnSync } = require("node:child_process");
const PACKAGES = Object.freeze([
  "xvfb",
  "libx11-dev",
  "libxkbfile-dev",
  "libsecret-1-dev",
  "fonts-noto-cjk",
]);
const BUDGETS = Object.freeze({
  update: 90,
  download: 180,
  install: 180,
  killGrace: 10,
});
const MIRROR_SOURCE = "mirror+file:/etc/apt/apt-mirrors.txt";
const requireValue = (value, message) => {
  if (!value) throw new Error(message);
};

function officialUri(uri) {
  if (uri === MIRROR_SOURCE || uri === "mirror+file:///etc/apt/apt-mirrors.txt")
    return "mirrorlist";
  let value;
  try {
    value = new URL(uri);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(value.protocol) ||
    value.username ||
    value.password ||
    value.port ||
    value.search ||
    value.hash
  )
    return null;
  const host = value.hostname.toLowerCase(),
    pathname = value.pathname.replace(/\/$/, "");
  if (
    pathname === "/ubuntu" &&
    (["archive.ubuntu.com", "azure.archive.ubuntu.com", "security.ubuntu.com"].includes(host) ||
      /^[a-z]{2}\.archive\.ubuntu\.com$/.test(host))
  )
    return host === "security.ubuntu.com" ? "security" : "archive";
  if (host === "ports.ubuntu.com" && pathname === "/ubuntu-ports") return "ports";
  return null;
}
function mappedUri(uri, fallback, privateMirrorUri) {
  const kind = officialUri(uri);
  requireValue(kind, "Unsupported Ubuntu archive URI");
  if (!fallback) return kind === "mirrorlist" ? privateMirrorUri : uri;
  return kind === "ports"
    ? "https://ports.ubuntu.com/ubuntu-ports"
    : kind === "security"
      ? "https://security.ubuntu.com/ubuntu"
      : "https://archive.ubuntu.com/ubuntu";
}
function rejectTrustBypass(text) {
  const active = text.replace(/^#[^\r\n]*/gm, "");
  for (const match of active.matchAll(
    /\b(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)\s*[:=]\s*([^\s\]]*)/gi,
  )) {
    const value = match[1].replace(/^(["'])(.*)\1$/, "$2");
    requireValue(
      /^(?:no|false|without|off|disable|[+-]?(?:0+|0x0+))$/i.test(value),
      "Selected source disables archive verification or has an unsupported trust value",
    );
  }
}
function mirrorList(text) {
  const active = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  requireValue(active.length > 0, "Empty Ubuntu mirror list");
  requireValue(
    active.every((line) => {
      const kind = officialUri(line.split(/\s/)[0]);
      return kind && kind !== "mirrorlist";
    }),
    "Mirror list contains a non-Ubuntu endpoint",
  );
  return text;
}
function usesRunnerMirrorList(files) {
  return files.some(
    (file) =>
      file.text.includes(MIRROR_SOURCE) ||
      file.text.includes("mirror+file:///etc/apt/apt-mirrors.txt"),
  );
}

function selectSources(files, privateMirrorUri, fallback = false) {
  const lists = [],
    blocks = [];
  for (const file of files) {
    if (file.name.endsWith(".sources"))
      for (const block of file.text.split(/\r?\n\s*\r?\n/)) {
        const lines = block.split(/\r?\n/),
          at = lines.findIndex((line) => /^URIs:/i.test(line));
        if (at < 0) continue;
        let last = at + 1;
        while (last < lines.length && (/^[ \t]+/.test(lines[last]) || /^#/.test(lines[last])))
          last++;
        const uris = [
            lines[at].replace(/^URIs:\s*/i, ""),
            ...lines
              .slice(at + 1, last)
              .filter((line) => !/^#/.test(line))
              .map((line) => line.trim()),
          ]
            .join(" ")
            .split(/\s+/)
            .filter(Boolean),
          selected = uris.map(officialUri);
        if (!selected.some(Boolean)) continue;
        requireValue(selected.every(Boolean), "Mixed Ubuntu and third-party URI stanza");
        rejectTrustBypass(block);
        lines.splice(
          at,
          last - at,
          "URIs: " + uris.map((uri) => mappedUri(uri, fallback, privateMirrorUri)).join(" "),
          ...lines.slice(at + 1, last).filter((line) => /^#/.test(line)),
        );
        blocks.push(lines.join("\n"));
      }
    else
      for (const line of file.text.split(/\r?\n/)) {
        const match = /^(\s*deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?)(\S+)(\s+.+)$/.exec(line);
        if (!match || !officialUri(match[2])) continue;
        rejectTrustBypass(line);
        lists.push(match[1] + mappedUri(match[2], fallback, privateMirrorUri) + match[3]);
      }
  }
  requireValue(lists.length + blocks.length > 0, "No official Ubuntu source available");
  return { list: lists.join("\n") + "\n", sources: blocks.join("\n\n") + "\n" };
}
function systemSources(root = "/etc/apt") {
  const result = [],
    main = path.join(root, "sources.list"),
    parts = path.join(root, "sources.list.d");
  if (fs.existsSync(main))
    result.push({ name: "sources.list", text: fs.readFileSync(main, "utf8") });
  if (fs.existsSync(parts))
    for (const name of fs.readdirSync(parts).sort())
      if (/\.(?:list|sources)$/.test(name))
        result.push({
          name,
          text: fs.readFileSync(path.join(parts, name), "utf8"),
        });
  return result;
}
function prepareSources(files, mirrors, workspace) {
  const privateMirror = path.join(workspace, "ubuntu-mirrors.txt");
  fs.chmodSync(workspace, 0o755);
  if (usesRunnerMirrorList(files))
    fs.writeFileSync(privateMirror, mirrorList(mirrors), { mode: 0o644 });
  const result = [];
  for (const [name, fallback] of [
    ["configured", false],
    ["official-fallback", true],
  ]) {
    const directory = path.join(workspace, name),
      parts = path.join(directory, "sources.list.d"),
      lists = path.join(directory, "lists");
    for (const file of [directory, parts, lists]) {
      fs.mkdirSync(file, { recursive: true, mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    const selected = selectSources(files, "mirror+" + pathToFileURL(privateMirror).href, fallback),
      list = path.join(directory, "sources.list");
    fs.writeFileSync(list, selected.list, { mode: 0o644 });
    fs.writeFileSync(path.join(parts, "ubuntu.sources"), selected.sources, {
      mode: 0o644,
    });
    result.push({
      name,
      list,
      parts,
      lists,
      cache: path.join(directory, "pkgcache.bin"),
      sourceCache: path.join(directory, "srcpkgcache.bin"),
    });
  }
  return result;
}
function aptOptions(layout) {
  return [
    "-o",
    "Acquire::Retries=0",
    "-o",
    "Acquire::http::Timeout=30",
    "-o",
    "Acquire::https::Timeout=30",
    "-o",
    "DPkg::Lock::Timeout=60",
    "-o",
    "APT::Update::Error-Mode=any",
    "-o",
    "APT::Get::AllowUnauthenticated=false",
    "-o",
    "Acquire::AllowInsecureRepositories=false",
    "-o",
    "Acquire::AllowDowngradeToInsecureRepositories=false",
    "-o",
    `Dir::Etc::sourcelist=${layout.list}`,
    "-o",
    `Dir::Etc::sourceparts=${layout.parts}`,
    "-o",
    `Dir::State::lists=${layout.lists}`,
    "-o",
    `Dir::Cache::pkgcache=${layout.cache}`,
    "-o",
    `Dir::Cache::srcpkgcache=${layout.sourceCache}`,
  ];
}
function commandFor(args, budget) {
  requireValue(Number.isInteger(budget) && budget > 0, "Invalid APT budget");
  return [
    "sudo",
    [
      "env",
      "DEBIAN_FRONTEND=noninteractive",
      "timeout",
      "--signal=TERM",
      `--kill-after=${BUDGETS.killGrace}s`,
      `${budget}s`,
      "apt-get",
      ...args,
    ],
  ];
}
function runApt(args, budget) {
  const [command, argv] = commandFor(args, budget),
    result = spawnSync(command, argv, {
      stdio: "inherit",
      env: { ...process.env },
      timeout: (budget + BUDGETS.killGrace + 5) * 1000,
    });
  return { code: result.status ?? 1, error: result.error?.message };
}
function installHeadless(layouts, run = runApt, log = console.log) {
  for (const layout of layouts) {
    const options = aptOptions(layout);
    log(`APT metadata: ${layout.name}; wall budget ${BUDGETS.update}s`);
    const updated = run([...options, "update"], BUDGETS.update);
    if (updated.code !== 0) {
      log(`::warning::APT metadata failed on ${layout.name}; trying next official source.`);
      continue;
    }
    // A timed-out download cannot interrupt dpkg: installation begins only
    // after an entire authenticated download has completed successfully.
    log(`APT download: ${layout.name}; wall budget ${BUDGETS.download}s`);
    const fetched = run(
      [...options, "--download-only", "install", "-y", ...PACKAGES],
      BUDGETS.download,
    );
    if (fetched.code !== 0) {
      log(`::warning::APT download failed on ${layout.name}; trying next official source.`);
      continue;
    }
    log(`APT cached install; wall budget ${BUDGETS.install}s`);
    const installed = run(
      [...options, "--no-download", "install", "-y", ...PACKAGES],
      BUDGETS.install,
    );
    requireValue(
      installed.code === 0,
      "Authenticated cached installation failed; no installation retry is attempted.",
    );
    return { source: layout.name, packages: [...PACKAGES] };
  }
  throw new Error("APT download failed on configured and official fallback sources.");
}
function main() {
  requireValue(process.platform === "linux", "This dependency preparation runs only on Linux.");
  requireValue(process.argv.length === 2, "No arguments are accepted.");
  const files = systemSources(),
    mirrors = usesRunnerMirrorList(files)
      ? fs.readFileSync("/etc/apt/apt-mirrors.txt", "utf8")
      : "",
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-apt-"));
  installHeadless(prepareSources(files, mirrors, workspace));
}
module.exports = {
  PACKAGES,
  BUDGETS,
  officialUri,
  mirrorList,
  selectSources,
  prepareSources,
  aptOptions,
  commandFor,
  installHeadless,
};
if (require.main === module)
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
