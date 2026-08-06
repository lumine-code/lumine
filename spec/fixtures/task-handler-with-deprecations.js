const { deprecate } = require("@lumine-code/grim");

// Called rather than deprecating at module scope: the spec asserts the second
// stack frame names this file, and at module scope that frame is the CommonJS
// loader that required it.
function reportDeprecation() {
  deprecate("Fake task deprecation");
}

reportDeprecation();

module.exports = function () {};
