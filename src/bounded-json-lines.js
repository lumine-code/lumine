// ripgrep's JSON protocol puts an entire matching line (or multiline match) in
// one message. The legacy project-search result contract needs a string for
// that payload, so reject oversized messages before concatenation/JSON.parse.
class BoundedJsonLines {
  constructor(onMessage, maxUnits = 8 * 1024 * 1024) {
    this.onMessage = onMessage;
    this.maxUnits = maxUnits;
    this.parts = [];
    this.units = 0;
  }

  write(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      if (this.units + length > this.maxUnits) {
        this.parts = [];
        this.units = 0;
        throw Object.assign(
          new RangeError(
            `Project search received a result larger than its ${this.maxUnits} character JSON transport budget. Open the file and use buffer search, or narrow the project query. Results are incomplete.`,
          ),
          { code: "ERR_PROJECT_SEARCH_RESULT_LIMIT" },
        );
      }
      if (length) this.parts.push(chunk.slice(start, end));
      this.units += length;
      if (newline < 0) break;
      const line = this.parts.join("");
      this.parts = [];
      this.units = 0;
      if (line) this.onMessage(JSON.parse(line));
      start = end + 1;
    }
  }
}

module.exports = BoundedJsonLines;
