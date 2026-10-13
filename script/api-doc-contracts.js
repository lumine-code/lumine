"use strict";

function categoryAnchor(category) {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateDocumentationContracts(api) {
  const failures = [];
  const validateCallable = (entry, context) => {
    if (!entry.summary?.trim()) failures.push(`${context}: missing method description`);
    const parameters = new Set();
    for (const parameter of entry.parameters || []) {
      if (!parameter.name) failures.push(`${context}: unnamed parameter needs a documented name`);
      if (!parameter.type?.trim()) {
        failures.push(`${context}: parameter ${parameter.name || parameter.source} needs a type`);
      }
      if (parameters.has(parameter.name)) {
        failures.push(`${context}: duplicate parameter ${parameter.name}`);
      }
      parameters.add(parameter.name);
    }
    if (entry.async && !/^Promise(?:<|$)/.test(entry.returnType || "")) {
      failures.push(`${context}: async method needs a Promise return type`);
    }
  };

  for (const type of [...api.classes, ...(api.objects || [])]) {
    const anchors = new Map();
    for (const member of type.members) {
      const context = `${type.name}${member.static ? "." : "#"}${member.name}`;
      const category = member.category || "";
      if (!category.trim() || category !== category.trim() || /[\r\n]/.test(category)) {
        failures.push(`${context}: category must be one nonempty line`);
      }
      const anchor = categoryAnchor(category);
      if (!anchor || (anchors.has(anchor) && anchors.get(anchor) !== category)) {
        failures.push(`${context}: category has an empty or duplicate navigation anchor`);
      }
      anchors.set(anchor, category);
      if (member.kind === "property") {
        if (!member.propertyType?.trim()) failures.push(`${context}: property needs a type`);
      } else {
        validateCallable(member, context);
      }
    }
  }
  for (const fn of api.functions || []) validateCallable(fn, fn.accessPath || fn.name);

  if (failures.length) {
    throw new Error(`Incomplete API documentation:\n${failures.join("\n")}`);
  }
}

module.exports = { validateDocumentationContracts };
