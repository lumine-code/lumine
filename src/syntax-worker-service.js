const { CompositeDisposable } = require("@lumine-code/event-kit");
const Client = require("./syntax-worker-client");
const { environment, configuration } = require("./syntax-worker-environment");
const { watchFile } = require("./file-watch");

const yieldTask = () => new Promise((resolve) => setImmediate(resolve));

class SyntaxWorkerService {
  constructor(grammars, { clientFactory = () => new Client() } = {}) {
    this.grammars = grammars;
    this.clientFactory = clientFactory;
    this.sessions = new Map();
    this.watches = new Map();
    this.nextSession = 0;
    this.environmentVersion = 0;
    this.syntaxEpoch = 0;
    this.environmentReady = Promise.resolve();
    this.environmentDirty = true;
    this.configurationDirty = false;
    this.subscriptions = new CompositeDisposable(
      grammars.onDidAddGrammar(() => this.invalidateEnvironment()),
      grammars.onDidUpdateGrammar(() => this.invalidateEnvironment()),
      grammars.onDidRemoveGrammar(() => this.invalidateEnvironment()),
      grammars.onDidChangeSyntaxModules(() => this.invalidateEnvironment()),
      grammars.config.onDidChange(() => this.invalidateConfiguration()),
    );
    const packages = globalThis.lumine?.packages;
    const workspace = globalThis.lumine?.workspace;
    if (workspace?.onDidChangeActiveTextEditor)
      this.subscriptions.add(
        workspace.onDidChangeActiveTextEditor((editor) => this.focusBuffer(editor?.getBuffer())),
      );
    if (packages?.onDidUnloadPackage)
      this.subscriptions.add(
        packages.onDidUnloadPackage((pack) => {
          this.client?.send({ type: "control", operation: "unload-module", path: pack.path });
        }),
      );
  }

  connect() {
    if (this.closed) throw new Error("Syntax worker service is closed");
    if (this.terminalError) throw this.terminalError;
    clearTimeout(this.idleTimer);
    if (!this.client) {
      this.client = this.clientFactory();
      this.eventSubscription = this.client.onDidReceiveEvent((event) => this.receive(event));
      const client = this.client;
      this.closeSubscription = client.onDidClose((error) => this.recover(client, error));
      this.environmentDirty = true;
      this.environmentReady = Promise.resolve();
      this.syncing = null;
    }
    return this.client;
  }

  focusBuffer(buffer) {
    let id = null;
    for (const session of this.sessions.values())
      if (session.buffer === buffer) {
        id = session.id;
        break;
      }
    this.client?.send({ type: "control", operation: "focus", session: id });
  }

  invalidateEnvironment() {
    this.syntaxEpoch++;
    this.environmentDirty = true;
    for (const session of this.sessions.values()) session.listener({ event: "pending" });
    if (this.sessions.size) void this.ensureEnvironment().catch((error) => this.report(error));
  }

  report(error) {
    for (const session of this.sessions.values()) session.listener({ event: "failure", error });
  }

  invalidateConfiguration() {
    this.syntaxEpoch++;
    this.configurationDirty = true;
    for (const session of this.sessions.values()) session.listener({ event: "pending" });
    if (this.sessions.size) void this.ensureEnvironment().catch((error) => this.report(error));
  }

  ensureEnvironment() {
    const client = this.connect();
    if (!this.syncing) {
      this.syncing = client;
      this.environmentReady = this.environmentReady
        .catch(() => {})
        .then(async () => {
          try {
            while (
              (this.environmentDirty || this.configurationDirty) &&
              !this.closed &&
              this.client === client
            ) {
              await yieldTask();
              const reload = this.environmentDirty;
              this.environmentDirty = false;
              this.configurationDirty = false;
              const version = ++this.environmentVersion;
              if (reload) {
                const data = environment(this.grammars, version, {
                  devMode: globalThis.lumine?.window?.isDevMode() ?? false,
                  specMode: globalThis.lumine?.window?.isSpecMode() ?? false,
                });
                await client.request("environment", data);
              } else
                await client.request("configure", {
                  version,
                  configuration: configuration(this.grammars.config),
                });
            }
          } catch (error) {
            if (this.client === client) this.environmentDirty = true;
            throw error;
          } finally {
            if (this.syncing === client) this.syncing = null;
          }
        });
    }
    return this.environmentReady;
  }

