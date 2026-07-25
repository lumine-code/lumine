const C = require("./converters");

const SEVERITIES = {
  1: "error",
  2: "warning",
  3: "info",
  4: "info",
};

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
      return {
        severity: SEVERITIES[diagnostic.severity] || "info",
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
