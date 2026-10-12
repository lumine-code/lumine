const KeymapManager = require("./keymap-manager");
const { KeyBinding } = require("./key-binding");
const { normalizeKeystrokes } = require("./keymap-helpers");
const commands = require("./pane-item-command-definitions");

const ALLOWED_COMMANDS = new Set(Object.keys(commands));

class NativeKeymap extends KeymapManager {
  constructor(broker) {
    super({ documentContext: { body: {} } });
    this.broker = broker;
    this.onDidFailToMatchBinding(() => {
      if (this.currentEvent?.type === "keyup" && this.currentEvent.defaultPrevented)
        this.broker.replayEvent(this.currentEvent);
    });
  }

  findMatchCandidates(keystrokes, disabled) {
    const result = super.findMatchCandidates(keystrokes, disabled);
    const allowedPotential = [
      ...result.partialMatchCandidates,
      ...result.exactMatchCandidates,
    ].some((binding) => ALLOWED_COMMANDS.has(binding.command));
    if (!allowedPotential) result.partialMatchCandidates = [];
    result.pendingKeyupMatchCandidates = result.pendingKeyupMatchCandidates.filter((binding) =>
      ALLOWED_COMMANDS.has(binding.command),
    );
    return result;
  }

  findPartialMatches(candidates) {
    const unset = new Set(
      candidates
        .filter((binding) => binding.command === "unset!")
        .map((binding) => binding.keystrokes),
    );
    return candidates
      .filter((binding) => !unset.has(binding.keystrokes))
      .sort((left, right) => right.keystrokeCount - left.keystrokeCount);
  }

  findExactMatches(candidates, target) {
    this.currentCandidates = candidates
      .filter((binding) => binding.depth === target.depth)
      .sort((left, right) => left.rank - right.rank);
    return this.currentCandidates;
  }

  handleKeyboardEvent(event, options) {
    const previous = this.currentEvent;
    this.currentEvent = event;
    try {
      return super.handleKeyboardEvent(event, options);
    } finally {
      this.currentEvent = previous;
    }
  }

  dispatchCommandEvent(command, _target, event) {
    if (!this.broker.snapshot?.enabled) return false;
    if (!ALLOWED_COMMANDS.has(command)) {
      for (const queued of this.queuedKeyboardEvents) {
        if (queued.defaultPrevented) this.broker.replayEvent(queued);
      }
      return true;
    }
    event.preventDefault();
    const binding = this.currentCandidates.find((candidate) => candidate.command === command);
    this.broker.dispatch({
      hostId: this.broker.snapshot.hostId,
      revision: this.broker.snapshot.revision,
      command,
      bindingRank: binding.rank,
      input: event.nativeInput,
      keystrokes: this.queuedKeystrokes.join(" "),
    });
    return true;
  }

  simulateTextInput(event) {
    this.broker.replayEvent(event);
  }
}

class EmbeddedPaneKeymapBroker {
  constructor({ dispatch = () => {}, replay = () => {} } = {}) {
    this.dispatch = dispatch;
    this.replay = replay;
    this.manager = new NativeKeymap(this);
    this.snapshot = null;
  }

  setSnapshot(snapshot) {
    if (!snapshot) {
      this.clear();
      return true;
    }
    if (
      typeof snapshot.hostId !== "string" ||
      !snapshot.hostId ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      typeof snapshot.enabled !== "boolean" ||
      !Array.isArray(snapshot.bindings) ||
      snapshot.bindings.length > 10000 ||
      !Number.isFinite(snapshot.partialMatchTimeout) ||
      snapshot.partialMatchTimeout < 0
    )
      return false;
    const bindings = [];
    for (const entry of snapshot.bindings) {
      if (
        typeof entry.command !== "string" ||
        !entry.command ||
        typeof entry.keystrokes !== "string" ||
        normalizeKeystrokes(entry.keystrokes) !== entry.keystrokes ||
        !Number.isSafeInteger(entry.depth) ||
        entry.depth < 0 ||
        entry.depth > 256 ||
        !Number.isSafeInteger(entry.rank) ||
        entry.rank < 0
      )
        return false;
      const binding = new KeyBinding(
        "embedded-pane",
        entry.command === "abort!" ? "native!" : entry.command,
        entry.keystrokes,
        "*",
        0,
      );
      binding.depth = entry.depth;
      binding.rank = entry.rank;
      bindings.push(binding);
    }
    this.clear();
    this.snapshot = { ...snapshot, bindings: snapshot.bindings.map((entry) => ({ ...entry })) };
    this.manager.keyBindings = bindings;
    this.manager.partialMatchTimeout = snapshot.partialMatchTimeout;
    let parent = null;
    const deepest = Math.max(0, ...bindings.map((binding) => binding.depth));
    for (let depth = deepest; depth >= 0; depth--) parent = { depth, parentElement: parent };
    this.target = parent;
    return true;
  }

  handleInput(input) {
    if (
      !this.snapshot?.enabled ||
      !["keyDown", "keyUp"].includes(input?.type) ||
      typeof input.key !== "string" ||
      input.isComposing
    )
      return false;
    if (input.key === "AltGraph") this.altGraph = input.type === "keyDown";
    const nativeInput = { ...input, modifiers: [...(input.modifiers || [])] };
    const event = {
      type: input.type === "keyDown" ? "keydown" : "keyup",
      key: input.key,
      code: input.code,
      location: input.location || 0,
      repeat: !!input.isAutoRepeat,
      isComposing: false,
      ctrlKey: !!input.control,
      shiftKey: !!input.shift,
      altKey: !!input.alt,
      metaKey: !!input.meta,
      getModifierState: (name) => {
        if (name === "AltGraph") return !!this.altGraph;
        return nativeInput.modifiers.some(
          (modifier) => modifier.toLowerCase() === name.toLowerCase(),
        );
      },
      nativeInput,
      target: this.target,
      defaultPrevented: false,
      preventDefault() {
        if (this.type === "keydown" || this.captureKeyup) this.defaultPrevented = true;
      },
    };
    if (event.type === "keyup") {
      const keystroke = this.manager.keystrokeForKeyboardEvent(event);
      event.captureKeyup =
        this.manager.pendingKeyupMatcher.canMatchForTarget(keystroke, this.target) ||
        this.manager.keyBindings.some(
          (binding) =>
            ALLOWED_COMMANDS.has(binding.command) &&
            binding.getKeyups()?.includes(keystroke) &&
            binding.matchesKeystrokes([...this.manager.queuedKeystrokes, keystroke]) !== false,
        );
    }
    this.manager.handleKeyboardEvent(event);
    return event.defaultPrevented;
  }

  replayEvent(event) {
    if (event.replayed || !this.snapshot?.enabled) return;
    event.replayed = true;
    this.replay(event.nativeInput);
  }

  clear() {
    this.manager.cancelPendingState();
    this.manager.clearQueuedKeystrokes();
    this.manager.pendingKeyupMatcher.clear();
    this.manager.keyBindings = [];
    this.snapshot = null;
    this.altGraph = false;
  }

  dispose() {
    this.clear();
    this.manager.destroy();
  }
}

module.exports = EmbeddedPaneKeymapBroker;
module.exports.ALLOWED_COMMANDS = ALLOWED_COMMANDS;