  receive(event) {
    if (this.closed) return;
    const session = this.sessions.get(event.session);
    if (session) {
      if (event.generation !== undefined) session.generation = event.generation;
      session.listener(event);
      return;
    }
    if (event.event === "query-changed") {
      // Forward the completed reload as metadata, without compiling another
      // query in the renderer or rebuilding the worker environment.
      this.grammars.grammarForScopeName(event.scopeName)?.emitter.emit("did-change-query", {
        filePath: event.filePath,
        queryType: event.queryType,
      });
    } else if (event.event === "watch") {
      const handle = this.grammars.fileWatchClient?.watchFile(event.file) ?? watchFile(event.file);
      const client = this.client;
      const send = (message) => {
        if (this.client !== client) return;
        if (message.operation === "watch-event") {
          this.syntaxEpoch++;
          for (const session of this.sessions.values()) session.listener({ event: "pending" });
        }
        client.send({ type: "control", watch: event.id, ...message });
      };
      const subscriptions = new CompositeDisposable(
        handle,
        handle.onDidChange((events) => send({ operation: "watch-event", kind: "change", events })),
        handle.onDidInvalidate((events) =>
          send({ operation: "watch-event", kind: "invalidate", events }),
        ),
        handle.onDidError((error) => send({ operation: "watch-error", message: error.message })),
      );
      this.watches.set(event.id, subscriptions);
      handle.ready.then(
        () => send({ operation: "watch-ready" }),
        (error) => send({ operation: "watch-error", message: error.message }),
      );
    } else if (event.event === "unwatch") {
      this.watches.get(event.id)?.dispose();
      this.watches.delete(event.id);
    } else if (event.event === "notification") {
      const notifications = globalThis.lumine?.notifications;
      if (event.level === "error") notifications?.addError(event.message, event.options);
      else notifications?.addSuccess(event.message, event.options);
    }
  }

  acquire(buffer, grammar, listener) {
    const policy = this.grammars.rootLanguageRangesByBuffer.get(buffer);
    if (policy && !policy.descriptor)
      throw new TypeError("Worker root ranges require a syntax module descriptor");
    this.connect();
    const controller = new AbortController();
    const session = {
      id: ++this.nextSession,
      buffer,
      grammar,
      listener,
      controller,
      generation: 0,
      closed: false,
    };
    this.sessions.set(session.id, session);
    this.focusBuffer(globalThis.lumine?.workspace?.getActiveTextEditor?.()?.getBuffer());
    this.openSession(session);
    session.subscription = new CompositeDisposable(
      buffer.onDidApplyChanges((batch) => {
        const client = session.client;
        session.chain = session.chain.then(() => this.sendEdits(client, session, batch));
        this.observeChain(session, client);
      }),
      buffer.onDidChangePath(() => {
        session.epoch++;
        session.listener({ event: "pending" });
        const client = session.client;
        const path = buffer.getPath();
        session.chain = session.chain.then(() =>
          client.request("path", { session: session.id, path }, { signal: controller.signal }),
        );
        this.observeChain(session, client);
      }),
    );
    return session;
  }

  observeChain(session, client) {
    void session.chain.catch((error) => {
      if (!session.closed && this.client === client && !client.closed)
        session.listener({ event: "failure", error });
    });
  }

  async sendEdits(client, session, batch) {
    const changes = batch.changes,
      options = { signal: session.controller.signal };
    options.signal.throwIfAborted();
    let size = 0;
    if (changes.length < 128)
      for (const change of changes) {
        size += change.inserted?.length ?? change.newText.length;
        if (size > 64 * 1024) break;
      }
    if (changes.length < 128 && size <= 64 * 1024)
      return client.request(
        "edit",
        {
          session: session.id,
          beforeRevision: batch.beforeRevision,
          revision: batch.afterRevision,
          changes: changes.map((change) => ({
            range: change.oldRange.serialize(),
            startIndex: change.startIndex,
            oldEndIndex: change.oldEndIndex,
            text: change.inserted?.toString() ?? change.newText,
          })),
        },
        options,
      );
    let packet = [],
      units = 0;
    const flush = async () => {
      if (!packet.length) return;
      await client.request("edit-chunk", { session: session.id, changes: packet }, options);
      packet = [];
      units = 0;
    };
    try {
      await client.request(
        "edit-begin",
        {
          session: session.id,
          beforeRevision: batch.beforeRevision,
          revision: batch.afterRevision,
          count: changes.length,
        },
        options,
      );
      for (const change of changes) {
        options.signal.throwIfAborted();
        const length = change.inserted?.length ?? change.newText.length;
        if (length > 64 * 1024) {
          await flush();
          await client.request(
            "edit-text-begin",
            {
              session: session.id,
              startIndex: change.startIndex,
              oldEndIndex: change.oldEndIndex,
              length,
            },
            options,
          );
          const chunks = change.inserted?.chunks() ?? [change.newText];
          for (const chunk of chunks)
            for (let offset = 0; offset < chunk.length; offset += 64 * 1024)
              await client.request(
                "edit-text-chunk",
                { session: session.id, text: chunk.slice(offset, offset + 64 * 1024) },
                options,
              );
          await client.request("edit-text-end", { session: session.id }, options);
        } else {
          if (packet.length >= 128 || units + length > 64 * 1024) await flush();
          packet.push({
            startIndex: change.startIndex,
            oldEndIndex: change.oldEndIndex,
            text: change.inserted?.toString() ?? change.newText,
          });
          units += length;
        }
      }
      await flush();
      return await client.request("edit-commit", { session: session.id }, options);
    } catch (error) {
      client.send({ type: "control", operation: "release", session: session.id });
      throw error;
    }
  }

