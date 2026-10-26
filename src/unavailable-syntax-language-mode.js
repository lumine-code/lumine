const path = require("node:path");
const NullLanguageMode = require("./null-language-mode");

// Preserve the selected language and its settings, but own no worker, syntax
// tree, pending analysis or stale highlighting after an infrastructure failure.
module.exports = class UnavailableSyntaxLanguageMode extends NullLanguageMode {
  constructor({ buffer, grammar, failure, retry }) {
    super({ buffer, grammar });
    this.syntaxAvailability = Object.freeze({ available: false, reason: "failure", failure });
    this.retry = retry;
  }

  notify() {
    const { failure } = this.syntaxAvailability;
    const name = this.buffer.getPath() ? path.basename(this.buffer.getPath()) : "Untitled";
    const reason =
      failure.code === "memory-limit"
        ? "The syntax parser stopped at its memory limit."
        : failure.code === "memory-pressure"
          ? "Syntax analysis reached its memory budget."
          : failure.code === "parse-budget"
            ? "Syntax analysis exceeded its processing budget."
            : "The syntax parser could not continue.";
    this.notification = globalThis.lumine?.notifications?.addWarning(
      "Syntax analysis is unavailable",
      {
        dismissable: true,
        description: `${name}: ${reason} You can continue editing and saving this document.`,
        detail: JSON.stringify(failure, null, 2),
        buttons: [{ text: "Retry Analysis", onDidClick: () => this.retrySyntaxAnalysis() }],
      },
    );
  }

  retrySyntaxAnalysis() {
    if (this.buffer.isDestroyed() || this.buffer.getLanguageMode() !== this) return false;
    this.retry();
    return true;
  }

  atGrammarSettlement() {
    return { parseError: this.syntaxAvailability.failure };
  }

  getFoldableRanges() {
    return [];
  }
  getFoldableRangesAtIndentLevel() {
    return [];
  }
  getFoldRangeForRow() {
    return null;
  }
  getFoldRangeContainingPoint() {
    return null;
  }
  endRowForFoldAtRow() {
    return undefined;
  }

  destroy() {
    this.notification?.dismiss();
    this.retry = null;
    super.destroy();
  }
};
