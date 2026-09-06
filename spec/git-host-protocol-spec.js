const v8 = require("v8");
const {
  GIT_HOST_REQUEST_STREAM_MAX_LENGTH,
  GIT_HOST_ERROR_MAX_CAUSE_DEPTH,
  GIT_HOST_ERROR_TEXT_MAX_BYTES,
  GIT_HOST_ERROR_TOTAL_MAX_BYTES,
  GIT_HOST_PROTOCOL_VERSION,
  GitHostMessageEvents,
  GitHostOperations,
  assertKnownOperation,
  reviveError,
  serializeError,
} = require("../src/git-host-protocol");
const {
  GIT_HOST_STREAM_MAX_BYTES,
  GIT_HOST_STREAM_MAX_RECORDS,
  GIT_HOST_STREAM_MAX_STRING_BYTES,
  appendReplyChunk,
  initializeReplyStream,
  nextReplyChunk,
  prepareRequestStream,
  prepareReplyStream,
  prepareSnapshotStream,
  streamManifest,
  validateRequestStreamManifest,
} = require("../src/git-host-stream");

function reassemble(plan) {
  const descriptors = plan.streams.map(streamManifest);
  const initialized = new Set();
  for (const descriptor of descriptors) {
    const state = initializeReplyStream(plan.result, descriptor);
    plan.result = state.result;
    if (state.initialized) initialized.add(descriptor.name);
  }
  for (let streamIndex = 0; streamIndex < plan.streams.length; streamIndex++) {
    const stream = plan.streams[streamIndex];
    const descriptor = descriptors[streamIndex];
    for (let offset = 0; offset < stream.length;) {
      if (!initialized.has(descriptor.name)) {
        const state = initializeReplyStream(plan.result, descriptor);
        expect(state.initialized).toBe(true);
        plan.result = state.result;
        initialized.add(descriptor.name);
      }
      const chunk = nextReplyChunk(stream, offset);
      expect(chunk.length).toBeGreaterThan(0);
      if (stream.kind !== "array" || chunk.length > 1) {
        expect(v8.serialize(chunk).byteLength).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_BYTES);
      }
      plan.result = appendReplyChunk(plan.result, descriptor, offset, chunk);
      offset += chunk.length;
    }
  }
  return plan.result;
}