  openSession(session) {
    const { buffer, grammar, controller } = session;
    const client = this.connect();
    session.client = client;
    session.epoch = (session.epoch ?? 0) + 1;
    session.generation = 0;
    const snapshot = buffer.getTextSnapshot();
    const revision = buffer.getTextRevision();
    const rootRanges = this.grammars.rootLanguageRangesByBuffer.get(buffer);
    if (rootRanges && !rootRanges.descriptor)
      throw new TypeError("Worker root ranges require a syntax module descriptor");
    session.chain = (async () => {
      await this.ensureEnvironment();
      const options = { signal: controller.signal };
      await client.request(
        "open",
        {
          session: session.id,
          scopeName: grammar.scopeName,
          path: buffer.getPath(),
          revision,
          rootRanges: rootRanges?.descriptor,
        },
        options,
      );
      // Only bounded strings cross the boundary. Capturing this immutable root
      // does not flatten the document or hold up the first input event.
      for (const text of snapshot.chunks()) {
        for (let offset = 0; offset < text.length; offset += 64 * 1024)
          await client.request(
            "append",
            { session: session.id, text: text.slice(offset, offset + 64 * 1024) },
            options,
          );
      }
      await client.request("initialize", { session: session.id }, options);
    })();
    this.observeChain(session, client);
  }

  recover(client, error) {
    if (this.closed || this.client !== client) return;
    this.disconnect();
    if (!this.sessions.size) return;
    // A broken package or bootstrap must not create a worker crash loop.
    if (this.recoveryAttempted) {
      this.terminalError = error;
      this.report(error);
      return;
    }
    this.recoveryAttempted = true;
    for (const session of this.sessions.values()) session.listener({ event: "recovering" });
    try {
      for (const session of this.sessions.values()) {
        this.openSession(session);
        const replacement = session.client;
        void session.chain.then(
          () => {
            if (!session.closed && this.client === replacement)
              session.listener({ event: "recovered" });
          },
          (failure) => {
            if (!session.closed && this.client === replacement) this.report(failure);
          },
        );
      }
    } catch (failure) {
      this.terminalError = failure;
      this.report(failure);
    }
  }

  updateRootRanges(session) {
    session.epoch++;
    session.listener({ event: "pending" });
    const descriptor = this.grammars.rootLanguageRangesByBuffer.get(session.buffer)?.descriptor;
    const client = session.client;
    session.chain = session.chain.then(() =>
      client.request(
        "root-ranges",
        {
          session: session.id,
          descriptor,
        },
        { signal: session.controller.signal },
      ),
    );
    this.observeChain(session, client);
  }

  async request(
    session,
    operation,
    data = {},
    { signal, onChunk, revision = session.buffer.getTextRevision() } = {},
  ) {
    const combined = signal
      ? AbortSignal.any([signal, session.controller.signal])
      : session.controller.signal;
    combined.throwIfAborted();
    if (this.terminalError) throw this.terminalError;
    const syntaxEpoch = this.syntaxEpoch,
      sessionEpoch = session.epoch;
    await this.ensureEnvironment();
    await session.chain;
    combined.throwIfAborted();
    if (syntaxEpoch !== this.syntaxEpoch || sessionEpoch !== session.epoch)
      throw Client.abortError("Syntax configuration changed");
    if (revision !== session.buffer.getTextRevision())
      throw Client.abortError("Syntax revision changed");
    const client = this.client;
    const result = await client.request(
      operation,
      { ...data, session: session.id, revision },
      { signal: combined, onChunk },
    );
    combined.throwIfAborted();
    if (
      client !== this.client ||
      syntaxEpoch !== this.syntaxEpoch ||
      sessionEpoch !== session.epoch ||
      result.revision !== session.buffer.getTextRevision() ||
      result.generation !== session.generation
    )
      throw Client.abortError("Syntax response is obsolete");
    if (result.syntaxReady) session.listener({ event: "settled", revision: result.revision });
    return result.value;
  }

  async settle(session, signal) {
    while (!session.closed && !signal?.aborted) {
      try {
        return await this.request(session, "settle", {}, { signal });
      } catch (error) {
        if (
          error.name !== "AbortError" ||
          this.closed ||
          this.terminalError ||
          session.closed ||
          signal?.aborted
        )
          throw error;
      }
    }
    throw Client.abortError();
  }

  release(session) {
    if (session.closed) return;
    session.closed = true;
    session.controller.abort(Client.abortError("Syntax document was closed"));
    session.subscription.dispose();
    this.sessions.delete(session.id);
    this.client?.send({ type: "control", operation: "release", session: session.id });
    if (!this.sessions.size) this.idleTimer = setTimeout(() => this.disconnect(), 5000);
  }

  disconnect() {
    clearTimeout(this.idleTimer);
    this.eventSubscription?.dispose();
    this.eventSubscription = null;
    this.closeSubscription?.dispose();
    this.closeSubscription = null;
    this.client?.close();
    this.client = null;
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
    this.environmentDirty = true;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions.values()]) this.release(session);
    this.disconnect();
    this.subscriptions.dispose();
  }
}

module.exports = SyntaxWorkerService;
