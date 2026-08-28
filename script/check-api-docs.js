"use strict";

const fs = require("node:fs");
const path = require("node:path");
const parser = require("@babel/parser");
const { apiSourceFiles, extractApi } = require("./api-extractor");

const editorRoot = path.resolve(__dirname, "..");
const primitiveReferences = [
  "Array",
  "Boolean",
  "Buffer",
  "Error",
  "Function",
  "Map",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "Uint8Array",
];

function withoutMarkdownCode(markdown) {
  return markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").replace(/`[^`\n]*`/g, "");
}

function proseFromComment(value) {
  return withoutMarkdownCode(
    value
      .split(/\r?\n/)
      .map((line) => line.replace(/(@(?:param|returns?|type)\s+)\{[^}\n]+\}/, "$1"))
      .join("\n"),
  );
}

function checkDocumentationSyntax(api) {
  const referenceNames = [...primitiveReferences, ...api.classes.map(({ name }) => name)]
    .sort((left, right) => right.length - left.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const legacyReference = new RegExp(`\\{(?:::[$\\w]+|[$\\w]+::[$\\w]+|(?:${referenceNames}))\\}`);
  const failures = [];

  for (const filePath of apiSourceFiles(editorRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    let ast;
    try {
      ast = parser.parse(source, {
        sourceType: "unambiguous",
        errorRecovery: true,
        plugins: [
          "classProperties",
          "classPrivateProperties",
          "classPrivateMethods",
          "classStaticBlock",
          "jsx",
          "objectRestSpread",
          "optionalChaining",
        ],
      });
    } catch (error) {
      failures.push(`${path.relative(editorRoot, filePath)}: ${error.message}`);
      continue;
    }
    for (const comment of ast.comments || []) {
      const prose = proseFromComment(comment.value);
      const tagLines = comment.value
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*?\s?/, "").trim());
      const firstContentIndex = tagLines.findIndex(Boolean);
      const publicIndex = tagLines.indexOf("@public");
      const invalidPublicHeader =
        publicIndex >= 0 &&
        (publicIndex !== firstContentIndex ||
          !/^@status (essential|extended|public|experimental)$/.test(
            tagLines[publicIndex + 1] || "",
          ) ||
          tagLines[publicIndex + 2] !== "");
      const legacyMarker = prose.match(
        /(?:^|\n)\s*\*?\s*(Essential|Extended|Public|Private|Experimental|Section):/,
      );
      const customMarker = prose.match(/(?:^|\n)\s*\*?\s*#\s*(Name|Type):/);
      const legacyLink = prose.match(/\[[^\]]+\]\{[^}\s]+\}/) || prose.match(legacyReference);
      const structuralLink = tagLines.find((line) =>
        /^@(param|returns?|type)\s+\{@link\b/.test(line),
      );
      const legacyApiStatus = tagLines.find((line) =>
        /^@(api-status|apistatus)(?:\s|$)/.test(line),
      );
      const untypedReturn = tagLines.find(
        (line) => /^@returns?(?:\s|$)/.test(line) && !/^@returns?\s+\{[^}]+\}/.test(line),
      );
      const malformedArtifact = prose.match(/(?:^|\n)\s*\*?\s*Returns?:|;\s*\.|\.\s*;/);
      if (
        !legacyMarker &&
        !customMarker &&
        !legacyLink &&
        !structuralLink &&
        !legacyApiStatus &&
        !invalidPublicHeader &&
        !untypedReturn &&
        !malformedArtifact
      ) {
        continue;
      }
      let reason;
      if (legacyMarker) reason = `legacy ${legacyMarker[1]} marker`;
      else if (customMarker) reason = `legacy # ${customMarker[1]} marker`;
      else if (legacyLink) reason = `legacy link ${legacyLink[0]}`;
      else if (structuralLink) reason = "JSDoc link used as a structured type";
      else if (legacyApiStatus)
        reason = `legacy ${legacyApiStatus.split(/\s/, 1)[0]} tag; use @status`;
      else if (invalidPublicHeader)
        reason =
          "public JSDoc must start with @public, then a lowercase @status value, then a blank line";
      else if (untypedReturn) reason = "return tag without a structured type";
      else reason = `malformed documentation artifact ${malformedArtifact[0].trim()}`;
      failures.push(`${path.relative(editorRoot, filePath)}:${comment.loc.start.line}: ${reason}`);
    }
  }

  if (failures.length) {
    throw new Error(`Invalid API documentation remains:\n${failures.join("\n")}`);
  }
}

const api = extractApi({ editorRoot, parser });
checkDocumentationSyntax(api);
console.log(
  `API documentation is valid: ${api.classes.length} classes, ${api.memberCount} members, ${api.functions.length} functions`,
);