describe("git-host protocol", () => {
  it("keeps chunked replies in protocol v1", () => {
    expect(GIT_HOST_PROTOCOL_VERSION).toBe(1);
    expect(GitHostMessageEvents).toEqual(
      jasmine.objectContaining({
        REQUEST_START: "git:request-start",
        REQUEST_CHUNK: "git:request-chunk",
        REQUEST_CHUNK_ACK: "git:request-chunk-ack",
        REQUEST_END: "git:request-end",
        REPLY: "git:reply",
        REPLY_START: "git:reply-start",
        REPLY_CHUNK: "git:reply-chunk",
        CHUNK_ACK: "git:chunk-ack",
        REPLY_END: "git:reply-end",
      }),
    );
  });

  it("streams large line-diff text and command stdin without changing their payloads", () => {
    const text = `first\n${"zażółć".repeat(GIT_HOST_STREAM_MAX_BYTES)}`;
    const lineDiffPayload = {
      descriptor: { gitDirectory: "/repo/.git", workingDirectory: "/repo" },
      relativePosixPath: "large.txt",
      headOid: "a".repeat(40),
      text,
    };
    const textPlan = prepareRequestStream("lineDiff", lineDiffPayload);
    expect(textPlan.payload.text).toBe("");
    expect(lineDiffPayload.text).toBe(text);
    expect(textPlan.streams.map(streamManifest)).toEqual([
      {
        name: "lineDiff.text",
        path: ["text"],
        kind: "string",
        length: text.length,
      },
    ]);

    const stdin = Buffer.alloc(GIT_HOST_STREAM_MAX_BYTES * 3 + 17, 0xab);
    const execPayload = {
      workingDirectory: "/repo",
      args: ["hash-object", "--stdin"],
      options: { stdin },
    };
    const stdinPlan = prepareRequestStream("exec", execPayload);
    expect(stdinPlan.payload.options.stdin).toBeNull();
    expect(execPayload.options.stdin).toBe(stdin);
    expect(stdinPlan.streams[0]).toEqual(
      jasmine.objectContaining({
        name: "exec.options.stdin",
        path: ["options", "stdin"],
        kind: "buffer",
        length: stdin.length,
      }),
    );

    for (const plan of [textPlan, stdinPlan]) {
      const descriptor = streamManifest(plan.streams[0]);
      let reconstructed = initializeReplyStream(plan.payload, descriptor).result;
      for (let offset = 0; offset < descriptor.length;) {
        const chunk = nextReplyChunk(plan.streams[0], offset);
        expect(v8.serialize(chunk).byteLength).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_BYTES);
        reconstructed = appendReplyChunk(reconstructed, descriptor, offset, chunk);
        offset += chunk.length;
      }
      const expected = plan === textPlan ? text : stdin;
      const actual = plan === textPlan ? reconstructed.text : reconstructed.options.stdin;
      expect(actual).toEqual(expected);
    }
  });

  it("keeps ordinary requests inline and validates request stream manifests", () => {
    expect(prepareRequestStream("lineDiff", { text: "small" })).toBeNull();
    expect(prepareRequestStream("snapshot", { text: "x".repeat(100000) })).toBeNull();

    const valid = {
      name: "execRepository.options.stdin",
      path: ["options", "stdin"],
      kind: "string",
      length: 10,
    };
    expect(validateRequestStreamManifest("execRepository", valid)).toBe(true);
    expect(validateRequestStreamManifest("exec", valid)).toBe(false);
    expect(validateRequestStreamManifest("execRepository", { ...valid, kind: "array" })).toBe(
      false,
    );
    expect(
      validateRequestStreamManifest("execRepository", {
        ...valid,
        path: ["options", "__proto__"],
      }),
    ).toBe(false);
    expect(
      validateRequestStreamManifest("execRepository", {
        ...valid,
        length: GIT_HOST_REQUEST_STREAM_MAX_LENGTH + 1,
      }),
    ).toBe(false);
  });

  it("keeps one explicit registry of supported operations", () => {
    expect(Object.keys(GitHostOperations).sort()).toEqual(
      [
        "blame",
        "branchesContaining",
        "commit",
        "describe",
        "diff",
        "exec",
        "execRepository",
        "fileMode",
        "history",
        "lineDiff",
        "readConfig",
        "readObjects",
        "snapshot",
        "submodulePaths",
        "writeRepositoryCommandOutput",
      ].sort(),
    );
    expect(assertKnownOperation("snapshot")).toBe("snapshot");
    expect(() => assertKnownOperation("obsolete")).toThrowError(/Unknown git-host op: obsolete/);
  });

  it("round-trips command errors and their causes", () => {
    const cause = Object.assign(new Error("spawn detail"), {
      code: "ENOENT",
      command: "git",
    });
    const error = Object.assign(new Error("Git diff failed"), {
      code: "ERR_GIT_DIFF",
      operation: "diff",
      gitCode: "ERR_GIT_COMMAND_FAILED",
      cause,
    });

    const revived = reviveError(serializeError(error));
    expect(revived.message).toBe("Git diff failed");
    expect(revived.code).toBe("ERR_GIT_DIFF");
    expect(revived.gitCode).toBe("ERR_GIT_COMMAND_FAILED");
    expect(revived.cause.message).toBe("spawn detail");
    expect(revived.cause.command).toBe("git");
  });

  it("preserves repository identity error fields, including a bare worktree", () => {
    const error = Object.assign(new Error("Git repository is unavailable"), {
      code: "ERR_GIT_REPOSITORY_UNAVAILABLE",
      operation: "snapshot",
      reason: "git-directory-missing",
      gitDirectory: "/repositories/project.git",
      workingDirectory: null,
    });

    const revived = reviveError(serializeError(error));

    expect(revived).toEqual(
      jasmine.objectContaining({
        code: "ERR_GIT_REPOSITORY_UNAVAILABLE",
        operation: "snapshot",
        reason: "git-directory-missing",
        gitDirectory: "/repositories/project.git",
        workingDirectory: null,
      }),
    );
  });

  it("bounds error diagnostics before they cross IPC", () => {
    const error = Object.assign(new Error("m".repeat(200000)), {
      stdout: "o".repeat(200000),
      stderr: "ę".repeat(200000),
    });

    const serialized = serializeError(error);
    for (const field of ["message", "stack", "stdout", "stderr"]) {
      expect(Buffer.byteLength(serialized[field])).toBeLessThanOrEqual(
        GIT_HOST_ERROR_TEXT_MAX_BYTES,
      );
      expect(serialized[`${field}Truncated`]).toBe(true);
    }

    const revived = reviveError(serialized);
    expect(revived.messageTruncated).toBe(true);
    expect(revived.stderrTruncated).toBe(true);
    expect(revived.stdoutTruncated).toBe(true);
  });

  it("bounds the complete error graph and truncates cyclic or deep causes", () => {
    const root = Object.assign(new Error("root".repeat(50000)), {
      code: "ERR_GIT_NATIVE_TEST",
      command: "git status",
      operation: "snapshot",
      stdout: "output".repeat(50000),
      stderr: "failure".repeat(50000),
      exitCode: { oversized: "x".repeat(200000) },
      structuredBytes: ["x".repeat(200000)],
      messageTruncated: false,
    });
    let current = root;
    for (let depth = 0; depth < GIT_HOST_ERROR_MAX_CAUSE_DEPTH + 2; depth++) {
      current.cause = new Error(`cause-${depth}-${"x".repeat(50000)}`);
      current = current.cause;
    }
    current.cause = root;

    const serialized = serializeError(root);

    expect(v8.serialize(serialized).byteLength).toBeLessThanOrEqual(GIT_HOST_ERROR_TOTAL_MAX_BYTES);
    expect(serialized.code).toBe("ERR_GIT_NATIVE_TEST");
    expect(serialized.command).toBe("git status");
    expect(serialized.operation).toBe("snapshot");
    expect(serialized.exitCode).toBeUndefined();
    expect(serialized.structuredBytes).toBeUndefined();
    expect(serialized.messageTruncated).toBe(true);
    let deepest = serialized;
    while (deepest.cause) deepest = deepest.cause;
    expect(deepest.causeTruncated).toBe(true);
  });

  it("keeps small snapshots inline and prepares large snapshots for bounded chunks", () => {
    const small = {
      status: {
        fingerprint: "small",
        unchanged: false,
        value: { files: [{ path: "small.txt" }], submodulePaths: [] },
      },
    };
    expect(prepareSnapshotStream(small)).toBeNull();
    expect(prepareSnapshotStream({ status: { fingerprint: "same", unchanged: true } })).toBeNull();

    const files = Array.from({ length: 1001 }, (_, index) => ({
      path: `directory/file-${index}.txt`,
      kind: "untracked",
    }));
    const submodulePaths = Array.from({ length: 12 }, (_, index) => `module-${index}`);
    const source = {
      status: {
        fingerprint: "large",
        unchanged: false,
        value: { files, submodulePaths },
      },
      refs: {
        fingerprint: "refs",
        unchanged: false,
        value: {
          branches: [{ name: "main" }],
          remoteBranches: [],
          tags: [],
          remotes: [],
          worktrees: [],
        },
      },
    };
    const plan = prepareSnapshotStream(source);

    expect(plan.result.status.value.files).toEqual([]);
    expect(plan.result.status.value.submodulePaths).toEqual([]);
    expect(plan.result.refs.value.branches).toEqual([]);
    expect(source.status.value.files).toBe(files);
    expect(plan.streams.map(({ name }) => name)).toEqual([
      "status.files",
      "status.submodulePaths",
      "refs.branches",
    ]);

    for (const stream of plan.streams) {
      for (let offset = 0; offset < stream.length;) {
        const chunk = nextReplyChunk(stream, offset);
        expect(chunk.length).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_RECORDS);
        if (chunk.length > 1) {
          expect(v8.serialize(chunk).byteLength).toBeLessThanOrEqual(GIT_HOST_STREAM_MAX_BYTES);
        }
        offset += chunk.length;
      }
    }
    expect(reassemble(plan)).toEqual(source);
  });

  it("streams oversized commit metadata nested inside refs snapshot records", () => {
    const subject = `subject-${"s".repeat(GIT_HOST_STREAM_MAX_BYTES * 2)}`;
    const authorName = `author-${"a".repeat(GIT_HOST_STREAM_MAX_BYTES)}`;
    const parents = Array.from({ length: 4000 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    const source = {
      refs: {
        fingerprint: "large-commit",
        unchanged: false,
        value: {
          head: null,
          branches: [
            {
              name: "main",
              ref: "refs/heads/main",
              oid: "a".repeat(64),
              isHead: true,
              upstream: null,
              push: null,
              lastCommit: {
                oid: "a".repeat(64),
                parents,
                authorName,
                committerDate: new Date(0),
                subject,
              },
            },
          ],
          remoteBranches: [],
          tags: [],
          remotes: [],
          worktrees: [],
        },
      },
    };

    const plan = prepareSnapshotStream(source);

    expect(plan.streams.map(({ name }) => name)).toEqual([
      "refs.branches",
      "refs.branches.0.lastCommit.subject",
      "refs.branches.0.lastCommit.authorName",
      "refs.branches.0.lastCommit.parents",
    ]);
    expect(reassemble(plan)).toEqual(source);
  });

  it("streams top-level arrays and large object contents without changing their values", () => {
    const history = Array.from({ length: 300 }, (_, index) => ({
      sha: String(index).padStart(40, "0"),
      subject: `Commit ${index}`,
    }));
    expect(reassemble(prepareReplyStream("history", history))).toEqual(history);

    const buffer = Buffer.alloc(400 * 1024, 0xab);
    const text = "Zażółć gęślą jaźń\n".repeat(8000);
    const objects = [
      { oid: "a".repeat(40), type: "blob", size: buffer.length, content: buffer },
      { oid: "b".repeat(40), type: "blob", size: text.length, content: text },
    ];
    const reconstructed = reassemble(prepareReplyStream("readObjects", objects));
    expect(reconstructed[0].content).toEqual(buffer);
    expect(reconstructed[1].content).toBe(text);

    const execution = { exitCode: 0, stdout: "x".repeat(200 * 1024), stderr: "" };
    expect(reassemble(prepareReplyStream("exec", execution))).toEqual(execution);
  });

  it("streams large history messages and blame summaries from metadata-root arrays", () => {
    const subject = `subject-${"s".repeat(GIT_HOST_STREAM_MAX_BYTES * 2)}`;
    const body = `body-${"Zażółć".repeat(60000)}`;
    const history = [
      {
        sha: "a".repeat(40),
        parents: [],
        author: { name: "Author", email: "author@example.test", date: new Date(0) },
        committer: { name: "Committer", email: "committer@example.test", date: new Date(0) },
        subject,
        body,
      },
    ];
    const historyPlan = prepareReplyStream("history", history);
    const historyManifest = historyPlan.streams.map(streamManifest);
    expect(historyManifest.map(({ name }) => name)).toEqual([
      "result",
      "history.0.subject",
      "history.0.body",
    ]);
    expect(v8.serialize(historyManifest).byteLength).toBeLessThan(4096);
    expect(reassemble(historyPlan)).toEqual(history);

    const summary = `summary-${"m".repeat(GIT_HOST_STREAM_MAX_BYTES * 2)}`;
    const blame = [
      {
        line: 1,
        originalLine: 1,
        sha: "b".repeat(40),
        author: { name: "Author", email: "author@example.test", date: new Date(0) },
        summary,
      },
    ];
    const blamePlan = prepareReplyStream("blame", blame);
    const blameManifest = blamePlan.streams.map(streamManifest);
    expect(blameManifest.map(({ name }) => name)).toEqual(["result", "blame.0.summary"]);
    expect(v8.serialize(blameManifest).byteLength).toBeLessThan(4096);
    expect(reassemble(blamePlan)).toEqual(blame);
  });

  it("rejects strings too large to expose without a renderer flattening risk", () => {
    let error;
    try {
      prepareReplyStream("exec", {
        exitCode: 0,
        stdout: "x".repeat(GIT_HOST_STREAM_MAX_STRING_BYTES + 1),
        stderr: "",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("ERR_GIT_HOST_RESULT_TOO_LARGE");
    expect(error.maxBytes).toBe(GIT_HOST_STREAM_MAX_STRING_BYTES);
    expect(error.resultBytes).toBe(GIT_HOST_STREAM_MAX_STRING_BYTES + 1);
  });

  it("streams one large structured diff file through dependent file, hunk, and line streams", () => {
    const lines = Array.from({ length: 4000 }, (_, index) => ({
      kind: index % 2 === 0 ? "added" : "deleted",
      text: `line-${index}-${"x".repeat(80)}`,
    }));
    const diff = {
      schemaVersion: 1,
      files: [
        {
          oldPath: "large.txt",
          newPath: "large.txt",
          status: "modified",
          similarity: null,
          binary: false,
          oldMode: "100644",
          newMode: "100644",
          hunks: [
            {
              oldStart: 1,
              oldLines: 2000,
              newStart: 1,
              newLines: 2000,
              heading: null,
              lines,
            },
          ],
        },
      ],
      rawPatch: `diff --git a/large.txt b/large.txt\n${"+patch line\n".repeat(30000)}`,
    };
    const plan = prepareReplyStream("diff", diff);
    expect(plan.streams.map(({ name }) => name)).toEqual([
      "diff.files",
      "diff.files.0.hunks",
      "diff.files.0.hunks.0.lines",
      "diff.rawPatch",
    ]);
    expect(reassemble(plan)).toEqual(diff);
  });

  it("keeps small lines inline when a diff has thousands of small hunks", () => {
    const hunks = Array.from({ length: 1000 }, (_, index) => ({
      oldStart: index + 1,
      oldLines: 1,
      newStart: index + 1,
      newLines: 1,
      heading: null,
      lines: [{ kind: "context", text: `line ${index}` }],
    }));
    const diff = {
      schemaVersion: 1,
      files: [
        {
          oldPath: "many-hunks.txt",
          newPath: "many-hunks.txt",
          status: "modified",
          similarity: null,
          binary: false,
          oldMode: "100644",
          newMode: "100644",
          hunks,
        },
      ],
    };

    const plan = prepareReplyStream("diff", diff);
    const manifest = plan.streams.map(streamManifest);
    expect(manifest.map(({ name }) => name)).toEqual(["diff.files", "diff.files.0.hunks"]);
    expect(v8.serialize(manifest).byteLength).toBeLessThan(4096);
    expect(reassemble(plan)).toEqual(diff);
  });

  it("streams large individual diff line text and hunk headings byte-for-byte", () => {
    const heading = `function ${"heading".repeat(50000)}`;
    const text = `const sourceMap = "${"x".repeat(GIT_HOST_STREAM_MAX_BYTES * 2)}";`;
    const diff = {
      schemaVersion: 1,
      files: [
        {
          oldPath: "large.txt",
          newPath: "large.txt",
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              heading,
              lines: [{ kind: "context", text }],
            },
          ],
        },
      ],
    };
    const plan = prepareReplyStream("diff", diff);
    expect(plan.streams.map(({ name }) => name)).toContain("diff.files.0.hunks.0.heading");
    expect(plan.streams.map(({ name }) => name)).toContain("diff.files.0.hunks.0.lines.0.text");
    expect(reassemble(plan)).toEqual(diff);
  });
});
