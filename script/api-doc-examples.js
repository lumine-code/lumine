"use strict";

function validateDocumentationExamples(api, parser) {
  const failures = [];
  for (const entry of [...api.classes, ...(api.objects || []), ...api.functions]) {
    for (const owner of [entry, ...(entry.members || [])]) {
      const descriptions = [
        owner.description,
        owner.returnDescription,
        ...(owner.parameters || []).map((parameter) => parameter.description),
      ];
      for (const description of descriptions) {
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
