"use strict";

function validateDocumentationExamples(api, parser) {
  const failures = [];
  for (const entry of [...api.classes, ...(api.objects || []), ...api.functions]) {
    for (const owner of [entry, ...(entry.members || [])]) {
      const descriptions = [
        owner.description,
        owner.returnDescription,
        ...(owner.parameters || []).map((parameter) => parameter.description),
        ...(owner.throws || []).map((error) => error.description),
      ];
      for (const description of descriptions) {
        let fence = null;
        for (const line of (description || "").split(/\r?\n/)) {
          const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
          if (!marker) continue;
          if (!fence) {
            fence = marker[1];
          } else if (
            marker[1][0] === fence[0] &&
            marker[1].length >= fence.length &&
            !marker[2].trim()
          ) {
            fence = null;
          }
        }
        if (fence) {
          const context = owner === entry ? entry.name : `${entry.name}#${owner.name}`;
          failures.push(`${entry.sourcePath}:${owner.line}: ${context}: unclosed code fence`);
        }
        for (const example of (description || "").matchAll(
          /```(js|javascript|json)[ \t]*\r?\n([\s\S]*?)```/g,
        )) {
          try {
            if (example[1] === "json") {
              JSON.parse(example[2]);
            } else {
              parser.parse(example[2], {
                sourceType: "unambiguous",
                allowReturnOutsideFunction: true,
                allowAwaitOutsideFunction: true,
              });
            }
          } catch (error) {
            const context = owner === entry ? entry.name : `${entry.name}#${owner.name}`;
            failures.push(`${entry.sourcePath}:${owner.line}: ${context}: ${error.message}`);
          }
        }
      }
    }
  }
  if (failures.length) {
    throw new Error(`Invalid API documentation examples:\n${failures.join("\n")}`);
  }
}

module.exports = { validateDocumentationExamples };
