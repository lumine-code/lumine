// Diagnostic CPU capture only; inspector overhead excludes these runs from
// accepted latency measurements. No runtime methods are replaced or wrapped.
// LUMINE_SYNTAX_INPUT_PROFILE_CONFIG={"caseIds":[...],"cycles":10,"mode":"burst","output":"..."}
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const dispatch = require("../src/text-editor-input-queue");
const { definitions, fixture, hash, burstStates } = require("./helpers/multicursor-input-fixture");
const config = JSON.parse(process.env.LUMINE_SYNTAX_INPUT_PROFILE_CONFIG || "{}");
const caseIds = config.caseIds ?? [
  "ipython-500-quoted-chain-129",
  "python-500-root-policy-chain-129",
  "python-500-chain-2",
  "ipython-500-chain-2",
];
const cycles = config.cycles ?? 10;
const mode = config.mode ?? "burst";
const maxDurationMs = config.maxDurationMs ?? 120000;
const output = path.resolve(
  config.output ?? path.join(__dirname, "..", ".dev", "syntax-input-profile"),
);
const analysisModule = path.join(__dirname, "helpers", "syntax-input-profiler.js");
assert.ok(Array.isArray(caseIds) && caseIds.length > 0);
assert.ok(Number.isSafeInteger(cycles) && cycles > 0);
assert.ok(["newline", "burst"].includes(mode));
for (const id of caseIds)
  assert.ok(
    definitions.some((entry) => entry.id === id),
    id,
  );

describe("Syntax input CPU diagnostics", () => {
  let editor;
  let previousExecution;

  beforeEach(async () => {
    jasmine.useRealClock();
    previousExecution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "worker";
    await lumine.packages.activatePackage("language-python");
    await lumine.packages.activatePackage("language-ipython");
    const workspace = lumine.views.getView(lumine.workspace);
    workspace.style.width = "1000px";
    workspace.style.height = "800px";
    jasmine.attachToDOM(workspace);
  });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    lumine.grammars.syntaxExecution = previousExecution;
  });

  for (const id of caseIds) {
    it(
      `captures ${id} ${mode}`,
      async () => {
        const input = fixture(definitions.find((entry) => entry.id === id));
        const plan =
          mode === "burst"
            ? burstStates(input, cycles)
            : {
                typingText: "",
                states: [{ operation: "enter" }],
                final: { text: input.expected, positions: input.expectedPositions },
                publications: 1,
              };
        const report = {
          diagnosticOnly: true,
          timingsNotAcceptance: true,
          id,
          mode,
          cycles: mode === "burst" ? cycles : 1,
          source: input.metadata,
          capturedAt: new Date().toISOString(),
        };
        fs.mkdirSync(output, { recursive: true });
        const basename = path.join(output, `${id}-${mode}`);
        let token;
        let stopped = false;
        let publications = 0;
        let subscription;
        try {
          editor = await lumine.workspace.open();
          editor.setText(input.source);
          if (input.rootRanges)
            lumine.grammars.setRootLanguageRanges(editor.getBuffer(), input.rootRanges);
          assert.equal(
            lumine.grammars.assignLanguageMode(editor.getBuffer(), input.metadata.grammarScope),
            true,
          );
          await editor.whenGrammarSettled();
          const languageMode = editor.getBuffer().getLanguageMode();
          assert.equal(
            languageMode.asynchronousSyntax,
            true,
            "CPU capture requires the actual worker backend",
          );
          report.languageMode = languageMode.constructor.name;
          editor.update({
            autoIndent: true,
            tabLength: 4,
            softTabs: true,
            undoGroupingInterval: 0,
          });
          editor.setSelectedBufferRanges(input.points.map((point) => [point, point]));
          editor.getElement().component.updateSync();
          await new Promise(requestAnimationFrame);
          editor.getBuffer().clearUndoStack();
          const started = await editor.analyzeSyntax(analysisModule, "start", {
            label: `${id}-${mode}`,
            intervalMicros: config.intervalMicros ?? 1000,
            maxDurationMs,
          });
          report.start = started;
          assert.equal(started.supported, true, JSON.stringify(started));
          token = started.token;
          const inputStarted = performance.now();
          report.publicationMs = [];
          subscription = editor.getBuffer().onDidApplyChanges(() => {
            publications++;
            report.publicationMs.push(performance.now() - inputStarted);
          });
          const tasks = [];
          for (const state of plan.states) {
            const task = Promise.resolve(
              dispatch(editor, () => {
                if (state.operation === "enter") return editor.insertNewline();
                if (state.operation === "text") return editor.insertText(plan.typingText);
                return editor.backspace();
              }),
            );
            task.catch(() => {});
            tasks.push(task);
          }
          const outcomes = await Promise.all(tasks);
          report.commandMs = performance.now() - inputStarted;
          await editor.whenGrammarSettled();
          report.grammarSettledMs = performance.now() - inputStarted;
          const result = await editor.analyzeSyntax(analysisModule, "stop", { token });
          stopped = true;
          if (result.cpuProfile)
            fs.writeFileSync(`${basename}.cpuprofile`, JSON.stringify(result.cpuProfile));
          const { cpuProfile: _cpuProfile, ...diagnostics } = result;
          report.profile = diagnostics;
          report.cpuProfileFile = result.cpuProfile ? `${basename}.cpuprofile` : null;
          report.publications = publications;
          report.cancelled = outcomes.filter((outcome) => outcome === false).length;
          report.outputHash = hash(editor.getText());
          report.expectedHash = hash(plan.final.text);
          report.positions = editor.getCursorBufferPositions().map((point) => point.serialize());
          assert.equal(result.expired, false, "CPU watchdog expired before the input completed");
          assert.equal(report.cancelled, 0);
          assert.equal(publications, plan.publications);
          assert.equal(report.outputHash, report.expectedHash);
          assert.deepEqual(report.positions, plan.final.positions);
          report.correct = true;
        } catch (error) {
          report.error = { name: error.name, message: error.message, stack: error.stack };
          throw error;
        } finally {
          subscription?.dispose();
          if (token && !stopped) {
            try {
              const result = await editor.analyzeSyntax(analysisModule, "stop", { token });
              if (result.cpuProfile)
                fs.writeFileSync(`${basename}.cpuprofile`, JSON.stringify(result.cpuProfile));
            } catch (error) {
              report.stopError = { name: error.name, message: error.message };
            }
          }
          fs.writeFileSync(`${basename}.json`, JSON.stringify(report, null, 2) + "\n");
        }
      },
      maxDurationMs + 30000,
    );
  }
});
