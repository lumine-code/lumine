const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const CSON = require("@lumine-code/season");
const tar = require("tar");
const PackageInstallationService = require("../src/package-installation-service");

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("PackageInstallationService", function () {
  let root;
  let npmCalls;
  let manifest;
  let writeSourceFiles;
  let service;

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-installer-spec-"));
    npmCalls = 0;
    manifest = {
      name: "sample-package",
      version: "1.0.0",
      repository: "https://github.com/owner/repo.git",
      engines: { lumine: "*" },
    };
    // What the repository holds at the installed commit, written into whatever
    // directory the fetch puts it in — a staged checkout or an archive.
    writeSourceFiles = (directory) => {
      fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
    };
    service = new PackageInstallationService({
      packagesDirectory: root,
      gitCommand: "git",
      npmCommand: "npm",
      run: async (command, args, options) => {
        if (command === "git" && args[0] === "checkout") {
          writeSourceFiles(options.cwd);
          fs.mkdirSync(path.join(options.cwd, ".git"));
        }
        if (command === "npm") npmCalls++;
        return { stdout: "" };
      },
      capture: async () => ({ stdout: SHA }),
      resolveSource: async () => {
        throw new Error("moving refs must not be resolved for a hydrated card");
      },
      fetchUrl: async () => tarballResponse(),
      lumineVersion: "1.132.1",
    });
  });

  afterEach(function () {
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // A GitHub archive of the installed commit: one root directory holding the
  // repository's files, gzipped, served as a fetch response. `archivedSha`
  // states which commit the archive says it holds.
  function tarballResponse({ archivedSha } = {}) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-installer-archive-"));
    const rootName = `repo-${SHA}`;
    fs.mkdirSync(path.join(scratch, rootName));
    writeSourceFiles(path.join(scratch, rootName));
    const archivePath = path.join(scratch, "archive.tar");
    tar.c({ sync: true, cwd: scratch, file: archivePath }, [rootName]);
    let body = fs.readFileSync(archivePath);
    if (archivedSha) body = Buffer.concat([paxGlobalHeader(archivedSha), body]);
    body = zlib.gzipSync(body);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }

  // The two blocks a `git archive` puts first: a header of type "g" and the
  // extended records it announces, of which only `comment` matters here.
  function paxGlobalHeader(sha) {
    let record = "";
    for (let length = 1; length < 512; length++) {
      const candidate = `${length} comment=${sha}\n`;
      if (candidate.length === length) {
        record = candidate;
        break;
      }
    }

    const header = Buffer.alloc(512, 0);
    header.write("pax_global_header", 0, "ascii");
    header.write("0000644\0", 100, "ascii"); // mode
    header.write("0000000\0", 108, "ascii"); // uid
    header.write("0000000\0", 116, "ascii"); // gid
    header.write(`${record.length.toString(8).padStart(11, "0")}\0`, 124, "ascii"); // size
    header.write("00000000000\0", 136, "ascii"); // mtime
    header.write("        ", 148, "ascii"); // checksum, blank while it is summed
    header.write("g", 156, "ascii"); // type
    header.write("ustar\0" + "00", 257, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

    const payload = Buffer.alloc(512, 0);
    payload.write(record, 0, "ascii");
    return Buffer.concat([header, payload]);
  }

  function pack(overrides = {}) {
    return {
      name: "sample-package",
      repository: "owner/repo",
      installSource: "owner/repo",
      resolvedSha: SHA,
      selectedRef: { type: "latest", value: "v1.0.0" },
      updatePolicy: "latest-tag",
      ...overrides,
    };
  }

  it("installs the exact hydrated SHA and writes an origin receipt", async () => {
    const installed = await service.install(pack());
    const written = JSON.parse(fs.readFileSync(path.join(installed.target, "package.json")));
    expect(npmCalls).toBe(1);
    expect(installed.resolvedSha).toBe(SHA);
    expect(written.apmInstallSource).toEqual(
      jasmine.objectContaining({
        origin: "github.com/owner/repo",
        updatePolicy: "latest-tag",
        sha: SHA,
      }),
    );
    expect(fs.existsSync(path.join(installed.target, ".git"))).toBe(false);
  });

  it("uses a temporary package.json to install a JSONC manifest", async () => {
    writeSourceFiles = (directory) => {
      fs.writeFileSync(
        path.join(directory, "package.jsonc"),
        `// the manifest
${JSON.stringify(manifest, null, 2)}
`,
      );
    };
    const originalRun = service.run;
    service.run = async (command, args, options) => {
      const result = await originalRun(command, args, options);
      if (command === "npm") {
        expect(fs.existsSync(path.join(options.cwd, "package.json"))).toBe(true);
      }
      return result;
    };

    const installed = await service.install(pack());
    expect(fs.existsSync(path.join(installed.target, "package.json"))).toBe(false);
    const written = CSON.readFileSync(path.join(installed.target, "package.jsonc"));
    expect(written.apmInstallSource.sha).toBe(SHA);
  });

  it("downloads a GitHub package as an archive of the resolved commit", async () => {
    const requested = [];
    service.fetchUrl = async (url) => {
      requested.push(url);
      return tarballResponse();
    };
    const gitCalls = [];
    const originalRun = service.run;
    service.run = async (command, args, options) => {
      gitCalls.push(command);
      return originalRun(command, args, options);
    };

    const installed = await service.install(pack());
    // The commit addresses the archive, never the tag that resolved to it.
    expect(requested).toEqual([`https://codeload.github.com/owner/repo/tar.gz/${SHA}`]);
    expect(gitCalls).toEqual(["npm"]);
    expect(installed.resolvedSha).toBe(SHA);
    const written = JSON.parse(fs.readFileSync(path.join(installed.target, "package.json")));
    expect(written.apmInstallSource.sha).toBe(SHA);
  });

  it("fetches a package hosted anywhere else with git", async () => {
    manifest.repository = "https://git.example.test/owner/repo.git";
    service.fetchUrl = async () => {
      throw new Error("a non-GitHub package has no archive to download");
    };
    const gitCalls = [];
    const originalRun = service.run;
    service.run = async (command, args, options) => {
      if (command === "git") gitCalls.push(args[0]);
      return originalRun(command, args, options);
    };

    const installed = await service.install(
      pack({
        repository: "https://git.example.test/owner/repo.git",
        installSource: "https://git.example.test/owner/repo.git#tag:v1.0.0",
        selectedRef: { type: "tag", value: "v1.0.0" },
      }),
    );
    expect(gitCalls).toEqual(["init", "remote", "fetch", "checkout"]);
    expect(fs.existsSync(path.join(installed.target, ".git"))).toBe(false);
    expect(installed.metadata.apmInstallSource.origin).toBe("git.example.test/owner/repo");
  });

  it("rejects a mismatched manifest before npm runs", async () => {
    manifest.repository = "different/repository";
    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("does not match install origin");
        expect(npmCalls).toBe(0);
      },
    );
  });

  it("rejects a semantic tag whose manifest version differs", async () => {
    manifest.version = "2.0.0";
    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("does not match package version");
        expect(npmCalls).toBe(0);
      },
    );
  });

  it("blocks another community origin unless Replace is explicit", async () => {
    const target = path.join(root, "sample-package");
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(target, "package.json"),
      JSON.stringify({
        name: "sample-package",
        repository: "other/repo",
        engines: { lumine: "*" },
      }),
    );
    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("Use Replace");
        expect(npmCalls).toBe(0);
      },
    );
  });

  it("treats a linked package directory as an occupied install slot", async () => {
    const linkedSource = fs.mkdtempSync(path.join(os.tmpdir(), "lumine-linked-slot-"));
    fs.writeFileSync(
      path.join(linkedSource, "package.json"),
      JSON.stringify({
        name: "sample-package",
        repository: "other/repo",
        engines: { lumine: "*" },
      }),
    );
    fs.symlinkSync(
      linkedSource,
      path.join(root, "sample-package"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await service
      .install(pack())
      .then(
        () => Promise.reject(new Error("expected rejection")),
        (error) => expect(error.message).toContain("Use Replace"),
      )
      .finally(() =>
        fs.rmSync(linkedSource, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
      );
  });

  it("requires uninstall when another ref of the same origin changes its package name", async () => {
    const oldSlot = path.join(root, "old-package-name");
    fs.mkdirSync(oldSlot);
    fs.writeFileSync(
      path.join(oldSlot, "package.json"),
      JSON.stringify({
        name: "old-package-name",
        repository: "owner/repo",
        engines: { lumine: "*" },
        apmInstallSource: { type: "git", origin: "github.com/owner/repo" },
      }),
    );

    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => expect(error.message).toContain('already installed as "old-package-name"'),
    );
  });

  it("replaces the directory an installed package occupies, whatever it is called", async () => {
    const existing = path.join(root, "sample-package-checkout");
    fs.mkdirSync(existing);
    fs.writeFileSync(
      path.join(existing, "package.json"),
      JSON.stringify({
        name: "sample-package",
        version: "0.9.0",
        repository: "owner/repo",
        engines: { lumine: "*" },
        apmInstallSource: { type: "git", origin: "github.com/owner/repo", sha: "b".repeat(40) },
      }),
    );

    const installed = await service.install(pack());
    // Updating in place, rather than leaving the old directory next to a
    // new one that would shadow it.
    expect(installed.target).toBe(existing);
    expect(fs.existsSync(path.join(root, "sample-package"))).toBe(false);
    const written = JSON.parse(fs.readFileSync(path.join(existing, "package.json")));
    expect(written.version).toBe("1.0.0");
    expect(written.apmInstallSource.sha).toBe(SHA);
  });

  it("refuses an archive whose commit is not the one that was resolved", async () => {
    // GitHub states the commit an archive was made from in its pax global
    // header; a moved tag would deliver a different one.
    service.fetchUrl = async () => tarballResponse({ archivedSha: "c".repeat(40) });

    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("Repository ref changed while installing");
        expect(npmCalls).toBe(0);
      },
    );
  });

  describe("::removePath()", function () {
    // A linked package points at a working copy that belongs to the user.
    // Removing the package removes the link and nothing behind it.
    function linkedPackage(kind) {
      const source = path.join(root, `source-${kind}`);
      const link = path.join(root, `link-${kind}`);
      fs.mkdirSync(path.join(source, "lib"), { recursive: true });
      fs.writeFileSync(path.join(source, "package.json"), "{}");
      fs.writeFileSync(path.join(source, "lib", "main.js"), "module.exports = {};");
      fs.symlinkSync(source, link, kind);
      return { source, link };
    }

    it("removes a link without touching what it points at", async () => {
      // "junction" on Windows, a directory symlink everywhere else: both are
      // what `lumine --link` creates on their platform.
      const kind = process.platform === "win32" ? "junction" : "dir";
      const { source, link } = linkedPackage(kind);

      await PackageInstallationService.removePath(link);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.readdirSync(source).sort()).toEqual(["lib", "package.json"]);
      expect(fs.existsSync(path.join(source, "lib", "main.js"))).toBe(true);
    });

    it("removes a real package directory and everything in it", async () => {
      const packagePath = path.join(root, "a-package");
      fs.mkdirSync(path.join(packagePath, "lib"), { recursive: true });
      fs.writeFileSync(path.join(packagePath, "lib", "main.js"), "module.exports = {};");

      await PackageInstallationService.removePath(packagePath);
      expect(fs.existsSync(packagePath)).toBe(false);
    });

    it("does nothing for a path that is already gone", async () => {
      await PackageInstallationService.removePath(path.join(root, "nothing-here"));
    });
  });

  it("sweeps the directories an interrupted install left behind", async () => {
    const stage = path.join(root, ".lumine-stage-abc123");
    const backup = path.join(root, ".lumine-backup-sample-package-1-2");
    const keep = path.join(root, "sample-package");
    for (const directory of [stage, backup, keep]) fs.mkdirSync(directory);

    const swept = await PackageInstallationService.sweep(root);
    expect(swept.sort()).toEqual([backup, stage].sort());
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("does not reload an existing package when preparation fails before unloading", async () => {
    const originalRun = service.run;
    service.run = async (command, args, options) => {
      if (command === "npm") throw new Error("npm failed");
      return originalRun(command, args, options);
    };
    spyOn(service, "beforeSwap").and.callThrough();
    spyOn(service, "afterRollback").and.callThrough();

    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("npm failed");
        expect(service.beforeSwap).not.toHaveBeenCalled();
        expect(service.afterRollback).not.toHaveBeenCalled();
      },
    );
  });

  it("restores the old directory when the atomic swap fails", async () => {
    const target = path.join(root, "sample-package");
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(target, "package.json"),
      JSON.stringify({
        name: "sample-package",
        repository: "other/repo",
        engines: { lumine: "*" },
      }),
    );
    fs.writeFileSync(path.join(target, "old-marker"), "old");
    const originalRename = fs.promises.rename;
    let renameCalls = 0;
    spyOn(fs.promises, "rename").and.callFake((from, to) => {
      renameCalls++;
      if (renameCalls === 2) return Promise.reject(new Error("swap failed"));
      return originalRename(from, to);
    });

    await service.install(pack(), { allowReplace: true }).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("swap failed");
        expect(fs.readFileSync(path.join(target, "old-marker"), "utf8")).toBe("old");
      },
    );
  });

  it("reloads the previous package with its receipt intact after a failed update rolls back", async () => {
    // An update reinstalls the same origin at a new SHA. If the swap fails after
    // the active instance was unloaded, the rollback must both restore the old
    // directory (and its receipt) and reload the instance it unloaded.
    const target = path.join(root, "sample-package");
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(target, "package.json"),
      JSON.stringify({
        name: "sample-package",
        version: "0.9.0",
        repository: "owner/repo",
        engines: { lumine: "*" },
        apmInstallSource: {
          type: "git",
          origin: "github.com/owner/repo",
          sha: "b".repeat(40),
        },
      }),
    );
    fs.writeFileSync(path.join(target, "old-marker"), "old");

    spyOn(service, "beforeSwap").and.callThrough();
    spyOn(service, "afterSwap").and.callThrough();
    spyOn(service, "afterRollback").and.callThrough();

    const originalRename = fs.promises.rename;
    let renameCalls = 0;
    spyOn(fs.promises, "rename").and.callFake((from, to) => {
      renameCalls++;
      if (renameCalls === 2) return Promise.reject(new Error("swap failed"));
      return originalRename(from, to);
    });

    await service.install(pack()).then(
      () => Promise.reject(new Error("expected rejection")),
      (error) => {
        expect(error.message).toContain("swap failed");
        // The active instance was unloaded, so rollback must reload it and
        // must not run the success path.
        expect(service.beforeSwap).toHaveBeenCalledWith("sample-package", target);
        expect(service.afterRollback).toHaveBeenCalled();
        expect(service.afterRollback.calls.argsFor(0)[0]).toBe("sample-package");
        expect(service.afterSwap).not.toHaveBeenCalled();
        // The previous directory and its receipt are restored unchanged.
        expect(fs.readFileSync(path.join(target, "old-marker"), "utf8")).toBe("old");
        const restored = JSON.parse(fs.readFileSync(path.join(target, "package.json")));
        expect(restored.version).toBe("0.9.0");
        expect(restored.apmInstallSource.sha).toBe("b".repeat(40));
      },
    );
  });
});
