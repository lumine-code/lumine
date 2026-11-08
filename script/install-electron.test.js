"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { installElectron, releaseAssetFetch } = require("./install-electron");

async function install(results) {
  let attempts = 0;
  const waits = [];
  const messages = [];
  const status = await installElectron({
    runInstaller: () => {
      const result = results[attempts++];
      assert.ok(result, "the installer must not run more times than expected");
      return result;
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    report: (message) => messages.push(message),
  });
  return { status, attempts, waits, messages };
}

test("an installed Electron needs only one attempt", async () => {
  const result = await install([{ status: 0 }]);
  assert.equal(result.status, 0);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.waits, []);
});

for (const failure of [
  "HTTPError: Response code 500 (Internal Server Error) for https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-linux-x64.zip\n",
  "HTTPError: Response code 429 (Too Many Requests)\n",
  "HTTPError: Response code 408 (Request Timeout)\n",
  "TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13\n    at async FetchDownloader.download\n",
  "TypeError: fetch failed\n  cause: Error: read ECONNRESET\n",
  "TypeError: fetch failed\n  code: 'EAI_AGAIN'\n",
]) {
  test(`a temporary download failure is retried: ${failure.split("\n")[0]}`, async () => {
    const result = await install([{ status: 1, stderr: failure }, { status: 0 }]);
    assert.equal(result.status, 0);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.waits, [2000]);
    assert.equal(result.messages[0], failure);
  });
}

test("persistent download errors remain failures after three attempts", async () => {
  const failure = { status: 7, stderr: "HTTPError: Response code 503 (Service Unavailable)\n" };
  const result = await install([failure, failure, failure]);
  assert.equal(result.status, 7);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.waits, [2000, 4000]);
  assert.equal(result.messages.filter((message) => message === failure.stderr).length, 3);
});

for (const stderr of [
  "HTTPError: Response code 404 (Not Found)\n",
  "HTTPError: Response code 403 (Forbidden)\n",
  "Error: checksum mismatch\n",
  "Error: Cannot find module '@electron/get'\n",
  "Error: EACCES: permission denied\n",
]) {
  test(`a permanent installer failure is not retried: ${stderr.trim()}`, async () => {
    const result = await install([{ status: 1, stderr }]);
    assert.equal(result.status, 1);
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.waits, []);
    assert.deepEqual(result.messages, [stderr]);
  });
}

test("a failed process launch is reported without retrying", async () => {
  const error = new Error("spawn failed");
  const result = await install([{ status: null, error }]);
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.waits, []);
  assert.match(result.messages[0], /spawn failed/);
});

test("a terminated installer is not retried even after a network error", async () => {
  const result = await install([
    { status: null, signal: "SIGTERM", stderr: "HTTPError: Response code 500\n" },
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.waits, []);
  assert.match(result.messages[1], /SIGTERM/);
});

const releaseURL =
  "https://github.com/electron/electron/releases/download/v45.2.3/electron-v45.2.3-win32-x64.zip";
const releaseAPI = "https://api.github.com/repos/electron/electron/releases";
const releaseAsset = {
  id: 123,
  name: "electron-v45.2.3-win32-x64.zip",
  browser_download_url: releaseURL,
};

function releaseDownload(first, metadata = { tag_name: "v45.2.3", assets: [releaseAsset] }) {
  const requests = [];
  const messages = [];
  const bytes = new Response("archive bytes");
  const fetch = releaseAssetFetch(
    async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        if (first instanceof Error) throw first;
        return first;
      }
      if (requests.length === 2) return Response.json(metadata);
      assert.equal(requests.length, 3, "only one alternative asset request is allowed");
      return bytes;
    },
    (message) => messages.push(message),
  );
  return { fetch, requests, messages, bytes };
}

