// Git transport addresses and a forge's browser URLs are separate protocols.
// Parse the transport once, discard credentials, and retain the entire namespace.
function parseGitRemote(remote) {
  const value = typeof remote === "string" ? remote.trim() : "";
  if (!value || /^[a-z]:/i.test(value) || value.startsWith("/")) return null;

  let transport, host, port, repositoryPath, webAuthority;
  const scp = /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/\\]+):(.+)$/.exec(value);
  if (!value.includes("://") && scp) {
    transport = "ssh";
    host = scp[1].toLowerCase();
    try {
      if (new URL(`ssh://${host}`).hostname !== host) return null;
    } catch {
      return null;
    }
    port = null;
    repositoryPath = scp[2];
    webAuthority = host;
  } else {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    transport = url.protocol.slice(0, -1);
    if (!["http", "https", "ssh", "git"].includes(transport) || !url.hostname) return null;
    host = url.hostname.toLowerCase();
    port = url.port || null;
    repositoryPath = url.pathname;
    webAuthority = ["http", "https"].includes(transport) ? url.host : host;
  }

  repositoryPath = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = repositoryPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  const repository = segments.pop();
  const namespace = segments.join("/");
  const webProtocol = transport === "http" ? "http" : "https";
  return Object.freeze({
    transport,
    host,
    port,
    namespace,
    repository,
    path: repositoryPath,
    webURL: `${webProtocol}://${webAuthority}/${repositoryPath}`,
  });
}

module.exports = { parseGitRemote };
