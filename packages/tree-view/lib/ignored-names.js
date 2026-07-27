let picomatch = null; // Defer requiring until actually needed

module.exports = class IgnoredNames {
  constructor() {
    this.ignoredPatterns = [];

    if (picomatch == null) {
      picomatch = require("picomatch");
    }

    let ignoredNames = atom.config.get("core.ignoredNames") ?? [];

    if (typeof ignoredNames === "string") {
      ignoredNames = [ignoredNames];
    }
    for (let ignoredName of ignoredNames) {
      if (ignoredName) {
        try {
          this.ignoredPatterns.push(picomatch(ignoredName, { basename: true, dot: true }));
        } catch (error) {
          atom.notifications.addWarning(`Error parsing ignore pattern (${ignoredName})`, {
            detail: error.message,
          });
        }
      }
    }
  }

  matches(filePath) {
    for (let isIgnored of this.ignoredPatterns) {
      if (isIgnored(filePath)) {
        return true;
      }
    }

    return false;
  }
};
