"use strict";

// Release assets may redirect to a signed storage URL. The Actions token is
// solely for the API; never forward it, or caller headers, to that storage host.
async function githubReleaseRequest(fetch, url, { accept, token, signal }) {
  const api = new URL(url);
  if (api.origin !== "https://api.github.com" || api.username || api.password) {
    throw new Error("A release credential may only be sent to the official GitHub API");
  }
  if (token && (typeof token !== "string" || /[^\x21-\x7e]/.test(token))) {
    throw new Error("Invalid GitHub release credential");
  }
  const binary = accept === "application/octet-stream";
  const response = await fetch(url, {
    headers: { Accept: accept, ...(token && { Authorization: `Bearer ${token}` }) },
    signal,
    redirect: binary ? "manual" : "error",
  });
  if (!binary || response.status !== 302) return response;
  await response.body?.cancel();
  const location = response.headers.get("location");
  if (!location) throw new Error("The GitHub release asset redirect has no location");
  const target = new URL(location);
  if (
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
      target.hostname,
    )
  ) {
    throw new Error("The GitHub release asset redirect does not identify official storage");
  }
  return fetch(location, { signal, redirect: "error" });
}

module.exports = { githubReleaseRequest };
