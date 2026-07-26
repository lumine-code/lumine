const C = require("./converters");

const INTENTIONS_CAPABILITIES = {
  textDocument: {
    codeAction: {
      dynamicRegistration: true,
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "",
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
            "source.fixAll",
          ],
        },
      },
      resolveSupport: { properties: ["edit", "command"] },
    },
  },
};

module.exports = class IntentionsProvider {
  static capabilities = INTENTIONS_CAPABILITIES;
  constructor(manager) {
    this.manager = manager;
    manager.addCapabilityFragment(INTENTIONS_CAPABILITIES);
  }
  get grammarScopes() {
    return this.manager.allGrammarScopes();
  }
  // Code actions are requested on demand at the cursor; the published
  // diagnostics overlapping that position provide the context.
  async getIntentions({ textEditor, bufferPosition }) {
    const session = await this.manager.activeSessionForEditor(textEditor);
    if (!session?.supports("textDocument/codeAction", textEditor)) return [];
    const uri = C.pathToUri(textEditor.getPath());
    const stored = this.manager.diagnostics.get(uri);
    const diagnostics = (stored?.diagnostics || []).filter((diagnostic) =>
      this.rangeContains(diagnostic.range, bufferPosition),
    );
    const position = C.pointToPosition(bufferPosition);
    const range = diagnostics.length
      ? this.unionRange(diagnostics)
      : { start: position, end: position };
    let actions;
    try {
      actions = await session.request("textDocument/codeAction", {
        textDocument: { uri },
        range,
        context: { diagnostics, triggerKind: 1 },
      });
    } catch {
      return [];
    }
    return (actions || [])
      .filter((action) => !action.disabled)
      .map((action) => this.toIntention(session, action));
  }
  rangeContains(range, point) {
    if (point.row < range.start.line || point.row > range.end.line) return false;
    if (point.row === range.start.line && point.column < range.start.character) return false;
    if (point.row === range.end.line && point.column > range.end.character) return false;
    return true;
  }
  unionRange(diagnostics) {
    const earlier = (a, b) => (a.line !== b.line ? a.line < b.line : a.character < b.character);
    let start = diagnostics[0].range.start;
    let end = diagnostics[0].range.end;
    for (const { range } of diagnostics.slice(1)) {
      if (earlier(range.start, start)) start = range.start;
      if (earlier(end, range.end)) end = range.end;
    }
    return { start, end };
  }
  toIntention(session, action) {
    const kind = action.kind || "";
    const priority = action.isPreferred
      ? 100
      : kind.startsWith("quickfix")
        ? 80
        : kind.startsWith("refactor")
          ? 60
          : 40;
    return {
      icon: kind.startsWith("quickfix") ? "zap" : "tools",
      title: action.title,
      priority,
      selected: () => this.applyAction(session, action),
    };
  }
  async applyAction(session, action) {
    // A bare Command carries its command as a string.
    if (typeof action.command === "string")
      return session.request("workspace/executeCommand", {
        command: action.command,
        arguments: action.arguments,
      });
    let resolved = action;
    if (
      !action.edit &&
      !action.command &&
      session.capabilities.codeActionProvider?.resolveProvider
    ) {
      try {
        resolved = await session.request("codeAction/resolve", action);
      } catch {
        resolved = action;
      }
    }
    if (resolved.edit) await this.manager.applyWorkspaceEdit(resolved.edit, resolved.title);
    if (resolved.command)
      await session.request("workspace/executeCommand", {
        command: resolved.command.command,
        arguments: resolved.command.arguments,
      });
  }
};
