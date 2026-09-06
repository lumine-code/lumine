const path = require("path");
const v8 = require("v8");
const fs = require("@lumine-code/fs-plus");
const temp = require("@lumine-code/temp").track();
const GitHost = require("../src/git-host");
const {
  GIT_HOST_STREAM_MAX_BYTES,
  GIT_HOST_STREAM_MAX_RECORDS,
} = require("../src/git-host-stream");

function copyRepository() {
  const workingDirectory = temp.mkdirSync("git-host-real-process-");
  fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
  fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
  const gitDirectory = path.join(workingDirectory, ".git");
  return {
    gitDirectory,
    workingDirectory,
    worktreeGitMarker: { path: gitDirectory, kind: "directory" },
  };
}

describe("git-host real process", () => {
  beforeEach(() => {
    GitHost.reset();
    GitHost.setForkModeForTesting(true);
    GitHost.setChildFactoryForTesting(null);
  });

  afterEach(() => {
    GitHost.reset();
    GitHost.setForkModeForTesting(null);
  });

  it("boots the worker and transports CLI results, buffers, and errors", async () => {
    const descriptor = copyRepository();
    const host = GitHost.instance();

    const execution = await host.request("exec", {
      workingDirectory: descriptor.workingDirectory,
      args: ["rev-parse", "--is-inside-work-tree"],
      options: {},
      raw: false,
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout.trim()).toBe("true");

    const [object] = await host.request("readObjects", {
      descriptor,
      requests: [{ revision: "HEAD", path: "a.txt" }],
    });
    expect(Buffer.isBuffer(object.content)).toBe(true);
    expect(object.type).toBe("blob");

    const destinationPath = path.join(descriptor.workingDirectory, "copied.txt");
    const writeResult = await host.request("writeRepositoryCommandOutput", {
      descriptor,
      args: ["cat-file", "blob", "HEAD:file.txt"],
      destinationPath,
      options: {},
    });
    expect(writeResult.stdout).toBeUndefined();
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("undefined");

    expect(
      await host.request("readConfig", {
        descriptor,
        keys: ["core.repositoryformatversion"],
      }),
    ).toEqual({ "core.repositoryformatversion": "0" });
    const history = await host.request("history", {
      descriptor,
      request: { revision: "HEAD", limit: 10, skip: 0 },
    });
    expect(history).toEqual(jasmine.any(Array));
    expect(
      await host.request("lineDiff", {
        descriptor,
        relativePosixPath: "a.txt",
        headOid: history[0].sha,
        text: "changed\n",
      }),
    ).toEqual([{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }]);

    let error;
    try {
      await host.request("diff", {
        descriptor,
        request: {
          from: { type: "commit", revision: "missing-ref" },
          to: { type: "commit", revision: "HEAD" },
          format: "structured",
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_DIFF");
    expect(error.gitCode).toBe("ERR_GIT_COMMAND_FAILED");
  });

  it("identifies a repository working directory that moved after discovery", async () => {
    const descriptor = copyRepository();
    const movedDirectory = `${descriptor.workingDirectory}-moved`;
    const host = GitHost.instance();
    let error;

    fs.renameSync(descriptor.workingDirectory, movedDirectory);
    try {
      await host.request("snapshot", {
        descriptor,
        request: { status: true, refs: false, generations: { status: 1 } },
        options: {},
      });
    } catch (caught) {
      error = caught;
    } finally {
      fs.renameSync(movedDirectory, descriptor.workingDirectory);
    }

    expect(error.code).toBe("ERR_GIT_REPOSITORY_UNAVAILABLE");
    expect(error.operation).toBe("snapshot");
    expect(error.reason).toBe("working-directory-missing");
    expect(error.gitDirectory).toBe(descriptor.gitDirectory.replace(/\\/g, "/"));
    expect(error.workingDirectory).toBe(descriptor.workingDirectory.replace(/\\/g, "/"));
  });

  it("never reads a parent repository when a nested repository marker disappears", async () => {
    const parent = copyRepository();
    const workingDirectory = path.join(parent.workingDirectory, "nested-repository");
    fs.copySync(path.join(__dirname, "fixtures", "git", "working-dir"), workingDirectory);
    fs.renameSync(path.join(workingDirectory, "git.git"), path.join(workingDirectory, ".git"));
    const gitDirectory = path.join(workingDirectory, ".git");
    const descriptor = {
      gitDirectory,
      workingDirectory,
      worktreeGitMarker: { path: gitDirectory, kind: "directory" },
    };
    fs.removeSync(gitDirectory);
    fs.writeFileSync(path.join(workingDirectory, "now-owned-by-parent.txt"), "parent data\n");
    const host = GitHost.instance();

    await expectAsync(
      host.request("snapshot", {
        descriptor,
        request: { status: true, refs: true, generations: { status: 1, refs: 1 } },
        options: {},
      }),
    ).toBeRejectedWith(
      jasmine.objectContaining({
        code: "ERR_GIT_REPOSITORY_UNAVAILABLE",
        operation: "snapshot",
        reason: "git-directory-missing",
      }),
    );
  });

  it("streams a large real status snapshot and preserves the public result", async () => {
    const descriptor = copyRepository();
    const host = GitHost.instance();
    const messages = [];
    let interceptMessage = null;
    const handleMessage = host.handleMessage.bind(host);
    host.handleMessage = (message, child) => {
      if (message?.event?.startsWith("git:reply")) {
        messages.push({
          event: message.event,
          itemCount: message.items?.length ?? 0,
          itemBytes: message.items ? v8.serialize(message.items).byteLength : 0,
        });
      }
      interceptMessage?.(message);
      return handleMessage(message, child);
    };

    const hashResult = await host.request("exec", {
      workingDirectory: descriptor.workingDirectory,
      args: ["hash-object", "-w", "--stdin"],
      options: { stdin: "" },
      raw: false,
    });
    const oid = hashResult.stdout.trim();
    const indexInfo = Array.from(
      { length: 1200 },
      (_, index) => `100644 ${oid}\tbulk/file-${index}.txt\n`,
    ).join("");
    await host.request("exec", {
      workingDirectory: descriptor.workingDirectory,
      args: ["update-index", "--index-info"],
      options: { stdin: indexInfo },
      raw: false,
    });

    const result = await host.request("snapshot", {
      descriptor,
      request: { status: true, refs: false, generations: { status: 1 } },
      options: {},
    });
    expect(result.status.value.files.filter(({ path: filePath }) => filePath.startsWith("bulk/")))
      .withContext("all streamed status records reach the public result")
      .toHaveSize(1200);

    const streamMessages = messages.filter(({ event }) => event !== "git:reply");
    expect(streamMessages.map(({ event }) => event)).toContain("git:reply-start");
    expect(streamMessages.map(({ event }) => event)).toContain("git:reply-end");
    const chunks = streamMessages.filter(({ event }) => event === "git:reply-chunk");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.itemCount).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_RECORDS);
      if (chunk.itemCount > 1) {
        expect(chunk.itemBytes).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_BYTES);
      }
    }

    messages.length = 0;
    const unchanged = await host.request("snapshot", {
      descriptor,
      request: {
        status: true,
        refs: false,
        generations: { status: 2 },
        knownFingerprints: { status: result.status.fingerprint },
      },
      options: {},
    });
    expect(unchanged.status.unchanged).toBe(true);
    expect(messages.map(({ event }) => event)).toEqual(["git:reply"]);

    const trace = [];
    const requestIds = [];
    const send = host.child.send.bind(host.child);
    host.child.send = (message, ...args) => {
      if (message?.event === "git:request" && message.op === "snapshot") {
        requestIds.push(message.id);
      }
      if (message?.event === "git:chunk-ack") {
        trace.push({ event: message.event, id: message.id });
      }
      return send(message, ...args);
    };
    const controller = new AbortController();
    let cancelled = false;
    interceptMessage = (message) => {
      if (message?.event !== "git:reply-chunk") return;
      trace.push({ event: message.event, id: message.id });
      if (!cancelled && message.id === requestIds[0]) {
        cancelled = true;
        controller.abort();
      }
    };

    const cancelledSnapshot = host.request(
      "snapshot",
      {
        descriptor,
        request: { status: true, refs: false, generations: { status: 3 } },
        options: {},
      },
      { signal: controller.signal },
    );
    await expectAsync(cancelledSnapshot).toBeRejectedWithError(Error, /aborted/);
    const followingSnapshot = host.request("snapshot", {
      descriptor,
      request: { status: true, refs: false, generations: { status: 4 } },
      options: {},
    });
    expect((await followingSnapshot).status.value.files.length).toBeGreaterThanOrEqual(1200);

    const firstChunk = trace.findIndex(
      ({ event, id: traceId }) => event === "git:reply-chunk" && traceId === requestIds[0],
    );
    const discardAck = trace.findIndex(
      ({ event, id: traceId }) => event === "git:chunk-ack" && traceId === requestIds[0],
    );
    const nextChunk = trace.findIndex(
      ({ event, id: traceId }, index) =>
        index > firstChunk && event === "git:reply-chunk" && traceId !== requestIds[0],
    );
    expect(firstChunk).toBeGreaterThanOrEqual(0);
    expect(discardAck).toBeGreaterThan(firstChunk);
    expect(nextChunk).toBeGreaterThan(discardAck);
  });

  it("streams large blob buffers and decoded strings through the real worker", async () => {
    const descriptor = copyRepository();
    const host = GitHost.instance();
    const content = Buffer.alloc(GIT_HOST_STREAM_MAX_BYTES * 3 + 137, 0x78);
    const hashResult = await host.request("exec", {
      workingDirectory: descriptor.workingDirectory,
      args: ["hash-object", "-w", "--stdin"],
      options: { stdin: content },
      raw: false,
    });
    const oid = hashResult.stdout.trim();

    const manifests = [];
    const chunks = [];
    const handleMessage = host.handleMessage.bind(host);
    host.handleMessage = (message, child) => {
      if (message?.event === "git:reply-start") manifests.push(...message.streams);
      if (message?.event === "git:reply-chunk") chunks.push(message);
      return handleMessage(message, child);
    };

    const [binary] = await host.request("readObjects", {
      descriptor,
      requests: [{ oid }],
      encoding: "buffer",
    });
    expect(Buffer.isBuffer(binary.content)).toBe(true);
    expect(binary.content).toEqual(content);
    expect(manifests.map(({ kind }) => kind)).toContain("buffer");
    expect(chunks.filter(({ items }) => Buffer.isBuffer(items)).length).toBeGreaterThan(1);

    manifests.length = 0;
    chunks.length = 0;
    const [decoded] = await host.request("readObjects", {
      descriptor,
      requests: [{ oid }],
      encoding: "utf8",
    });
    expect(decoded.content).toBe(content.toString("utf8"));
    expect(manifests.map(({ kind }) => kind)).toContain("string");
    expect(chunks.filter(({ items }) => typeof items === "string").length).toBeGreaterThan(1);
  });

  it("streams a real minified diff line larger than one object chunk", async () => {
    const descriptor = copyRepository();
    const host = GitHost.instance();
    const lineText = `const sourceMap = "${"x".repeat(GIT_HOST_STREAM_MAX_BYTES * 2)}";`;
    fs.writeFileSync(path.join(descriptor.workingDirectory, "a.txt"), `${lineText}\n`);

    const manifests = [];
    const handleMessage = host.handleMessage.bind(host);
    host.handleMessage = (message, child) => {
      if (message?.event === "git:reply-start") manifests.push(...message.streams);
      return handleMessage(message, child);
    };

    const result = await host.request("diff", {
      descriptor,
      request: {
        from: { type: "index" },
        to: { type: "worktree" },
        format: "both",
        paths: ["a.txt"],
      },
      maxBytes: 10 * 1024 * 1024,
    });

    expect(result.files).toHaveSize(1);
    expect(result.files[0].hunks).toHaveSize(1);
    const addedLines = result.files[0].hunks[0].lines.filter(({ kind }) => kind === "added");
    expect(addedLines).toEqual([{ kind: "added", text: lineText }]);
    expect(Buffer.byteLength(result.rawPatch)).toBeGreaterThan(GIT_HOST_STREAM_MAX_BYTES);
    const streamNames = manifests.map(({ name }) => name);
    expect(streamNames).toContain("diff.files");
    expect(streamNames).toContain("diff.files.0.hunks");
    expect(streamNames).toContain("diff.files.0.hunks.0.lines");
    expect(streamNames).toContain("diff.files.0.hunks.0.lines.0.text");
    expect(streamNames).toContain("diff.rawPatch");
    expect(manifests.find(({ name }) => name === "diff.files.0.hunks.0.lines.0.text").length).toBe(
      lineText.length,
    );
  });
});
