// A timeout is transient evidence, not a permanent classification of text.
// Retry only requested paint, behind missing foreground work, with a bounded
// backoff. Structural query limits never enter this queue.
class SyntaxPaintRetries {
  constructor({
    ready,
    wanted,
    now = () => performance.now(),
    schedule = setTimeout,
    cancel = clearTimeout,
    delays = [100, 500, 2000],
    maxEntries = 64,
  }) {
    Object.assign(this, { ready, wanted, now, schedule, cancel, delays, maxEntries });
    this.entries = new Map();
    this.timer = null;
  }

  observe(tile, stamp) {
    const epoch = `${stamp.revision}:${stamp.generation}:${stamp.presentation}`;
    if (epoch !== this.epoch) {
      this.clear();
      this.epoch = epoch;
    }
    if (tile.reason !== "timeout") {
      for (const [key, entry] of this.entries)
        if (tile.start.compare(entry.start) <= 0 && tile.end.compare(entry.end) >= 0)
          this.entries.delete(key);
    } else if (tile.reason === "timeout") {
      const key = `${tile.start.row}:${tile.start.column}-${tile.end.row}:${tile.end.column}`;
      const previous = this.entries.get(key);
      const attempt = previous ? previous.attempt + 1 : 0;
      this.entries.delete(key);
      this.entries.set(key, {
        start: tile.start,
        end: tile.end,
        attempt,
        due: attempt < this.delays.length ? this.now() + this.delays[attempt] : Infinity,
      });
      while (this.entries.size > this.maxEntries)
        this.entries.delete(this.entries.keys().next().value);
    }
    this.update();
  }

  next() {
    for (const entry of this.entries.values())
      if (entry.due <= this.now() && this.wanted(entry)) return entry;
    return null;
  }

  update() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    let due = Infinity;
    for (const entry of this.entries.values()) {
      const active = this.wanted(entry);
      // A later visit gets a new bounded chance after load has subsided.
      // Repeated layout/paint requests for the same visible range do not.
      if (active && entry.active === false && entry.attempt >= this.delays.length) {
        entry.attempt = 0;
        entry.due = this.now() + this.delays[0];
      }
      entry.active = active;
      if (active) due = Math.min(due, entry.due);
    }
    if (Number.isFinite(due))
      this.timer = this.schedule(
        () => {
          this.timer = null;
          if (this.next()) this.ready();
        },
        Math.max(0, due - this.now()),
      );
  }

  clear() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.entries.clear();
    this.epoch = null;
  }
}

module.exports = SyntaxPaintRetries;
