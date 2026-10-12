module.exports = class PartialKeyupMatcher {
  constructor() {
    this._pendingMatches = new Set();
    this._targets = new WeakMap();
  }

  addPendingMatch(keyBinding, target) {
    this._pendingMatches.add(keyBinding);
    this._targets.set(keyBinding, target ? new WeakRef(target) : null);
    keyBinding["nextKeyUpIndex"] = 0;
  }

  canMatchForTarget(keystroke, target) {
    keystroke = this._normalizeKeystroke(keystroke);
    for (const binding of this._pendingMatches) {
      if (
        this._targets.get(binding)?.deref() === target &&
        this._normalizeKeystroke(binding.getKeyups()[binding["nextKeyUpIndex"]]) === keystroke
      )
        return true;
    }
    return false;
  }

  clear() {
    this._pendingMatches.clear();
    this._targets = new WeakMap();
  }

  // Returns matching bindingss, if any.
  // Updates state for next match.
  getMatches(userKeyupKeystroke) {
    userKeyupKeystroke = this._normalizeKeystroke(userKeyupKeystroke);
    let matches = new Set();

    // Loop over each pending keyup match.
    for (const keyBinding of this._pendingMatches) {
      const bindingKeystrokeToMatch = this._normalizeKeystroke(
        keyBinding.getKeyups()[keyBinding["nextKeyUpIndex"]],
      );
      if (userKeyupKeystroke === bindingKeystrokeToMatch) {
        this._updateStateForMatch(matches, keyBinding);
      }
    }
    return [...matches];
  }

  /* Private section */

  _normalizeKeystroke(keystroke) {
    if (keystroke[0] === "^") return keystroke.substring(1);
    return keystroke;
  }

  _updateStateForMatch(matches, keyBinding) {
    if (keyBinding["nextKeyUpIndex"] === keyBinding.getKeyups().length - 1) {
      // Full match. Remove and return it.
      this._pendingMatches.delete(keyBinding);
      this._targets.delete(keyBinding);
      matches.add(keyBinding);
    } else {
      // Partial match. Increment what we're looking for next.
      keyBinding["nextKeyUpIndex"]++;
    }
  }
};
