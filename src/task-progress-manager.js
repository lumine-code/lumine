const crypto = require("node:crypto");

function assertId(id) {
  if (typeof id !== "string" || !id || id.length > 128)
    throw new TypeError(
      "A task progress reporter requires a non-empty id of at most 128 characters",
    );
}

function normalizeStatus(status) {
  if (
    !status ||
    typeof status !== "object" ||
    Array.isArray(status) ||
    !Number.isSafeInteger(status.count) ||
    status.count < 0
  ) {
    throw new TypeError("Task progress count must be a non-negative safe integer");
  }
  const progress = status.progress ?? null;
  if (progress !== null && (!Number.isFinite(progress) || progress < 0 || progress > 1))
    throw new TypeError("Task progress must be a number between zero and one, or null");
  return { count: status.count, progress };
}

function windowsForOwner(owner) {
  return [
    owner.browserWindow,
    ...Array.from(owner.auxiliaryWindowBroker?.windows?.values() ?? [], ({ window }) => window),
  ].filter((window) => window && !window.isDestroyed());
}

// Native presentation is workspace-local; the application badge counts work
// across every workspace. Packages own reporters, never the native indicator.
module.exports = class TaskProgressManager {
  constructor({ setBadgeCount }) {
    this.setBadgeCount = setBadgeCount;
    this.owners = new Map();
    this.generations = new Map();
    this.windows = new Map();
    this.badgeCount = 0;
    this.disposed = false;
  }

  beginGeneration(owner) {
    if (this.disposed) throw new Error("Task progress is unavailable after application teardown");
    this.endGeneration(owner);
    const token = crypto.randomUUID();
    const contents = owner.browserWindow.webContents;
    const end = () => this.endGeneration(owner);
    const navigate = (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) end();
    };
    this.generations.set(owner, { token, contents, end, navigate });
    contents.on("did-start-navigation", navigate);
    contents.on("render-process-gone", end);
    contents.on("destroyed", end);
    return token;
  }

  endGeneration(owner) {
    const record = this.generations.get(owner);
    if (!record) return;
    // Invalidate before clearing native state, so queued outgoing IPC cannot
    // recreate a report while the same BrowserWindow starts its next document.
    this.generations.delete(owner);
    record.contents.removeListener("did-start-navigation", record.navigate);
    record.contents.removeListener("render-process-gone", record.end);
    record.contents.removeListener("destroyed", record.end);
    this.clear(owner);
  }

  update(owner, id, status, generation) {
    assertId(id);
    status = normalizeStatus(status);
    if (this.disposed) throw new Error("Task progress is unavailable after application teardown");
    if (owner.isSpec || owner.offscreen || owner.headless) return;
    if (!generation || this.generations.get(owner)?.token !== generation)
      throw new Error("The task progress renderer generation has ended");
    if (owner.unloading || owner.isClosing?.())
      throw new Error("The task progress renderer is unloading");
    if (status.count === 0) return this.remove(owner, id, generation);

    let record = this.owners.get(owner);
    if (!record) {
      record = { reporters: new Map() };
      this.owners.set(owner, record);
    }
    record.reporters.set(id, status);
    this.refresh(owner);
  }

  remove(owner, id, generation) {
    assertId(id);
    if (!generation || this.generations.get(owner)?.token !== generation) return;
    const record = this.owners.get(owner);
    if (!record?.reporters.delete(id)) return;
    if (record.reporters.size === 0) return this.clear(owner);
    this.refresh(owner);
  }

  clear(owner) {
    const record = this.owners.get(owner);
    if (!record) return;
    this.owners.delete(owner);
    this.refresh(owner);
  }

  refresh(owner) {
    if (owner.isSpec || owner.offscreen || owner.headless) return;
    const statuses = this.owners.get(owner)?.reporters.values() ?? [];
    let count = 0;
    let completed = 0;
    let indeterminate = false;
    for (const status of statuses) {
      count += status.count;
      completed += status.count * (status.progress ?? 0);
      indeterminate ||= status.progress === null;
    }
    const progress = count === 0 ? -1 : indeterminate ? 2 : completed / count;
    const currentWindows = new Set(windowsForOwner(owner));
    for (const [window, rendered] of this.windows) {
      if (rendered.owner !== owner || currentWindows.has(window)) continue;
      if (!window.isDestroyed()) window.setProgressBar(-1);
      this.windows.delete(window);
    }
    for (const window of currentWindows) {
      const previous = this.windows.get(window);
      if (progress < 0 ? previous : previous?.progress !== progress)
        window.setProgressBar(progress);
      if (progress < 0) this.windows.delete(window);
      else this.windows.set(window, { owner, progress });
    }

    let badgeCount = 0;
    for (const { reporters } of this.owners.values()) {
      for (const status of reporters.values()) badgeCount += status.count;
    }
    // Electron accepts a signed 32-bit native badge count.
    badgeCount = Math.min(badgeCount, 2147483647);
    if (this.badgeCount !== badgeCount) {
      this.setBadgeCount(badgeCount);
      this.badgeCount = badgeCount;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const owner of this.generations.keys()) this.endGeneration(owner);
  }
};
