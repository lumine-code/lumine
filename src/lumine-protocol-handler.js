const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function resourcePathname(url) {
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\\") || pathname.includes("\0")) return null;
  const segments = pathname.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join(path.sep);
}

// A resource name belongs to the Package generation loaded in this window,
// never to a directory guessed from its name or a shadowed copy on disk.
// Electron 45 native directory sources are immutable renderer snapshots, so
// live package routes use handle() with net.fetch's native body relay. Fixed
// user assets use registerSource() without a per-request JavaScript handler.
module.exports = class LumineProtocolHandler {
  constructor({ session, assetsPath, resourcePath, safeMode = false }) {
    this.session = session;
    this.assetsPath = path.resolve(assetsPath);
    this.packages = new Map();
    this.packageHosts = new Map();
    this.beginGeneration({ resourcePath, safeMode });
    session.protocol.registerSource("lumine-assets", {
      routes: [
        {
          match: { host: "local" },
          source: {
            type: "directory",
            root: this.assetsPath,
            index: "",
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        },
      ],
    });
    session.protocol.handle("lumine", (request) => this.handleRequest(request));
  }

  beginGeneration({ resourcePath = this.resourcePath, safeMode = this.safeMode } = {}) {
    this.resourcePath = path.resolve(resourcePath);
    this.safeMode = safeMode;
    this.packages.clear();
    this.packageHosts.clear();
    this.generation = crypto.randomUUID();
    return this.generation;
  }

  updatePackage({ generation, action, name, root, owner }) {
    if (generation !== this.generation) return false;
    if (typeof name !== "string" || !name)
      throw new TypeError("A package resource needs a package name");
    // Scoped manifest names are valid package identities, but cannot be URL
    // hostnames. Preserve their lifecycle without inventing a hostname alias.
    const host = /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name.toLowerCase() : null;
    if (action === "remove") {
      // An old asynchronous unload must not erase a replacement generation.
      const pack = this.packages.get(name);
      if (pack?.owner === owner) {
        this.packages.delete(name);
        if (host && this.packageHosts.get(host) === pack) this.packageHosts.delete(host);
      }
      return true;
    }
    if (
      action !== "add" ||
      typeof root !== "string" ||
      !path.isAbsolute(root) ||
      typeof owner !== "string" ||
      !owner
    ) {
      throw new TypeError("A package resource needs an absolute root");
    }
    root = path.resolve(root);
    if (this.safeMode && !isInside(path.join(this.resourcePath, "node_modules"), root)) {
      throw new Error("Safe mode only serves bundled package resources");
    }
    // Use the same canonicalization API for root and file. On Windows the
    // synchronous realpath API may preserve 8.3 names while the async API
    // expands them, which would reject a file inside an otherwise valid root.
    const realRoot = fs.promises.realpath(root).catch(() => null);
    const pack = { name, root, realRoot, owner };
    this.packages.set(name, pack);
    if (host) this.packageHosts.set(host, pack);
    return true;
  }

  async handleRequest(request) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return Response.error();
      // Native initiatorOrigin cannot be forged by a page's Origin/Referer
      // headers. Only the trusted file-based app and browser-originated work
      // may read a package root; remote and opaque preview frames may not.
      if (request.initiatorOrigin !== undefined && request.initiatorOrigin !== "file://")
        return Response.error();
      const url = new URL(request.url);
      if (url.protocol !== "lumine:" || url.username || url.password || url.port)
        return Response.error();
      const relativePath = resourcePathname(url);
      if (!relativePath) return Response.error();
      const pack = this.packageHosts.get(url.hostname.toLowerCase());
      if (!pack) return Response.error();
      const generation = this.generation;
      const candidate = path.resolve(pack.root, relativePath);
      if (!isInside(pack.root, candidate)) return Response.error();
      const [realRoot, realPath] = await Promise.all([
        pack.realRoot,
        fs.promises.realpath(candidate),
      ]);
      if (!realRoot || !isInside(realRoot, realPath)) return Response.error();
      // An unload or navigation can race the filesystem lookup above.
      if (
        generation !== this.generation ||
        this.packageHosts.get(url.hostname.toLowerCase()) !== pack
      )
        return Response.error();
      const response = await this.session.fetch(pathToFileURL(realPath).href, {
        method: request.method,
        headers: request.headers,
      });
      if (
        generation !== this.generation ||
        this.packageHosts.get(url.hostname.toLowerCase()) !== pack
      )
        return Response.error();
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      return Response.error();
    }
  }

  dispose() {
    this.packages.clear();
    this.packageHosts.clear();
    this.generation = null;
    for (const scheme of ["lumine", "lumine-assets"]) this.session.protocol.unhandle(scheme);
  }
};