for (const status of [408, 429, 500, 504, 599]) {
  test(`the same official release asset uses the API after HTTP ${status}`, async () => {
    const initial = new Response("temporary failure", { status });
    const download = releaseDownload(initial);
    const result = await download.fetch(releaseURL, { headers: { Authorization: "private" } });
    assert.equal(result, download.bytes);
    assert.equal(initial.body.locked, false);
    assert.equal(initial.bodyUsed, true);
    assert.deepEqual(
      download.requests.map(({ url }) => url),
      [releaseURL, `${releaseAPI}/tags/v45.2.3`, `${releaseAPI}/assets/123`],
    );
    assert.deepEqual(download.requests[1].options.headers, {
      Accept: "application/vnd.github+json",
    });
    assert.deepEqual(download.requests[2].options.headers, {
      Accept: "application/octet-stream",
    });
    assert.equal(download.requests[2].options.signal, download.requests[1].options.signal);
    assert.equal(download.messages.length, 1);
  });
}

test("a rejected official download can use the same API asset", async () => {
  const download = releaseDownload(new TypeError("fetch failed"));
  assert.equal(await download.fetch(releaseURL), download.bytes);
  assert.equal(download.requests.length, 3);
});

for (const status of [200, 403, 404]) {
  test(`HTTP ${status} does not use an alternative release transport`, async () => {
    const initial = new Response("original response", { status });
    const download = releaseDownload(initial);
    assert.equal(await download.fetch(releaseURL), initial);
    assert.equal(await initial.text(), "original response");
    assert.equal(download.requests.length, 1);
  });
}

for (const url of [
  "https://mirror.example/electron/v45.2.3/electron.zip",
  "https://github.com/other/electron/releases/download/v45.2.3/electron.zip",
  "https://github.com/electron/electron/releases/download/v45.2.3/electron.zip?custom=1",
]) {
  test(`a custom download is left to the caller: ${url}`, async () => {
    const initial = new Response("temporary failure", { status: 504 });
    const download = releaseDownload(initial);
    assert.equal(await download.fetch(url), initial);
    assert.equal(download.requests.length, 1);
  });
}

test("HEAD requests are passed through without an API download", async () => {
  const initial = new Response(null, { status: 504 });
  const download = releaseDownload(initial);
  assert.equal(await download.fetch(releaseURL, { method: "HEAD" }), initial);
  assert.equal(download.requests.length, 1);
});

test("cancellation prevents an alternative asset request", async () => {
  const controller = new AbortController();
  controller.abort();
  const error = new TypeError("fetch failed");
  const download = releaseDownload(error);
  await assert.rejects(download.fetch(releaseURL, { signal: controller.signal }), error);
  assert.equal(download.requests.length, 1);
});

test("non-network exceptions remain failures", async () => {
  const error = new Error("permission denied");
  const download = releaseDownload(error);
  await assert.rejects(download.fetch(releaseURL), error);
  assert.equal(download.requests.length, 1);
});

for (const metadata of [
  { tag_name: "v45.2.2", assets: [releaseAsset] },
  { tag_name: "v45.2.3", assets: [] },
  { tag_name: "v45.2.3", assets: [releaseAsset, releaseAsset] },
  { tag_name: "v45.2.3", assets: [{ ...releaseAsset, browser_download_url: "https://other/" }] },
  { tag_name: "v45.2.3", assets: [{ ...releaseAsset, id: "123" }] },
  { tag_name: "v45.2.3", assets: [{ ...releaseAsset, id: -1 }] },
]) {
  test(`unmatched release metadata cannot select another asset: ${JSON.stringify(metadata)}`, async () => {
    const download = releaseDownload(new Response(null, { status: 504 }), metadata);
    await assert.rejects(download.fetch(releaseURL), /official Electron release/);
    assert.equal(download.requests.length, 2);
  });
}

for (const status of [403, 404, 408, 429, 503]) {
  test(`metadata HTTP ${status} preserves upstream failure handling without a download`, async () => {
    let requests = 0;
    const metadata = new Response(null, { status });
    const fetch = releaseAssetFetch(async () => {
      requests++;
      return requests === 1 ? new Response(null, { status: 504 }) : metadata;
    });
    assert.equal(await fetch(releaseURL), metadata);
    assert.equal(requests, 2);
  });
}
