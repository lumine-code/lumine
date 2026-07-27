const C = require("./converters");

// LSP DiagnosticSeverity and DiagnosticTag. The numbering stops here: the
// linter contract takes semantic strings, the same way it takes "error" rather
// than 1.
const SEVERITIES = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

const TAGS = {
  1: "unnecessary",
  2: "deprecated",
};

// LSP leaves an omitted severity to the client. Treat it as an error: a server
// that omits the field is not saying "this is minor", and under-reporting a
// real problem is the worse failure. vscode-languageclient does the same, so
// this is what server authors test against.
const DEFAULT_SEVERITY = "error";

exports.toLinterMessages = (uri, diagnostics = []) => {
  const filePath = C.uriToPath(uri);
  if (!filePath) return { filePath: null, messages: [] };
  return {
    filePath,
    messages: diagnostics.map((diagnostic) => {
      const sourceAndCode = [diagnostic.source, diagnostic.code]
        .filter((part) => part !== undefined && part !== null && part !== "")
        .join(": ");
      const related = (diagnostic.relatedInformation || [])
        .map((item) => `${item.location.uri}: ${item.message}`)
        .join("\n");
      // One expression covers all three edge cases: an absent list, an empty
      // one, and a tag number a future protocol version adds.
      const tags = diagnostic.tags?.map((tag) => TAGS[tag]).filter(Boolean);
      return {
        // `??`, not `||`: only an absent or unrecognized severity takes the
        // default, and it does not depend on "" or 0 never appearing.
        severity: SEVERITIES[diagnostic.severity] ?? DEFAULT_SEVERITY,
        tags: tags?.length ? tags : undefined,
        location: {
          file: filePath,
          position: C.rangeFromLsp(diagnostic.range),
        },
        excerpt: diagnostic.message,
        description: [sourceAndCode, related].filter(Boolean).join("\n\n") || undefined,
        url: diagnostic.codeDescription?.href,
        lspDiagnostic: diagnostic,
      };
    }),
  };
};
